# Diseño Maestro — UI Web del Módulo Inventarios (PetGrup)

Versión: 1.0 — Fase 4H.2A
Estado: `DISEÑO_UI_INVENTARIOS_LISTO_PARA_IMPLEMENTAR`
Módulo piloto del rediseño visual del portal. Inspirado en Bsale, sin copiarlo literalmente.

---

## 1. Objetivos y usuarios

### 1.1 Objetivos

1. Permitir gestionar el ciclo completo de una jornada de inventario desde el navegador:
   crear (DRAFT), preparar (PREPARED), abrir (COUNTING), cerrar (UNDER_REVIEW), aprobar
   (APPROVED) y cancelar (CANCELLED), usando exclusivamente las RPC del backend (sin acceso
   directo a tablas).
2. Convertir Inventarios en el **módulo piloto** del nuevo lenguaje visual del portal:
   fondo gris muy claro, tarjetas blancas, bordes suaves, tipografía oscura y clara, color
   intenso solo para estados/alertas/acciones.
3. Entregar información ejecutiva y densidad equilibrada, con detalle progresivo.
4. No exponer nombres técnicos (`operational_snapshot`, `task_assignment`, UUID) en la UI.

### 1.2 Usuarios y roles

| Rol portal | Uso esperado |
| --- | --- |
| BODEGA | Crear, configurar, abrir, operar, cerrar y revisar jornadas. Operación principal del módulo. |
| SUPER_USUARIO | Todo lo de BODEGA más visibilidad total y acciones de respaldo. |
| GERENCIA | Consultar jornadas y aprobar resultados (`sessions.read` + `sessions.approve`). Sin permisos de configuración. |
| CONSULTA_DE_BODEGA, FINANZAS, VENDEDOR | Sin acceso al módulo (no tienen permisos de inventarios). |

---

## 2. Principios visuales

La dirección visual aprobada es **clara, profesional y consistente con PetGroup**, con
influencia de Bsale en densidad y manejo de estados, sin replicar su marca.

| Principio | Regla |
| --- | --- |
| Fondo general | gris muy claro (`--theme-bg` ≈ oklch 0.94–0.98, hue azulado) |
| Tarjetas | blancas (`--theme-surface` = oklch 1 0 0), bordes `--theme-border` suaves, sombra mínima (`shadow-sm`) |
| Tipografía | oscura y clara (`--theme-text` ≈ oklch 0.20); muted para secundaria |
| Color intenso | solo para estados, alertas y acciones primarias |
| Filtros | compactos, en una sola fila cuando el viewport lo permite |
| Densidad | equilibrada; tablas con filas compactas; detalles en paneles laterales |
| Detalle progresivo | listado → detalle → pestaña específica; nunca todo a la vez |
| Estados | un badge por estado con color semántico consistente (ver tabla 8) |

El tema `[data-theme="light"]` ya existe en `src/app/globals.css` y define estos tokens;
el módulo debe declararlo/heredarlo como base del rediseño.

---

## 3. Layout general

Cada página del módulo sigue esta estructura vertical:

```
┌──────────────────────────────────────────────────────────────┐
│ AppTopbar (global: logo, empresa activa, usuario, módulo)     │
├──────────┬───────────────────────────────────────────────────┤
│ Sidebar  │ Contenido del módulo                               │
│ (contra- │  ┌──────────────────────────────────────────────┐  │
│  íble)   │  │ InventoryPageHeader (título, breadcrumb,     │  │
│          │  │  acción principal)                            │  │
│          │  ├──────────────────────────────────────────────┤  │
│          │  │  Tarjeta(s) de contenido                      │  │
│          │  └──────────────────────────────────────────────┘  │
└──────────┴───────────────────────────────────────────────────┘
```

- El `AppTopbar` existente se reutiliza sin cambios.
- El sidebar es **propio del módulo** (no el sidebar global) y se integra en un
  `InventoryModuleShell`.
- El contenido vive en tarjetas blancas con `rounded-xl`/`rounded-2xl` y `border-theme-border`.

---

## 4. Sidebar contraíble

El sidebar de Inventarios es **propio del módulo y siempre contraíble**.

| Estado | Comportamiento |
| --- | --- |
| Expandido | icono + texto, ancho fijo (≈ 224px) |
| Contraído | solo iconos (≈ 64px) + `tooltip` con el nombre |
| Móvil (< 768px) | panel deslizable (sheet/drawer) sobre el contenido |
| Preferencia | persistir en `localStorage` (`mym.inventory.sidebarCollapsed`) si la arquitectura actual lo permite; fallback a expandido |

### Opciones del sidebar

1. **Resumen** — KPIs y jornadas que requieren atención (`/dashboard/inventarios`).
2. **Jornadas** — listado paginado (`/dashboard/inventarios/jornadas`).
3. **Operación** — jornadas en PREPARED/COUNTING (`/dashboard/inventarios/operacion`).
4. **Revisión** — jornadas en UNDER_REVIEW (`/dashboard/inventarios/revision`).
5. **Resultados** — jornadas APPROVED/EXPORTED/RECONCILED/CANCELLED (`/dashboard/inventarios/resultados`).

Acción superior del sidebar: botón **+ Nueva jornada** → asistente.

**No** se muestra "Configuración" hasta que existan funciones reales para esa sección.

---

## 5. Mapa de rutas

| Ruta | Pantalla | Roles |
| --- | --- | --- |
| `/dashboard/inventarios` | Resumen (default) | BODEGA, SUPER_USUARIO, GERENCIA |
| `/dashboard/inventarios/jornadas` | Listado de jornadas | BODEGA, SUPER_USUARIO, GERENCIA |
| `/dashboard/inventarios/jornadas/nueva` | Asistente "Nueva jornada" | BODEGA, SUPER_USUARIO |
| `/dashboard/inventarios/jornadas/[id]` | Detalle de jornada | BODEGA, SUPER_USUARIO, GERENCIA |
| `/dashboard/inventarios/operacion` | Operación (PREPARED/COUNTING) | BODEGA, SUPER_USUARIO |
| `/dashboard/inventarios/revision` | Revisión (UNDER_REVIEW) | BODEGA, SUPER_USUARIO, GERENCIA |
| `/dashboard/inventarios/resultados` | Resultados (post-aprobación y canceladas) | BODEGA, SUPER_USUARIO, GERENCIA |

- `/dashboard/inventarios/jornadas/[id]` puede llevar `?tab=` para abrir una pestaña
  específica (patrón ya usado por Logística).
- Rutas desconocidas bajo el módulo → redirigen al Resumen.

---

## 6. Mapa de pantallas

| Pantalla | Pestaña/sidebar | Contenido principal | Estado(s) soportado(s) |
| --- | --- | --- | --- |
| Resumen | Resumen | KPIs, accesos rápidos, atención, actividad | Todos |
| Jornadas | Jornadas | Tabla paginada + filtros | Todos |
| Nueva jornada | (asistente) | Wizard 6 pasos | DRAFT |
| Detalle | Jornadas → click | Cabecera + pestañas | Todos |
| Operación | Operación | Progreso, tareas, zonas, incidentes | PREPARED, COUNTING |
| Revisión | Revisión | Validación, contribuciones, recuentos | UNDER_REVIEW |
| Resultados | Resultados | Resultado oficial, diferencias, exportación | APPROVED, EXPORTED, RECONCILED, CANCELLED |

---

## 7. Comportamiento por estado de jornada

Cada estado define qué pestañas y acciones se muestran en el detalle y qué paneles se
habilitan. Principio: **mostrar solo lo relevante al estado**.

| Estado backend | Etiqueta UI | Acción principal | Pestañas visibles |
| --- | --- | --- | --- |
| DRAFT | Borrador | Continuar configuración | Resumen, Configuración |
| PREPARED | Preparada | Abrir jornada | Resumen, Configuración, Operación |
| COUNTING | En conteo | Ver operación | Resumen, Operación |
| UNDER_REVIEW | En revisión | Revisar | Resumen, Revisión |
| APPROVED | Aprobada | Ver resultados | Resumen, Resultados |
| EXPORTED | Exportada | Ver resultados | Resumen, Resultados |
| RECONCILED | Conciliada | Ver resultados | Resumen, Resultados |
| CANCELLED | Cancelada | Ver motivo | Resumen, Resultados (auditoría de cancelación) |

Reglas transversales:
- La pestaña **Configuración** solo existe en DRAFT/PREPARED (antes de la barrera de
  inmutabilidad).
- La pestaña **Operación** existe en PREPARED (previsualización) y COUNTING.
- La pestaña **Revisión** existe en UNDER_REVIEW.
- La pestaña **Resultados** existe desde APPROVED en adelante y en CANCELLED.
- **Abrir jornada no inicia tareas automáticamente** (el backend `start_inventory_session`
  solo cambia el estado; las tareas se inician individualmente).

---

## 8. Traducción de estados (badge)

| Backend | UI | Color semántico (tema claro) |
| --- | --- | --- |
| DRAFT | Borrador | gris (secondary/outline) |
| PREPARED | Preparada | azul (info) |
| COUNTING | En conteo | ámbar (warning) |
| UNDER_REVIEW | En revisión | violeta (purple) |
| APPROVED | Aprobada | verde (success) |
| EXPORTED | Exportada | verde oscuro |
| RECONCILED | Conciliada | verde profundo |
| CANCELLED | Cancelada | rojo (destructive) |

Los badges se construyen sobre `Badge` + variantes por estado (extender `badgeVariants`
con variantes `info`, `warning`, `success`, `purple` o usar clases `bg-*` del token).

---

## 9. Asistente "Nueva jornada"

Ruta `/dashboard/inventarios/jornadas/nueva`. Layout: indicador de pasos + tarjeta
principal + resumen lateral + botones persistentes.

### 9.1 Pasos

1. **Datos generales** — nombre, tipo (GENERAL/PARTIAL/CYCLIC/CONTROL/RECOUNT), bodega,
   oficina Bsale, responsable, notas. Valida contra `create_inventory_session`.
2. **Alcance** — scope_mode (GENERAL/PARTIAL); en PARTIAL, selección de productos
   (vía catálogo/`session_product_scopes` cuando se implemente el alcance por UI).
3. **Participantes** — agregar/revocar personas con rol funcional
   (COUNTER/SUPERVISOR/ADMINISTRATOR/MANAGER) → `add/revoke_inventory_session_participant`.
4. **Zonas y ubicaciones** — crear zonas (`create_inventory_session_zone`) y asociar
   ubicaciones (`add_inventory_zone_location`).
5. **Tareas y asignaciones** — crear tarea por zona (`create_inventory_task`) con COUNTER.
6. **Revisión y preparación** — resumen de configuración + advertencia de bloqueo +
   botón "Preparar jornada" (`prepare_inventory_session`).

### 9.2 Comportamiento

- **Indicador de pasos**: stepper con los 6 pasos; permite navegar a pasos ya completados.
- **Tarjeta principal**: contenido del paso activo.
- **Resumen lateral**: resumen en vivo de lo configurado hasta el paso actual
  (responsable, participantes por rol, zonas, ubicaciones, tareas).
- **Botones persistentes**: `Anterior` | `Guardar borrador` | `Continuar`.
- **Guardar borrador**: persiste el DRAFT sin preparar (los pasos van escribiendo en la
  sesión vía RPCs); permite salir y reanudar desde el detalle/`get_inventory_session_setup`.
- **Validaciones claras**: por paso, mensajes en línea; no avanzar con errores.
- **Advertencia antes de "Preparar jornada"**: modal de confirmación indicando que la
  configuración quedará **bloqueada** (DRAFT → PREPARED es irreversible) — véase
  `InventoryConfirmDialog`.

---

## 10. Detalle de jornada

Ruta `/dashboard/inventarios/jornadas/[id]`.

### 10.1 Encabezado común (`InventorySessionHeader`)

- número (#), nombre, bodega, badge de estado, responsable, fecha de creación.
- Acción principal según estado (botón único, véase tabla 7).
- Breadcrumb: `Inventarios / Jornadas / #n`.

### 10.2 Pestañas

| Pestaña | Contenido |
| --- | --- |
| Resumen | datos generales, snapshot (estado, hash, fechas), conteos resumidos, incidencias bloqueantes |
| Configuración | participantes, zonas+ubicaciones, tareas+asignaciones (solo DRAFT/PREPARED) |
| Operación | progreso, tareas por estado, zonas, participantes activos, última actividad, incidencias, bloqueos (PREPARED/COUNTING) |
| Revisión | tareas por validar, contribuciones efectivas, incidencias bloqueantes, recuentos, decisiones, motivos que impiden aprobar (UNDER_REVIEW) |
| Historial | línea de tiempo de eventos de la jornada y sus tareas (desde `task_events`) |

Solo se muestran las pestañas relevantes al estado (tabla 7).

---

## 11. Pantallas principales

### 11.1 Resumen (`/dashboard/inventarios`)

- **KPIs clicables** (cada uno navega al listado con el filtro aplicado y explica el dato
  en un tooltip o sub-texto):
  - **Jornadas activas** (PREPARED + COUNTING + UNDER_REVIEW).
  - **Avance de conteo** (% de tareas COMPLETED sobre tareas totales en jornadas COUNTING).
  - **Pendientes de revisión** (UNDER_REVIEW sin aprobar).
  - **Incidencias bloqueantes** (is_blocking en OPEN/UNDER_REVIEW).
- **Accesos rápidos**: Nueva jornada · Continuar jornada · Revisar resultados · Consultar historial.
- **Jornadas que requieren atención**: cards compactas con estado + motivo (por ejemplo,
  "3 tareas por validar", "2 incidentes bloqueantes").
- **Alertas y actividad reciente**: últimos eventos de jornadas/tareas.

Datos: `list_inventory_sessions` (sin paginación amplia, page_size acotado) + agregaciones
derivadas cliente; no inventar acceso directo.

### 11.2 Jornadas (`/dashboard/inventarios/jornadas`)

Tabla paginada (`InventorySessionTable`) con columnas: número, nombre, bodega, estado
(badge), avance (barra), responsable, fecha, acción principal (botón contextual).

**Filtros compactos** (una fila): estado (select), bodega (select), rango de fechas,
texto (input). Se aplican contra `list_inventory_sessions` (status, warehouse_id,
date_from, date_to, search). Paginación inferior con total y `has_more`.

### 11.3 Operación (`/dashboard/inventarios/operacion`)

Selección de jornada en PREPARED/COUNTING + panel `InventoryProgressPanel`:

- barra de progreso global (tareas completadas / total);
- tareas por estado (board compacto `InventoryTaskBoard`);
- zonas y participantes activos;
- última actividad;
- incidencias y bloqueos (`InventoryBlockingAlert`);
- acción "Abrir jornada" (`start_inventory_session`) — solo PREPARED, no inicia tareas.

### 11.4 Revisión (`/dashboard/inventarios/revision`)

Selección de jornada en UNDER_REVIEW + `InventoryReviewPanel`:

- tareas pendientes de validar (validar/invalidar/reabrir);
- contribuciones efectivas;
- incidencias bloqueantes;
- recuentos y decisiones;
- motivos que impiden aprobar (lista de checks);
- botón **Aprobar** habilitado solo cuando `indicators.ready_to_approve === true`
  (`approve_inventory_session`).

### 11.5 Resultados (`/dashboard/inventarios/resultados`)

Para APPROVED/EXPORTED/RECONCILED y CANCELLED:

- resultado oficial (versión, número de tareas, contribuciones, ítems);
- resumen de diferencias;
- estado de exportación y conciliación;
- para CANCELLED: motivo y auditoría de cancelación (`cancelled_at/by`, `cancellation_reason`).

Datos: `get_inventory_session_detail` + `get_inventory_session_review` (para motivos).
La información de versión oficial proviene de `official_versions` vía un contrato de
consulta futura (no inventar acceso directo; ver riesgos).

---

## 12. Componentes reutilizables

### 12.1 Componentes sugeridos (nuevos, dentro del módulo)

| Componente | Responsabilidad |
| --- | --- |
| `InventoryModuleShell` | Layout del módulo: sidebar contraíble + AppTopbar + área de contenido; estado de sidebar |
| `InventorySidebar` | Navegación del módulo (expandido/contraído/tooltip/móvil) + "+ Nueva jornada" |
| `InventoryPageHeader` | Título, breadcrumb, descripción, acción principal |
| `InventoryStatusBadge` | Badge de estado traducido (tabla 8) |
| `InventoryKpiCard` | KPI clicable con título, valor, sub-texto explicativo |
| `InventoryQuickAction` | Acceso rápido con icono y navegación |
| `InventorySessionTable` | Tabla paginada de jornadas con filtros |
| `InventorySessionWizard` | Asistente 6 pasos de creación |
| `InventorySessionHeader` | Encabezado común del detalle |
| `InventoryProgressPanel` | Progreso global y por tarea |
| `InventoryTaskBoard` | Board/lista de tareas por estado |
| `InventoryReviewPanel` | Panel de revisión con motivos que impiden aprobar |
| `InventoryBlockingAlert` | Alerta de incidencia bloqueante |
| `InventoryEmptyState` | Estado vacío (sin jornadas, sin resultados de filtro) |
| `InventoryConfirmDialog` | Diálogo de confirmación destructiva (preparar, aprobar, cancelar) |

### 12.2 Componentes de UI reutilizables del portal

`Card`, `Badge` (+variantes de estado), `Button`, `Input`, `Label`, `Select`/`LocalCombobox`,
`Table`, `Dialog`, `Sheet` (drawer móvil), `DropdownMenu`, `Separator`, `Sonner` (toasts),
`Popover`, `Avatar`. Iconos: `lucide-react` (patrón ya usado).

**Nota**: no existe aún `Skeleton` en `src/components/ui`; se puede añadir como
componente del módulo o posponer los skeletons (ver riesgos).

---

## 13. Responsive

| Breakpoint | Comportamiento |
| --- | --- |
| ≥ lg (1024px) | Sidebar expandido/contraído a elección; contenido en 2–4 columnas en Resumen |
| md (768–1023px) | Sidebar contraído por defecto; tabla con scroll horizontal |
| < md (móvil) | Sidebar como drawer (Sheet); filtros colapsables; KPIs 2×2; tablas con tarjetas por fila o scroll |

Reglas: el sidebar ocupa ancho fijo en desktop; en móvil se superpone. Las tablas amplias
usan `overflow-x-auto` (patrón de `Table` existente). El asistente apila pasos en una
columna y mueve el resumen lateral debajo.

---

## 14. Accesibilidad

- Navegación por teclado en sidebar (focus visible, tooltips accesibles).
- Badges con texto real (no solo color) para estados.
- Contraste AA en tema claro (tokens definidos).
- Diálogos de confirmación con `aria-describedby` y foco inicial.
- Formularios con labels asociadas; mensajes de error `aria-live`.
- Tabla con `aria-sort` en columnas ordenables y caption resumido.
- Reducción de movimiento respetada (animaciones solo opcionales).

---

## 15. Permisos por rol (UI)

| Acción/área | BODEGA | SUPER_USUARIO | GERENCIA |
| --- | --- | --- | --- |
| Ver resumen/listado/detalle/resultados | ✓ | ✓ | ✓ |
| Crear/configurar jornada (wizard) | ✓ | ✓ | ✗ |
| Preparar, abrir, cerrar, cancelar | ✓ | ✓ | ✗ |
| Operar tareas y conteos | ✓ | ✓ | ✗ |
| Revisar y validar | ✓ | ✓ | ✗ (puede ver revisión) |
| Aprobar | ✗ | ✓ | ✓ |

El frontend debe ocultar acciones no permitidas por rol (no solo depender del backend),
usando el rol del usuario y/o los permisos cargados en el layout. El backend sigue siendo
la autoridad final.

---

## 16. Matriz pantalla → RPC → acción → permiso

| Pantalla / acción | RPC | Permiso | Rol contextual |
| --- | --- | --- | --- |
| Listado de jornadas (filtros/paginación) | `list_inventory_sessions` | `sessions.read` | — |
| Detalle multi-estado | `get_inventory_session_detail` | `sessions.read` | — |
| Configuración DRAFT/PREPARED | `get_inventory_session_setup` | `sessions.read` | — |
| Catálogos (bodegas, oficinas, ubicaciones, usuarios) | `get_inventory_session_catalogs` | `sessions.read` | — |
| Revisión UNDER_REVIEW | `get_inventory_session_review` | `sessions.read` | — |
| Crear jornada (paso 1) | `create_inventory_session` | `sessions.create` | ADMINISTRATOR |
| Agregar/revocar participante | `add/revoke_inventory_session_participant` | `participants.manage` | ADMINISTRATOR |
| Crear zona | `create_inventory_session_zone` | `zones.manage` | ADMINISTRATOR |
| Asociar ubicación | `add_inventory_zone_location` | `zones.manage` | ADMINISTRATOR |
| Crear tarea/asignar COUNTER | `create_inventory_task` | `tasks.assign` | ADMINISTRATOR |
| Preparar jornada | `prepare_inventory_session` | `sessions.configure` | ADMINISTRATOR |
| Abrir jornada | `start_inventory_session` | `sessions.start` | ADMINISTRATOR |
| Cerrar jornada | `close_inventory_session` | `sessions.close` | ADMINISTRATOR |
| Validar/invalidar/reabrir tarea | `validate/invalidate/reopen_inventory_task` | `tasks.validate` | SUPERVISOR |
| Operar tarea (iniciar/pausar/reanudar/completar) | `start/pause/resume/complete_inventory_task` | `tasks.execute` | COUNTER |
| Registrar/corregir/invalidar conteo | `record/correct/invalidate_inventory_count` | `counts.record` / `counts.correct` | COUNTER / SUPERVISOR |
| Reportar/resolver incidencia | `report/resolve_inventory_incident` | `incidents.manage` | COUNTER / SUPERVISOR |
| Recuentos (solicitar/asignar/iniciar/registrar/completar/cancelar/decidir) | `*_inventory_recount` | `recounts.manage` / `recounts.decide` | SUPERVISOR |
| Aprobar jornada | `approve_inventory_session` | `sessions.approve` | MANAGER |
| Cancelar jornada | `cancel_inventory_session` | `sessions.cancel` | ADMINISTRATOR |

El rol contextual (participante de la jornada) se valida en el backend; la UI informa
cuándo el usuario carece del rol (mensaje de permisos, véase §17).

---

## 17. Manejo de loading, empty, error y permisos

| Estado | Comportamiento UI |
| --- | --- |
| Loading | skeletons/esqueletos por tarjeta o spinner centrado; nunca flash de vacío |
| Empty | `InventoryEmptyState`: mensaje claro + acción sugerida (p. ej. "Crea tu primera jornada") |
| Error | Toast (Sonner) + estado inline en tarjeta con mensaje legible y "Reintentar" |
| Permisos (rol) | Acción oculta o deshabilitada con tooltip; si el backend rechaza → toast con el mensaje INV (no el código técnico) |
| Sin empresa activa | Reutiliza el bloqueo existente del layout (ModuleLayout) |
| `ready_to_approve=false` | Botón Aprobar deshabilitado + lista de motivos |

---

## 18. Fases posteriores de implementación

1. **4H.2B — Esqueleto del módulo**: ruta `/dashboard/inventarios`, `InventoryModuleShell`,
   `InventorySidebar` contraíble, habilitar la tarjeta del dashboard (agregar `route/icon`
   al módulo `inventarios`), página Resumen con KPIs y accesos.
2. **4H.2C — Jornadas**: tabla paginada con filtros (`list_inventory_sessions`) y detalle
   con encabezado + pestañas.
3. **4H.2D — Asistente Nueva jornada**: wizard 6 pasos con las RPC de creación/configuración
   y "Preparar jornada".
4. **4H.2E — Operación**: apertura (`start_inventory_session`), board de tareas, conteos,
   incidencias.
5. **4H.2F — Revisión**: panel de validación, recuentos, motivos que impiden aprobar,
   aprobación.
6. **4H.2G — Resultados**: resultado oficial, diferencias, cancelación, exportación futura.
7. **4H.2H — Pulido**: accesibilidad, responsive fino, tests, rediseño piloto global.

---

## 19. Riesgos y decisiones pendientes

1. **Tarjeta del dashboard**: el módulo `inventarios` se insertó en `portal.modules` sin
   `route` ni `icon` (solo `code,name`). Habilitar la tarjeta exige una migración de datos
   que agregue `route='/dashboard/inventarios'`, `icon` (p. ej. `Boxes`/`ClipboardList`)
   y `sort_order` al módulo, más verificación de `get_visible_modules`.
2. **`MODULE_PREFIXES`**: el layout del dashboard lista los prefijos de módulos que
   renderizan su propio layout; hay que añadir `/dashboard/inventarios` para que el módulo
   use `InventoryModuleShell` en lugar del layout genérico.
3. **Resultado oficial**: `official_versions`/`official_version_items` no tienen RPC de
   lectura pública; la pestaña Resultados necesita un contrato de consulta (futura fase)
   o derivar de `get_inventory_session_detail` + `approve` response hasta entonces.
4. **Alcance PARTIAL por UI**: el backend de 4G.1 no expone RPC para `session_product_scopes`
   (solo zonas/ubicaciones); el paso 2 del asistente para PARTIAL requiere decidir si se
   agrega esa RPC o se pospone la selección de productos en la UI.
5. **Skeleton**: no existe componente `Skeleton`; añadir uno ligero en `components/ui`
   (o temporal dentro del módulo) para el estado de carga.
6. **Preferencia de sidebar**: persistencia en `localStorage`; si se requiere por-usuario
   en servidor, decidir más adelante.
7. **Sidebar global vs de módulo**: el portal no tiene sidebar global contraíble todavía;
   el sidebar de Inventarios es el primer caso y servirá de patrón para el rediseño global.

---

## 20. Estructura de archivos propuesta

```
src/app/dashboard/inventarios/
  layout.tsx                # server layout: auth + perfil + permisos
  inventarios-layout-client.tsx  # client: InventoryModuleShell + rutas del sidebar
  page.tsx                  # Resumen
  jornadas/page.tsx         # Listado
  jornadas/nueva/page.tsx   # Asistente
  jornadas/[id]/page.tsx    # Detalle (+ ?tab=)
  operacion/page.tsx        # Operación
  revision/page.tsx         # Revisión
  resultados/page.tsx       # Resultados

src/modules/inventarios/
  components/
    inventory-module-shell.tsx
    inventory-sidebar.tsx
    inventory-page-header.tsx
    inventory-status-badge.tsx
    inventory-kpi-card.tsx
    inventory-quick-action.tsx
    inventory-session-table.tsx
    inventory-session-wizard.tsx
    inventory-session-header.tsx
    inventory-progress-panel.tsx
    inventory-task-board.tsx
    inventory-review-panel.tsx
    inventory-blocking-alert.tsx
    inventory-empty-state.tsx
    inventory-confirm-dialog.tsx
  lib/
    states.ts              # traducción estados → etiquetas/colores
    rpc.ts                 # wrappers tipados de las RPC del backend
```

---

## 21. Conclusión

El diseño está completo y listo para implementar. El backend (4G.1–4G.5 + 4H.1) cubre
todas las operaciones y consultas; el portal ya dispone de layout de módulo, componentes
UI y tema claro alineado con la dirección visual aprobada. Se identificaron decisiones
pendientes (tarjeta del dashboard, alcance PARTIAL, contrato de resultado oficial) que se
resolverán en las fases de implementación 4H.2B–4H.2H.

**Estado: `DISEÑO_UI_INVENTARIOS_LISTO_PARA_IMPLEMENTAR`**
