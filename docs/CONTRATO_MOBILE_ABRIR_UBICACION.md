# CONTRATO: ABRIR UBICACIÓN DE CONTEO (M1.4A)

## Estado de Ejecución
- **Migración Aplicada**: SÍ. Migración `20260810140000_inventarios_mobile_open_location.sql` fue aplicada exitosamente al entorno remoto.
- **QA Funcional**: **NO EJECUTADO DESTRUCTIVAMENTE**. Debido a que el entorno (REST API) no soporta transacciones de rollback (`BEGIN`/`ROLLBACK`) y no se cuenta con el DSN de PostgreSQL (`psql`) para probar concurrencia de forma segura, se han marcado los tests QA1-QA12 como "No Ejecutado Destructivamente" para proteger los datos productivos. La seguridad estructural se delega a las constraints e índices de base de datos definidos en la migración final.

## Objetivo
Este contrato define la interacción entre la aplicación móvil y el backend para abrir una ubicación de conteo en una zona activa. Permite que el usuario comience a trabajar operativamente en una ubicación, estableciéndola como la única ubicación activa para el usuario, e impidiendo que otra persona trabaje en la misma simultáneamente.

## RPC: `inventarios.open_my_counting_location`

**Método**: POST /rpc/open_my_counting_location  
**Autenticación**: Requerida (Bearer Token)

### Request Payload

El móvil debe enviar **únicamente** los identificadores requeridos para la operación:

```json
{
  "p_zone_id": "uuid",
  "p_location_id": "uuid",
  "p_idempotency_key": "uuid"
}
```

*Nota: La identidad del actor se resuelve de forma segura mediante `inventarios.require_actor()` a través del token JWT.*

### Response (Envelope JSONB)

El backend retorna un objeto consolidado:

```json
{
  "success": true,
  "task_location_id": "uuid",
  "zone_id": "uuid",
  "task_id": "uuid",
  "location_id": "uuid",
  "location_code": "STRING",
  "location_name": "STRING",
  "status": "OPEN",
  "opened_at": "TIMESTAMPTZ",
  "actor_id": "uuid"
}
```

## Precondiciones y Validaciones (Backend)

Antes de realizar la apertura, el backend validará exhaustivamente:
1. **Actor Válido**: Identidad operacional resuelta.
2. **Guards de Participante y Asignación**: Validación estricta uniéndose a `task_assignments`, `session_participants` y `sessions`, requiriendo un participante de inventario activo y una asignación vigente.
3. **Zona Habilitada**: La zona existe y está habilitada.
4. **Tarea IN_PROGRESS**: La tarea asignada al actor para la zona se encuentra **estrictamente** en `IN_PROGRESS` (Rechaza `ASSIGNED`, `PAUSED`, `COMPLETED`).
5. **Pertenencia de Ubicación**: La ubicación (`p_location_id`) realmente pertenece a la zona (`p_zone_id`) mediante la tabla `session_zone_locations`.

## Reglas de Negocio Invariantes

La operación está protegida de concurrencia mediante restricciones estrictas de base de datos (índices parciales condicionados):

1. **UN ACTOR → UNA UBICACIÓN OPEN**: `UNIQUE(opened_by) WHERE status = 'OPEN'`
   Si el actor intenta abrir otra ubicación, falla inmediatamente con `INV_LOCATION_ALREADY_OPEN`.
2. **UNA UBICACIÓN DENTRO DE UNA TAREA → NO ABIERTA SIMULTÁNEAMENTE POR 2 ACTORES**: `UNIQUE(task_id, session_zone_location_id) WHERE status = 'OPEN'`
   Si otro actor logra intentar abrir la misma ubicación, falla con `INV_ACCESS_DENIED` para evitar colisiones operacionales.

## Idempotencia y Reintentos de Red

La RPC utiliza nativamente el marco de `inventarios.operation_idempotency`.
- La firma del hash asocia la operación a **`actor_id`**, `zone_id` y `location_id`.
- **Reintentos idénticos**: Retornan inmediatamente la respuesta cacheada sin duplicar registros ni eventos (`mode = 'REPLAY'`).
- **Modificación de payload/actor**: Genera un error transparente si la clave de idempotencia se está reutilizando indebidamente.

## Eventos Operacionales

Una apertura exitosa inyecta automáticamente un evento inmutable asociado a la tarea:
- **`LOCATION_OPENED`** (en `inventarios.task_events`)

## Errores (Códigos Opacos de Seguridad)

- **`INV_ACCESS_DENIED`**: El actor no posee la asignación necesaria, la tarea no está `IN_PROGRESS`, la ubicación pertenece a otra zona, o bien otra persona ya la tiene abierta.
- **`INV_LOCATION_ALREADY_OPEN`**: El usuario actual ya tiene una ubicación abierta; debe finalizarla antes de iniciar otra.
- **`INV_IDEMPOTENCY_CONFLICT`**: Reuso de idempotency key con payload o actor modificado.

## Acceso Restringido
La tabla `inventarios.task_locations` **NO es accesible directamente** para lectura, escritura, actualización o borrado a través de clientes anónimos o autenticados (`PUBLIC` y `authenticated` no tienen provisión de DML directa). Todas las interacciones deben atravesar la RPC `open_my_counting_location` marcada como `SECURITY DEFINER`.

## Recuperación de Estado (M1.4A.1)
*Nota*: Tras abrir exitosamente una ubicación, si la aplicación móvil necesita reconstruir su estado (por reinicio, recarga o salida de la pantalla), Mobile no debe confiar únicamente en su estado persistido local. Debe consumir `get_my_counting_zone_locations` la cual ahora expone los campos operacionales (`location_status: "OPEN"`) para cada ubicación, permitiendo reconstruir la vista con base en la verdad absoluta del backend.
