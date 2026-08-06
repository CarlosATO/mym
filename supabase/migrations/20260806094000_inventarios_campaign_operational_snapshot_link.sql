-- 4I.3C.7C.2A: soporte fisico para snapshots operacionales de campana.
-- A) campaign_snapshot_id en operational_snapshots conecta la jornada con el
--    snapshot maestro de la campana; NULL representa una jornada legacy o
--    independiente (fuera de campana).
-- B) bsale_variant_id en snapshot_products pasa a opcional: es solo
--    trazabilidad externa, no constituye identidad (la identidad es product_id).

-- A. VINCULO DE JORNADA CON EL SNAPSHOT MAESTRO DE LA CAMPANA

ALTER TABLE inventarios.operational_snapshots
    ADD COLUMN campaign_snapshot_id uuid;

ALTER TABLE inventarios.operational_snapshots
    ADD CONSTRAINT fk_inventarios_snapshots_campaign_snapshot
        FOREIGN KEY (company_id, campaign_snapshot_id)
        REFERENCES inventarios.inventory_campaign_snapshots(company_id, id)
        ON DELETE RESTRICT;

CREATE INDEX idx_inventarios_snapshots_campaign_snapshot
    ON inventarios.operational_snapshots (company_id, campaign_snapshot_id);

-- B. bsale_variant_id OPCIONAL EN PRODUCTOS DEL SNAPSHOT OPERACIONAL

ALTER TABLE inventarios.snapshot_products
    ALTER COLUMN bsale_variant_id DROP NOT NULL;
