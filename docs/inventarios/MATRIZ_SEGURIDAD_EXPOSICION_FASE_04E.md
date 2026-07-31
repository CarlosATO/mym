# Matriz de Seguridad y Exposición - Inventory Engine

## Convenciones

| Símbolo | Significado |
|---------|-------------|
| 🟢 | Expuesto / Concedido |
| 🔴 | No expuesto / Revocado |
| ⚪ | No aplica |

## Asignación Actual (4F.2 - Superficie Física Real)

Superficie física confirmada: **22 RPCs operativas + 10 helpers internos = 32 funciones**.
Los documentos previos de 4E usaban nombres de un diseño anterior que no existe en el
código aplicado; esta matriz refleja las firmas físicas reales con `EXECUTE` concedido.

### Reconciliación (4F.2-H1)

La cifra de 23 RPCs / 33 firmas informada en 4F.0 fue un error documental: provino de la
matriz conceptual 4E original, cuyos nombres (`create_inventory_session`,
`create_count_entry`, `reject_inventory_session`, `bulk_insert_count_entries`, etc.)
nunca fueron implementados como funciones. La migración 4E.5 cubre las 32 firmas reales
(22 GRANT EXECUTE a authenticated + 10 helpers revocados) y la matriz 4F.2 asigna los 10
permisos usados por las 22 RPCs. No existe RPC vigente sin grant ni sin permiso asignado.
El permiso `inventarios.sessions.start` queda reservado, sin RPC que lo use.

### RPCs operativas (EXECUTE TO authenticated) y autorización

| RPC | Permiso | functional_role | Grant |
|-----|---------|-----------------|-------|
| `start_inventory_task` | `inventarios.tasks.execute` | COUNTER | 🟢 |
| `pause_inventory_task` | `inventarios.tasks.execute` | COUNTER | 🟢 |
| `resume_inventory_task` | `inventarios.tasks.execute` | COUNTER | 🟢 |
| `complete_inventory_task` | `inventarios.tasks.execute` | COUNTER | 🟢 |
| `validate_inventory_task` | `inventarios.tasks.validate` | SUPERVISOR | 🟢 |
| `invalidate_inventory_task` | `inventarios.tasks.validate` | SUPERVISOR | 🟢 |
| `reopen_inventory_task` | `inventarios.tasks.validate` | SUPERVISOR | 🟢 |
| `reassign_inventory_task` | `inventarios.tasks.assign` | SUPERVISOR | 🟢 |
| `cancel_inventory_task` | `inventarios.tasks.cancel` | SUPERVISOR o ADMINISTRATOR | 🟢 |
| `record_inventory_count` | `inventarios.counts.record` | COUNTER | 🟢 |
| `correct_inventory_count` | `inventarios.counts.correct` | COUNTER o SUPERVISOR | 🟢 |
| `invalidate_inventory_count` | `inventarios.counts.correct` | COUNTER o SUPERVISOR | 🟢 |
| `report_inventory_incident` | `inventarios.incidents.manage` | COUNTER o SUPERVISOR | 🟢 |
| `resolve_inventory_incident` | `inventarios.incidents.manage` | SUPERVISOR | 🟢 |
| `request_inventory_recount` | `inventarios.recounts.manage` | COUNTER o SUPERVISOR | 🟢 |
| `assign_inventory_recount` | `inventarios.recounts.manage` | SUPERVISOR | 🟢 |
| `start_inventory_recount` | `inventarios.recounts.manage` | COUNTER (asignado) | 🟢 |
| `record_inventory_recount` | `inventarios.recounts.manage` | COUNTER (asignado) | 🟢 |
| `complete_inventory_recount` | `inventarios.recounts.manage` | COUNTER (asignado) | 🟢 |
| `cancel_inventory_recount` | `inventarios.recounts.manage` | SUPERVISOR | 🟢 |
| `decide_inventory_recount` | `inventarios.recounts.decide` | SUPERVISOR | 🟢 |
| `approve_inventory_session` | `inventarios.sessions.approve` | MANAGER | 🟢 |

### Helpers internos (sin EXECUTE para authenticated)

| Helper | EXECUTE TO authenticated | Data API |
|--------|--------------------------|----------|
| `require_actor` | 🔴 | 🔴 |
| `require_company_access` | 🔴 | 🔴 |
| `require_permission` | 🔴 | 🔴 |
| `require_session_participant` | 🔴 | 🔴 |
| `compute_request_hash` | 🔴 | 🔴 |
| `begin_idempotent_operation` | 🔴 | 🔴 |
| `complete_idempotent_operation` | 🔴 | 🔴 |
| `get_effective_count_entries` | 🔴 | 🔴 |
| `get_applicable_recount_decisions` | 🔴 | 🔴 |
| `get_effective_task_contributions` | 🔴 | 🔴 |

## Tablas expuestas vía Data API

| Tabla | RLS | Acceso directo | Vía RPC |
|-------|-----|----------------|---------|
| `sessions` | 🟢 | 🔴 | 🟢 |
| `session_participants` | 🟢 | 🔴 | 🟢 |
| `session_tasks` | 🟢 | 🔴 | 🟢 |
| `count_entries` | 🟢 | 🔴 | 🟢 |
| `incidents` | 🟢 | 🔴 | 🟢 |
| `incident_types` | 🟢 | 🔴 | 🟢 |
| `corrections` | 🟢 | 🔴 | 🟢 |
| `recount_requests` | 🟢 | 🔴 | 🟢 |
| `reported_inventory` | 🟢 | 🔴 | 🟢 |
| `correction_candidates` | 🟢 | 🔴 | 🟢 |

## Matriz de permisos a roles del portal (4F.2)

| Permission code | BODEGA | GERENCIA | SUPER_USUARIO | CONSULTA_DE_BODEGA | FINANZAS | VENDEDOR |
|-----------------|--------|----------|---------------|--------------------|----------|----------|
| `inventarios.tasks.assign` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.tasks.execute` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.tasks.validate` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.tasks.cancel` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.counts.record` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.counts.correct` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.incidents.manage` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.recounts.manage` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.recounts.decide` | 🟢 | 🔴 | 🟢 | 🔴 | 🔴 | 🔴 |
| `inventarios.sessions.approve` | 🔴 | 🟢 | 🟢 | 🔴 | 🔴 | 🔴 |

- SUPER_USUARIO: 10 permisos explícitos (sin herencia automática).
- BODEGA: 9 permisos operativos; sin `sessions.approve`.
- GERENCIA: únicamente `sessions.approve`.
- CONSULTA_DE_BODEGA, FINANZAS y VENDEDOR: cero permisos de Inventarios.

## Resumen (4F.0 + 4F.2)

- 32 firmas finales: 22 RPCs operativas + 10 helpers internos
- 0 overloads, 0 aliases
- 22 GRANT EXECUTE TO authenticated
- 10 helpers con EXECUTE revocado
- Schema `inventarios` expuesto en Data API (4F.1)
- 10 permisos de Inventarios mapeados a roles del portal (4F.2)
- 0 roles nuevos, 0 permisos nuevos, 0 user_permissions, 0 policies
