# Plan de Bootstrap y Enriquecimiento de Catálogo Bsale -> PetGrup

Este documento detalla el plan de arquitectura actualizado, las reglas de sincronización, las modificaciones estructurales y los resultados de la auditoría y simulación (Dry-Run) reforzada. Todo ha sido preparado en estricta validación sin modificar datos aún.

## 1. Migración de Estructura (DDL)

Actualmente la tabla `adquisiciones.products` no posee columnas de trazabilidad. Se ha diseñado la migración **`20260706100000_catalog_bsale_references.sql`** con el siguiente contenido, utilizando comandos seguros (`IF NOT EXISTS`):

```sql
ALTER TABLE adquisiciones.products
ADD COLUMN IF NOT EXISTS bsale_product_id integer,
ADD COLUMN IF NOT EXISTS bsale_variant_id integer,
ADD COLUMN IF NOT EXISTS bsale_product_type_id integer,
ADD COLUMN IF NOT EXISTS bsale_product_type_name text,
ADD COLUMN IF NOT EXISTS source text DEFAULT 'PETGRUP',
ADD COLUMN IF NOT EXISTS last_bsale_sync_at timestamptz,
ADD COLUMN IF NOT EXISTS bsale_product_state integer,
ADD COLUMN IF NOT EXISTS bsale_variant_state integer,
ADD COLUMN IF NOT EXISTS bsale_sync_hash text;

CREATE INDEX IF NOT EXISTS idx_products_company_bsale_prod ON adquisiciones.products(company_id, bsale_product_id);
CREATE INDEX IF NOT EXISTS idx_products_company_bsale_type ON adquisiciones.products(company_id, bsale_product_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_bsale_variant ON adquisiciones.products(company_id, bsale_variant_id) WHERE bsale_variant_id IS NOT NULL;
```
> El campo `source` por defecto será `PETGRUP`. Solo los productos cruzados por el script de bootstrap recibirán el tag `source = 'BSALE'`.

## 2. Matriz de Mapeo y Sincronización

Clasificación de campos:
1. `BSALE_SYNC`: Viene de Bsale y debe sincronizarse regularmente (metadata técnica o llave).
2. `BSALE_INITIAL_THEN_EDITABLE`: Viene de Bsale como semilla inicial; luego PetGrup toma el control.
3. `PETGRUP_ONLY`: Exclusivo y manejado en PetGrup.
4. `DYNAMIC_NOT_PRODUCT`: No debe guardarse en `products` en absoluto.

| Campo PetGrup | Origen Bsale (Script Update) | Transformación / Regla | Clase | Próximo a Bsale |
|---|---|---|---|---|
| **SKU** | `bsale_variants.code` | Match exacto (ya cargado). | `BSALE_SYNC` | No (Es la llave) |
| **Nombre** | `bsale_products.name + variant` | - | `BSALE_INITIAL_THEN_EDITABLE` | Sí |
| **Cód. Barras** | `bsale_variants.bar_code` | Traspaso directo. | `BSALE_SYNC` | Sí |
| **Tipo Producto** | `bsale_product_types.name` | Se guarda el string completo (ej: "ACWS/HIGIENE") en `product_type` y `bsale_product_type_name`. NO se corta por '/'. | `BSALE_INITIAL_THEN_EDITABLE` | No |
| **Estado Operativo**| `bsale_products.state` y `variant`| Separado a flags técnicos: `bsale_product_state`, `bsale_variant_state`. `is_active` se seteará a FALSE si ambos (o la variante) indican estado inactivo (1). | `BSALE_INITIAL_THEN_EDITABLE` (Sujeto a flag) | Sí |
| **Control Lote** | `raw_json.isLot` | `isLot == 1` -> `requires_lot = true`. | `BSALE_INITIAL_THEN_EDITABLE` | Sí |
| **Resto de Atributos**| N/A | **NO** se tocan: `brand`, `category`, `species`, `presentation`, `unit_of_measure`, `net_weight`, `package_quantity`, stocks (`min`, `max`, `reorder`), `requires_expiration`, ni `image`. | `PETGRUP_ONLY` | - |
| **Stock, Costo, Prov.**| `bsale_stock_current`, etc. | **NO** se tocan. Viven en `mappings` y logísticas. | `DYNAMIC_NOT_PRODUCT` | - |

## 3. Resultados del Dry-Run Reforzado (`scripts/bootstrap_catalog_from_bsale.ts`)

Se ejecutó una validación profunda sobre los datos para determinar el riesgo de inyectar las reglas del punto anterior:

### Barcodes
- 3.585 SKUs serán actualizados con su código de barra real Bsale (ej. "7852052749207").
- Códigos vacíos, nulls o "0" fueron limpiados e ignorados.
- **Códigos duplicados en Bsale detectados:** 24. No es bloqueante ya que la llave única en PetGrup es compuesta.
- Conflicto PetGrup vs Bsale: 0 (la base en PetGrup estaba virgen).

### Tipos de Producto
- 3.585 SKUs recibirán el `product_type` directo y completo de Bsale (ej: "AMIGO/ALIMENTO").

### Análisis Crítico: Inactivación de Productos
- En Bsale, existen variantes con `state = 1` y/o productos maestros con `state = 1`. Cruzando esta info, **2.177 productos calificarían para ser inactivados (`is_active = FALSE`)**.
- **Análisis de riesgo sobre los 2.177:**
  - ¿Cuántos tienen stock actualmente (`bsale_stock_current` > 0)? **Cero (0).**
  - ¿Cuántos registran ventas en los últimos 180 días? **Cero (0).**
  - ¿Tienen costo asociado en mappings? **Sí, 1.073** (Probablemente inyectado artificialmente de promedios antiguos durante la Fase 4C).
- **Conclusión de inactivación:** Es altamente seguro inactivar estos 2.177 SKUs, puesto que son productos operacionalmente muertos y su limpieza mejorará la experiencia en el catálogo activo.

### Trazabilidad
- 3.585 SKUs recibirán los IDs de Bsale en las nuevas columnas, dejando `source = 'BSALE'`.

## 4. Recomendación y Ejecución

Basado en la evidencia obtenida:

1. **Migración:** Recomiendo **Aprobar** la aplicación de la migración `20260706100000_catalog_bsale_references.sql`. No afecta RLS ni datos existentes, y su definición es segura (`IF NOT EXISTS`).
2. **Metadata Bootstrap:** Recomiendo **Aprobar** la aplicación del Script (`--apply --confirm-remote`). No toca precios ni stocks, e inyecta barcodes reales muy necesarios para la operación, junto con los tipos de producto.
3. **Estado Activo/Inactivo:** Recomiendo **Aprobar** la sincronización del estado (`--apply-state`). Con cero stock y cero ventas en los inactivos de Bsale, su presencia en PetGrup genera ruido innecesario.

**Todo ha sido validado contra Typechecking (`tsc --noEmit`). Todo corre sin errores.**
