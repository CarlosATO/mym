# CONTRATO: LECTURA DE UBICACIONES DE ZONA (M1.4A.1)

## Objetivo
Este contrato define la respuesta del backend al solicitar las ubicaciones pertenecientes a una zona de conteo asignada. Además de la estructura de la zona y sus ubicaciones ordenadas, informa el estado operacional de cada ubicación respecto de la tarea activa del usuario, permitiendo que la aplicación móvil reconstruya su estado tras una recarga, salida u otra interrupción.

## RPC: `inventarios.get_my_counting_zone_locations`

**Método**: POST /rpc/get_my_counting_zone_locations  
**Autenticación**: Requerida (Bearer Token)

### Request Payload

```json
{
  "p_zone_id": "uuid"
}
```

*Nota: La identidad del actor se resuelve internamente de forma segura.*

### Response Payload

El backend retorna un `jsonb` consolidado:

```json
{
  "zone": {
    "zone_id": "uuid",
    "zone_name": "string",
    "zone_code": "string",
    "task_id": "uuid",
    "task_status": "string",
    "inventory_name": "string",
    "site_name": "string"
  },
  "location_count": 2,
  "locations": [
    {
      "location_id": "uuid",
      "location_code": "string",
      "location_name": "string",
      "sort_order": 1,
      "task_location_id": "uuid | null",
      "location_status": "OPEN | null",
      "opened_at": "timestamptz | null"
    }
  ]
}
```

### Campos Operacionales (Extensiones M1.4A.1)
- `task_location_id`: UUID del registro operacional en curso (o `null`).
- `location_status`: Estado operacional de la ubicación (`OPEN` o `null`). Un valor `null` indica que no existe una operación activa para esta ubicación en la tarea actual.
- `opened_at`: Fecha y hora de la apertura (si está abierta).

> **IMPORTANTE**: La app móvil no debe utilizar un estado local como fuente de verdad. Tras reanudar o reiniciar la aplicación, Mobile consumirá este endpoint para determinar si existe alguna ubicación marcada con `location_status: "OPEN"` y bloquear el resto de la interfaz acorde a esta verdad de backend.

## Restricciones y Resolución
- **Identidad de la Task**: La consulta une `task_locations` estrictamente a la tarea vigente resuelta (evitando cruces con recounts, históricos u otros usuarios).
- **Fila Única**: Debido a los índices parciales, existe como máximo un registro en estado `OPEN` para cada combinación de tarea y ubicación.
- **Acceso Interno**: La RPC expone estos campos leyendo de forma segura y autorizada desde `inventarios.task_locations` internamente (evitando N+1 queries). Los usuarios autenticados no pueden consultar dicha tabla directamente.
