-- Modelo oficial de Stock Teórico Global del Inventario (V1).
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
--
-- 1. inventory_campaign_theoretical_stocks pasa a ser la fotografía oficial
--    congelada del stock teórico global del Inventario:
--      * unit_cost        : costo congelado del Excel (para valorización).
--      * source_import_id : import de origen (stock_imports) que dio origen.
--    (sku/bsale_variant_id/name/barcode viven en
--    inventory_campaign_snapshot_products; no se duplican.)
--
-- 2. Guarda de identidad canónica por bsale_variant_id dentro de un mismo
--    snapshot de campaña: un producto de un Inventario solo puede aparecer
--    una vez (evita duplicados de identidad para la consolidación).
--
-- 3. CHECK de coherencia: source_import_id solo se acepta cuando existe un
--    campaign_snapshot_id (una fotografía no puede ser de un import ajeno).

BEGIN;

ALTER TABLE inventarios.inventory_campaign_theoretical_stocks
    ADD COLUMN IF NOT EXISTS unit_cost numeric(14, 3),
    ADD COLUMN IF NOT EXISTS source_import_id uuid;

ALTER TABLE inventarios.inventory_campaign_theoretical_stocks
    ADD CONSTRAINT chk_inventarios_campaign_theoretical_cost
        CHECK (unit_cost IS NULL OR unit_cost >= 0);

COMMENT ON COLUMN inventarios.inventory_campaign_theoretical_stocks.unit_cost
    IS 'Costo unitario congelado del stock teorico oficial (CLP). NULL si el import no lo provee.';
COMMENT ON COLUMN inventarios.inventory_campaign_theoretical_stocks.source_import_id
    IS 'Import de stock que origino esta fila de stock teorico oficial (stock_imports).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventarios_campaign_snapshot_products_variant
    ON inventarios.inventory_campaign_snapshot_products (company_id, campaign_snapshot_id, bsale_variant_id)
    WHERE bsale_variant_id IS NOT NULL;

COMMIT;
