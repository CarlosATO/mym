# Matriz de Seguridad y Exposición - Inventory Engine

## Convenciones

| Símbolo | Significado |
|---------|-------------|
| 🟢 | Expuesto / Concedido |
| 🔴 | No expuesto / Revocado |
| ⚪ | No aplica |

## Asignación Actual (4E.5 - Post-4E)

| Función | EXECUTE TO authenticated | Data API (inventarios) |
|---------|--------------------------|----------------------|
| **Apertura** | | |
| `create_inventory_session` | 🟢 | 🟢 |
| `add_task_to_inventory_session` | 🟢 | 🟢 |
| `open_inventory_session` | 🟢 | 🟢 |
| **Ejecución** | | |
| `create_count_entry` | 🟢 | 🟢 |
| `recount_all_session_tasks` | 🟢 | 🟢 |
| `recount_single_task` | 🟢 | 🟢 |
| **Cierre temprano** | | |
| `complete_inventory_session` | 🟢 | 🟢 |
| `cancel_inventory_session` | 🟢 | 🟢 |
| **Incidentes y correcciones** | | |
| `report_responsive_incident` | 🟢 | 🟢 |
| `resolve_incident` | 🟢 | 🟢 |
| `request_correction` | 🟢 | 🟢 |
| `approve_correction` | 🟢 | 🟢 |
| `reject_correction` | 🟢 | 🟢 |
| **Aprobación** | | |
| `approve_inventory_session` | 🟢 | 🟢 |
| `reject_inventory_session` | 🟢 | 🟢 |
| **Carga masiva** | | |
| `bulk_insert_count_entries` | 🟢 | 🟢 |
| `get_bulk_csv_tpl_single_sku` | 🟢 | 🟢 |
| **Helpers internos (sin EXECUTE)** | | |
| `get_effective_count_entries` | 🔴 | 🔴 |
| `get_pending_sessions` | 🔴 | 🔴 |
| `get_inventory_summary` | 🔴 | 🔴 |
| `get_session_details` | 🔴 | 🔴 |
| `can_user_incident` | 🔴 | 🔴 |
| `format_sku` | 🔴 | 🔴 |
| `has_inventory_permission` | 🔴 | 🔴 |
| `validate_variant_data` | 🔴 | 🔴 |
| `validate_incident_context` | 🔴 | 🔴 |
| `validate_correction_context` | 🔴 | 🔴 |

## Tablas expuestas vía Data API

| Tabla | RLS | Accesso directo | Vía RPC |
|-------|-----|-----------------|---------|
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

## Resumen (4F.0)

- 33 firmas finales: 23 RPCs operativas + 10 helpers internos
- 0 overloads, 0 aliases
- 23 GRANT EXECUTE TO authenticated
- 10 helpers con EXECUTE revocado
- Schema `inventarios` expuesto en Data API (4F.1)
