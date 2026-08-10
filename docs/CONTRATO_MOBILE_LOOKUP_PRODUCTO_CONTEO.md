# Contrato Mobile: Lookup Producto Conteo (M1.5B)

## Objetivo
Resolver los productos correspondientes a un código de barras escaneado dentro del contexto de una ubicación abierta.

## RPC
`inventarios.lookup_my_counting_product`

**Firma:**
```sql
inventarios.lookup_my_counting_product(
    p_zone_id uuid,
    p_location_id uuid,
    p_barcode text
) RETURNS jsonb
```

## Requisitos de Autorización y Contexto
- El actor debe ser un `COUNTER` válido y asignado a la zona actual.
- La sesión debe estar en estado `COUNTING`.
- La tarea del usuario debe estar en `IN_PROGRESS`.
- La ubicación (`p_location_id`) DEBE estar actualmente `OPEN` (`inventarios.task_locations`) por este actor para la tarea en curso.
- *NOTA:* Si el contador no tiene esta ubicación abierta, la búsqueda será rechazada con error de negocio.

## Manejo de Stock Teórico
Este endpoint devuelve resultados **sin incluir el stock teórico, esperado, ni historial de capturas**. El frontend no debe calcular ni mostrar diferencias al usuario. El conteo es estrictamente a ciegas.

## Respuesta
El código de barras (`p_barcode`) puede estar duplicado en el maestro o no existir.

### Caso 1: Múltiples o un Match (match_count >= 1)
```json
{
  "match_count": 1, 
  "matches": [
    {
      "snapshot_product_id": "uuid",
      "product_id": "uuid",
      "sku": "12345",
      "barcode": "780123456789",
      "name": "Producto de Ejemplo"
    }
  ]
}
```
*Si `match_count > 1`, Mobile debe mostrar un modal para que el usuario seleccione manualmente el producto correcto.*

### Caso 2: Sin Match (match_count = 0)
```json
{
  "match_count": 0,
  "matches": []
}
```
Esto **NO es un error técnico**. El frontend debe procesar esto y mostrar un mensaje del tipo "Código no encontrado". (No se admite conteo de "Producto No Identificado" en M1.5B).
