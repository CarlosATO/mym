# Autorización Operativa - Inventory Engine Fase 4F

## Resultado de 4F.0

- 32 firmas finales
- 22 RPCs operativas
- 10 helpers internos
- 0 overloads
- 0 aliases
- Superficie segura para exposición

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
