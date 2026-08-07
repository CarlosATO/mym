# Contrato Mobile — Inicio de Zona

Este documento especifica el contrato de backend para que la aplicación móvil permita al usuario iniciar operativamente una zona de conteo reservando su ejecución.

## Firma del Wrapper Mobile
```sql
inventarios.start_my_counting_zone(
  p_zone_id pg_catalog.uuid,
  p_idempotency_key pg_catalog.uuid
) RETURNS pg_catalog.jsonb
```

## Seguridad y Permisos
- **SECURITY DEFINER** (ejecuta con rol de `postgres`).
- Requiere autenticación de Supabase (JWT validado como `authenticated`).
- Internamente valida que el usuario (`actor`) posea el permiso `inventarios.tasks.execute`.

## Invariante de Negocio
**Un actor operacional puede tener como máximo una task de conteo en estado `IN_PROGRESS` o `PAUSED` en todo el sistema.**
- El backend aplica un candado (advisory lock) global al actor para serializar concurrencia.
- Si el usuario tiene otra zona en `IN_PROGRESS` o `PAUSED`, la mutación es rechazada preventivamente y lanza el código de error `INV_ACTOR_HAS_ACTIVE_TASK`.

## Idempotencia y Replay
El cliente Android debe generar un UUID único (`p_idempotency_key`) para cada intento de operación inicial.
- Si la misma clave se envía de nuevo, se ejecutará el flujo de **replay** y se devolverá el payload original exitoso sin generar eventos adicionales, bajo el formato `'replayed': true`.
- Este mecanismo protege a la operación contra interrupciones de red que puedan requerir un reintento manual o automático desde el móvil.

## payload devuelto
En caso de éxito, retorna el mismo formato de `start_inventory_task`:
```json
{
  "operation": "inventarios.task.start",
  "entity_id": "uuid-de-la-task",
  "state": "IN_PROGRESS",
  "version": 2,
  "cycle_number": 1,
  "assignment_id": "uuid-asignacion",
  "event_id": "uuid-del-evento",
  "replayed": false,
  "occurred_at": "2026-08-07T...Z",
  "data": {}
}
```

## Errores (Error Codes)
- `INV_ACCESS_DENIED`: El usuario no tiene la asignación, la zona no existe o la sesión no está en conteo.
- `INV_TASK_INVALID_STATE`: La zona ya no se encuentra en estado `ASSIGNED` para iniciar.
- `INV_ACTOR_HAS_ACTIVE_TASK`: El usuario ya se encuentra trabajando (IN_PROGRESS o PAUSED) en otra zona.
- `INV_CONCURRENT_MODIFICATION`: Problema de concurrencia al modificar la entidad.

## Flujo de QA Superado
El contrato cumple con QA estricto comprobando que un actor (Carlos) no puede iniciar una Zona 3 si su Zona 1 está `IN_PROGRESS` ni tampoco si fue transicionada a `PAUSED`. El esquema concurrente también bloquea asignaciones cruzadas y valida replay de forma correcta.
