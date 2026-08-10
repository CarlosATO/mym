# Contrato Mobile: Registrar Conteo (M1.5B)

## Objetivo
Registrar la captura física de un producto ya identificado, bajo la ubicación abierta en curso, inyectándolo de forma segura en la arquitectura de Idempotencia del motor `record_inventory_count`.

## RPC Wrapper
`inventarios.submit_my_mobile_count`

**Firma:**
```sql
inventarios.submit_my_mobile_count(
    p_zone_id uuid,
    p_location_id uuid,
    p_snapshot_product_id uuid,
    p_physical_quantity numeric,
    p_identification_method text,
    p_scanned_code text,
    p_idempotency_key uuid,
    p_captured_at timestamptz,
    p_device_id text
) RETURNS jsonb
```

## Parámetros Obligatorios Críticos
- `p_device_id`: Obligatorio (no puede ser nulo o vacío). Debe provenir del ID de instalación seguro del dispositivo móvil (ej. UUID en SecureStore).
- `p_idempotency_key`: El core lo utiliza internamente como `offline_id` transaccional. Debe ser generado por Mobile (UUID v4) al momento de la captura en memoria/local. Si se reintenta el mismo registro por fallos de red, usar el mismo key.

## Método de Identificación (`p_identification_method`)
Soporta estrictamente los valores:
1. `'BARCODE'`: El `p_scanned_code` (código capturado) debe hacer match EXACTO (case-sensitive) con `snapshot_products.barcode`.
2. `'SKU_MANUAL'`: El `p_scanned_code` debe hacer match EXACTO con `snapshot_products.sku`.
3. `'SEARCH_MANUAL'`: Se permite texto libre de búsqueda en `p_scanned_code` o nulo.

*(Cualquier otro método como `UNIDENTIFIED_MANUAL` resultará en un rechazo `INV_INVALID_IDENTIFICATION_METHOD` en M1.5B).*

## Consistencia de Cantidad
- `p_physical_quantity` debe ser un numérico positivo o cero (ej. `0`, `5`, `12.500`). Valores negativos generarán un error DB.
- El wrapper mapea automáticamente este valor al bucket `available_quantity` y setea en `0` todos los demás buckets (`damaged`, `expired`, `blocked`, `other_unavailable`).

## Reglas de Stock Teórico
- La transacción tiene éxito incluso si el producto **no posee stock teórico esperado** en esta ubicación (validado contra el snapshot_locations, no contra snapshot_stocks).
- Si el producto ingresado no pertenece al Snapshot global (maestra congelada), se rechazará la transacción (`INV_INVALID_PRODUCT`).

## Respuesta
Retorna un envelope estandarizado (Response Payload de `complete_idempotent_operation`):
```json
{
  "operation": "inventarios.count.record",
  "entity_id": "uuid (del count_entry_id)",
  "state": null,
  "version": null,
  "cycle_number": 1,
  "assignment_id": "uuid",
  "replayed": false,
  "occurred_at": "...",
  "data": {
    "snapshot_product_id": "...",
    "physical_quantity": 5,
    "available_quantity": 5,
    "damaged_quantity": 0,
    ...
  }
}
```
*Si se reenvía el mismo `p_idempotency_key` con el mismo payload, el servidor retornará exitosamente el envelope original marcando `"replayed": true`.*
