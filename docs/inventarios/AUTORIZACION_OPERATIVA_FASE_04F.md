# Autorización Operativa - Inventory Engine Fase 4F

## Resultado de 4F.0

- 33 firmas finales
- 23 RPCs operativas
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

## Smoke tests ejecutados (4F.1)

| Prueba | Resultado |
|--------|-----------|
| Tabla directa anon | PASS (401) |
| RPC approve anon | PASS (401) |
| Helper anon | PASS (401) |
| Pruebas authenticated | SKIPPED (sin JWT) |

## Pendiente para 4F.2

- Mapeo de permisos de inventarios a roles de portal
- Asignación de `inventarios.sessions.approve` a GERENCIA o nuevo rol
- Pruebas authenticated completas

## Pendientes generales

- Frontend de inventarios
- Exportación oficial a Bsale
- Reconciliación post-carga
