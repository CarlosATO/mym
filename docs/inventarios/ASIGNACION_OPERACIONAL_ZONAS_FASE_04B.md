# Asignacion Operacional de Zonas de Contaje - Fase 04B

## 1. Proposito

Documenta la implementacion del flujo de configuracion operacional de una jornada de
contaje: crear zonas, asignar ubicaciones del alcance a un contador responsable,
visualizar la cobertura y cancelar zonas antes de iniciar el conteo. Incluye los
contratos SQL, las migraciones, la interfaz web, el QA ejecutado y las correcciones
posteriores a la prueba manual.

## 2. Contratos SQL

Ambas funciones son `SECURITY DEFINER`, operan con `SET search_path = pg_catalog`,
protegen las filas con `FOR UPDATE` y `pg_advisory_xact_lock` por jornada, y utilizan
el helper `begin_idempotent_operation` / `complete_idempotent_operation` (replay
soportado con `replayed: true` y respuesta original).

### 2.1 assign_inventory_counting_zone

Firma: `inventarios.assign_inventory_counting_zone(p_company_id uuid, p_campaign_id uuid, p_session_id uuid, p_campaign_participant_id uuid, p_zone_name text, p_location_ids uuid[], p_idempotency_key uuid) RETURNS jsonb`

Flujo:

1. Validacion de formato: nombre no vacio (max 200), al menos una ubicacion, sin
   duplicados en `p_location_ids` (`INV_LOCATION_DUPLICATE`).
2. Permisos: `inventarios.zones.manage`, `inventarios.participants.manage` y
   `inventarios.tasks.assign`; el actor debe ser `ADMINISTRATOR` de la jornada
   (`require_session_participant`).
3. Campana: existe (`INV_CAMPAIGN_NOT_FOUND`), en `DRAFT`
   (`INV_CAMPAIGN_NOT_DRAFT`) y sin preparar (`INV_CAMPAIGN_ALREADY_PREPARED`).
4. Jornada: existe (`INV_SESSION_NOT_FOUND`), pertenece a la campana
   (`INV_SESSION_CAMPAIGN_MISMATCH`), en `DRAFT` (`INV_SESSION_NOT_DRAFT`), con
   bodega interna (`INV_SESSION_EXTERNAL_UNSUPPORTED`) y con snapshot
   (`INV_SNAPSHOT_REQUIRED`).
5. Contador: el `p_campaign_participant_id` debe ser un COUNTER activo de la campana,
   con usuario activo y acceso a la empresa (`INV_COUNTER_NOT_FOUND`). Se reutiliza
   su participante de jornada (`session_participants` COUNTER) o se crea.
6. Ubicaciones: cada una debe estar en el alcance `INCLUDED` de la jornada
   (`INV_LOCATION_NOT_IN_SCOPE`), activa y de la bodega de la jornada
   (`INV_LOCATION_INACTIVE`) y sin pertenecer a otra zona (`INV_LOCATION_ALREADY_ASSIGNED`).
7. Persistencia: `session_zones` (codigo `Z<n>`, escaneable y prioridad), filas en
   `session_zone_locations` (creando `snapshot_locations` si faltan), tarea `PRIMARY`
   en `ASSIGNED` con `version = 1` y `validation_cycle = 1`, y `task_assignments` al
   contador.
8. Envelope: `coverage` con `total` (ubicaciones del alcance activas), `assigned`,
   `pending`, `percent` y `zone_count` (zonas habilitadas de la jornada).

### 2.2 cancel_inventory_counting_zone

Firma: `inventarios.cancel_inventory_counting_zone(p_company_id uuid, p_campaign_id uuid, p_session_id uuid, p_zone_id uuid, p_reason text, p_idempotency_key uuid) RETURNS jsonb`

Flujo:

1. Validaciones de formato, permisos y estados de campana/jornada identicas a la
   asignacion.
2. Zona: debe existir en la jornada y estar habilitada (`INV_ZONE_NOT_FOUND`); su
   tarea vigente debe estar en `ASSIGNED` sin iniciarse (`INV_TASK_NOT_PENDING` para
   `IN_PROGRESS` o posteriores). El cancel doble devuelve `INV_ZONE_NOT_FOUND`.
3. Persistencia: `session_zones.is_enabled = false`; `task_assignments` con
   `released_at`; la tarea **conserva su estado** (`ASSIGNED`) y registra
   `cancelled_at` / `cancelled_by` (la constraint `chk_inventarios_tasks_status` no
   admite `CANCELLED`); evento `CANCELLED` en `task_events` cuyo envelope reporta el
   estado previo (mismo patron que `cancel_inventory_task`).
4. Envelope: `coverage` recalculado sin la zona cancelada.

## 3. Migraciones

| Migracion | Contenido |
| --- | --- |
| `20260806112000_inventarios_counting_zone_assignment.sql` | Implementacion original: funciones assign/cancel, ayuda de helpers y grants. |
| `20260806121000_inventarios_counting_zone_assignment_fix.sql` | Fix aplicado tras QA 1: la tarea PRIMARY nace con `validation_cycle = 1` (la constraint exige `> 0`) y el cancel conserva el estado de la tarea. Redefine ambas funciones. |
| `20260806122000_inventarios_counting_zone_reassign_fix.sql` | Fix aplicado tras prueba manual: `zone_code` y `priority` se derivan del total de filas de la jornada (incluidas las canceladas, ya que las filas nunca se borran y `uq_inventarios_zones_code` es UNIQUE sin filtro de estado); `coverage.zone_count` solo cuenta las habilitadas. Redefine `assign_inventory_counting_zone`. |

Los archivos locales de `20260806112000` y `20260806121000` fueron editados para
mantener consistencia con el estado aplicado en remoto.

## 4. Interfaz web

- `src/app/actions/inventarios/counting-zones.ts`: acciones server
  `assignInventoryCountingZone`, `cancelInventoryCountingZone` y
  `listInventorySessionScopes` (tipos `InventorySessionScopeLocation`,
  `InventorySessionScopesResult`, `InventoryCountingZoneCoverage`).
- `src/modules/inventarios/components/inventory-operational-setup.tsx`: orquestador.
  Muestra la barra de cobertura, el selector de contador, el nombre de la zona, el
  mapa de ubicaciones y el boton de creacion. Recarga alcance + setup + participantes
  tras cada operacion.
- `src/modules/inventarios/components/inventory-zone-location-picker.tsx`: selector
  visual de ubicaciones. Dibuja el pasillo como una card por pasillo con una tabla de
  Racks (columnas) x Niveles (filas descendentes) y tiles por posicion, replicando el
  mapa de ubicaciones de Logistica (`warehouse-map-view.tsx` / `location-tile.tsx`).
  Estados del tile: pendiente (borde, clickable), seleccionada (anillo acento + check),
  asignada (azul cielo con nombre de zona, no clickable). Soporta seleccion individual,
  por pasillo y global, y limpieza.
- `src/modules/inventarios/components/inventory-zone-assignments-list.tsx`: lista de
  zonas habilitadas con su contador y dialogo de cancelacion.
- `src/modules/inventarios/components/inventory-zones-panel.tsx`: delega en
  `InventoryOperationalSetup` cuando la jornada tiene campana (via
  `getInventorySessionImportContext`); fuera de `DRAFT` el formulario queda en solo
  lectura. Conserva el panel simple como fallback.

## 5. QA ejecutado

Cobertura verificada con `ROLLBACK` via Management API (actor simulando al
ADMINISTRATOR de la jornada): asignacion con cobertura correcta (3/16), idempotencia
y `INV_IDEMPOTENCY_CONFLICT`, validaciones (`INV_COUNTER_NOT_FOUND`,
`INV_LOCATION_DUPLICATE`, `INV_LOCATION_NOT_IN_SCOPE`, `INV_NOT_FOUND` para actor sin
permisos), cancel con evento y `version = 2`, bloqueos (tarea iniciada, cancel doble,
campana preparada) y listado de alcance. Tras el fix de reasignacion se verifico el
ciclo crear -> cancelar -> crear: la segunda zona obtiene el siguiente codigo sin
chocar la constraint `uq_inventarios_zones_code` (antes fallaba con 23505 al
reutilizar `Z1`).

## 6. Notas operativas

- La jornada debe estar en `DRAFT`; el snapshot operativo debe existir (se crea con
  la jornada).
- Las zonas canceladas nunca se eliminan: persisten como `is_enabled = false` y
  mantienen su codigo ocupado; los codigos de zonas nuevas son secuenciales sobre el
  total de filas.
- Los datos dejados por la prueba manual de Carlos (participante COUNTER de campana,
  zona `Z1` deshabilitada y tarea cancelada) son datos reales de la empresa de
  desarrollo y no se eliminaron.
