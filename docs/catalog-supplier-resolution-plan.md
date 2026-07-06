# Implementación Fase 2: Proveedor Real en Catálogo

Agregaremos visibilidad y edición controlada de proveedores en el módulo Catálogo/Productos sin alterar la tabla física de `products` con un `supplier_id`. Todo se gestionará a través de `product_supplier_mappings`.

## User Review Required

- Se agregará una consulta en bloque (bulk) en `getProducts` para resolver las relaciones con los proveedores sin generar problemas de rendimiento (N+1).
- El estado visual `supplier_resolution_status` será: `DIRECTO`, `ASOCIADO`, `PENDIENTE_ASOCIACION` o `SIN_PROVEEDOR`.
- Se añadirá la función `getRealSuppliers()` para poblar el selector de proveedores en productos manuales.

## Open Questions

- ¿El costo inicial para un nuevo producto manual (`unit_cost`) se debe capturar en esta fase o lo dejamos en nulo/cero para la tabla `product_supplier_mappings` hasta que se implemente el módulo de costos completo? (Asumiré `unit_cost = 0` por defecto si no hay input, a menos que me indiques lo contrario).

## Proposed Changes

### `src/app/actions/adquisiciones/products.ts`

- **[MODIFY] `Product` Interface:** Añadir campos extendidos (`supplier_mapping_id`, `supplier_id`, `supplier_kind`, `pseudo_supplier_name`, `real_supplier_id`, `real_supplier_name`, `supplier_resolution_status`, `proveedor_origen`).
- **[MODIFY] `getProducts`:** 
  1. Extraer los IDs de los productos paginados devueltos.
  2. Hacer bulk fetch de `product_supplier_mappings` para esos productos.
  3. Hacer bulk fetch de `suppliers` (incluyendo sus `parent_supplier_id` join con nombre).
  4. Mapear y adjuntar los resultados al array de `Product`.
- **[MODIFY] `createProduct`:** Para productos donde `source !== 'BSALE'`, leer `real_supplier_id` del FormData y crear el `product_supplier_mapping` correspondiente.
- **[MODIFY] `updateProduct`:** Actualizar o insertar mapping si es un producto manual (no BSALE).

### `src/app/actions/adquisiciones/suppliers.ts`

- **[MODIFY] `suppliers.ts`:** Añadir `getRealSuppliers()` que retorne los `suppliers` con `supplier_kind = 'REAL'`.

### `src/modules/adquisiciones/catalogo/catalog-panel.tsx`

- **[MODIFY] Formulario Edición:** 
  - Si `source === 'BSALE'`: Mostrar bloque solo lectura con `pseudo_supplier_name`, `real_supplier_name` y `supplier_resolution_status`.
  - Si `source !== 'BSALE'`: Mostrar `<select>` poblado con `getRealSuppliers()` para elegir Proveedor Principal.
- **[MODIFY] Tabla Catálogo:** Añadir dos nuevas columnas ("Proveedor real" y "Origen prov.") y renderizar los datos correspondientes.

## Verification Plan

### Automated Tests
- Ejecutar `npx tsc --noEmit` para asegurar integridad de tipos.

### Manual Verification
1. Abrir catálogo. Confirmar que el producto `ACWS/ALIMENTO` muestra `ANIMAL CARE - ACWS S.A.` (Caso 1 - Asociado).
2. Confirmar que un producto con `HAGEN` muestra "Pendiente de asociación" (Caso 2).
3. Abrir edición de un producto Bsale y verificar bloque solo lectura.
4. Crear un producto manual nuevo, elegir proveedor real "ANIMAL CARE", guardar y confirmar que la tabla lo muestra como `DIRECTO`.
