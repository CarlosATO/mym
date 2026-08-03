# Autorización Operativa - Inventory Engine Fase 4F

## Resultado de 4F.0

- 32 firmas finales
- 22 RPCs operativas
- 10 helpers internos
- 0 overloads
- 0 aliases
- Superficie segura para exposición

## Reconciliación definitiva (4F.2-H1)

La cifra de 23 RPCs / 33 firmas informada en 4F.0 fue un error documental. La matriz
conceptual 4E original listaba nombres de un diseño previo (`create_inventory_session`,
`create_count_entry`, `reject_inventory_session`, `bulk_insert_count_entries`, etc.) que
**nunca fueron implementados** como funciones. El estado físico aplicado es de **32
firmas: 22 RPC operativas + 10 helpers internos**, todos cubiertos por la migración 4E.5
(22 GRANT EXECUTE a authenticated + 10 helpers revocados) y por la matriz de permisos 4F.2
(10 permisos usados por las RPCs). No existe RPC vigente sin grant ni sin permiso asignado.

### Estado de `inventarios.sessions.start`

Permiso reservado creado en 4B.0a; usado solo por la primera versión de
`approve_inventory_session` (04e4), reemplazada por el hotfix que usa
`inventarios.sessions.approve`. Ninguna RPC final lo usa; no fue asignado en 4F.2.
Queda reservado para una futura RPC de inicio de jornada.

### Ciclo de vida de jornada

- Creación → DRAFT: implementada desde 4G.1 (`create_inventory_session` + snapshot temprano).
- Configuración DRAFT (participantes, zonas, ubicaciones, tareas): implementada desde 4G.1.
- DRAFT → PREPARED: implementada desde 4G.2 (`prepare_inventory_session`); valida configuración,
  construye snapshot_products desde Bsale y congela el snapshot (COMPLETED + content_hash).
- PREPARED → COUNTING: NO implementada.
- COUNTING → UNDER_REVIEW: NO implementada.
- UNDER_REVIEW → APPROVED: implementada (`approve_inventory_session`).
- Cancelación de jornada: NO implementada.

## Separación de autorización

- `portal.permissions` y `portal.role_permissions` controlan acceso general al módulo
- `session_participants.functional_role` controla operaciones contextuales por jornada
- No existe relación FK entre `functional_role` y `portal.roles`
- `require_permission` resuelve mediante `portal.has_permission()` (vía auth.uid())

## Data API

- Schema `inventarios` expuesto via Data API PostgREST desde 4F.1
- `supabase.schema('inventarios').rpc('nombre_rpc', payload)` es el patrón de invocación
- Tablas sin acceso directo (RLS + grants revocados)
- Helpers sin EXECUTE para authenticated

## Arquitectura híbrida (4F.2)

Un usuario puede intentar una operación solo cuando:

1. tiene acceso activo a la empresa (`core.user_company_access` → `require_company_access`);
2. su rol general de portal posee el permiso (`portal.roles` → `portal.role_permissions` → `portal.has_permission`);
3. participa vigentemente en la jornada (`session_participants`);
4. su `functional_role` permite la operación (`require_session_participant`);
5. la entidad está en el estado correcto (validación de negocio).

Ninguna de estas capas sustituye a otra.

## Roles generales del portal (6 físicos)

| Rol | Permisos de Inventarios | Control contextual |
|-----|-------------------------|--------------------|
| `SUPER_USUARIO` | 10 permisos usados por RPC operativas | NO elimina controles contextuales |
| `BODEGA` | 9 permisos operativos (excluye sessions.approve) | COUNTER / SUPERVISOR / ADMINISTRATOR |
| `GERENCIA` | `inventarios.sessions.approve` únicamente | MANAGER |
| `CONSULTA_DE_BODEGA` | Ninguno | — |
| `FINANZAS` | Ninguno | — |
| `VENDEDOR` | Ninguno | — |

## Permisos de Inventarios asignados (10)

| Permission code | BODEGA | GERENCIA | SUPER_USUARIO |
|-----------------|--------|----------|---------------|
| `inventarios.tasks.assign` | 🟢 | 🔴 | 🟢 |
| `inventarios.tasks.execute` | 🟢 | 🔴 | 🟢 |
| `inventarios.tasks.validate` | 🟢 | 🔴 | 🟢 |
| `inventarios.tasks.cancel` | 🟢 | 🔴 | 🟢 |
| `inventarios.counts.record` | 🟢 | 🔴 | 🟢 |
| `inventarios.counts.correct` | 🟢 | 🔴 | 🟢 |
| `inventarios.incidents.manage` | 🟢 | 🔴 | 🟢 |
| `inventarios.recounts.manage` | 🟢 | 🔴 | 🟢 |
| `inventarios.recounts.decide` | 🟢 | 🔴 | 🟢 |
| `inventarios.sessions.approve` | 🔴 | 🟢 | 🟢 |

- BODEGA no recibe `sessions.approve`.
- GERENCIA no recibe permisos operativos de BODEGA.
- SUPER_USUARIO recibe los 10 permisos mediante asignaciones explícitas, sin herencia.
- Sin roles nuevos, sin user_permissions nuevas, sin asignación directa a usuarios.

## Smoke tests ejecutados (4F.1 y 4F.2)

| Prueba | Resultado |
|--------|-----------|
| Tabla directa anon | PASS (401) |
| RPC approve anon | PASS (401) |
| Helper anon | PASS (401) |
| Tabla authenticated | SKIPPED (sin JWT) |
| Helper authenticated | SKIPPED (sin JWT) |
| Usuario sin permiso | SKIPPED (sin JWT) |
| BODEGA no aprueba | SKIPPED (sin JWT) |
| GERENCIA supera permiso | SKIPPED (sin JWT) |
| SUPER_USUARIO supera permiso | SKIPPED (sin JWT) |

## Limitación documentada

La validación dinámica completa de `functional_role` (permiso válido, sesión existente,
usuario no participante, rol contextual incorrecto) requiere una jornada controlada de
pruebas. No se fabrican jornadas ni participantes en smoke testing. Queda pendiente
hasta disponer de una jornada controlada antes del UI productivo.

## Pendientes generales

- Frontend de inventarios
- App Android de captura
- Exportación oficial a Bsale
- Reconciliación post-carga
