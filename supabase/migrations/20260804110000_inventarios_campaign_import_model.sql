-- Migration: 20260804110000_inventarios_campaign_import_model.sql
-- Description: Fase 4I.3C.1. Modelo fisico aditivo para importacion unica por
--              campana: stock_imports gana campaign_id, theoretical_scope y
--              consumed_campaign_id (modality pasa a opcional); stock_import_rows
--              gana entered_site_code, resolved_inventory_site_id y
--              entered_location_code. Sin cambio funcional.
-- Author: Assistant

-- ============================================================
-- 1. CABECERA: PROPIEDAD DE CAMPANA
-- ============================================================

-- Propiedad canonica de la importacion maestra por campana.
-- NULL = modelo legacy por sitio (una importacion por unidad).
ALTER TABLE inventarios.stock_imports ADD COLUMN campaign_id uuid;

-- Nivel del stock teorico del Excel maestro.
-- NULL = modelo legacy por sitio.
ALTER TABLE inventarios.stock_imports ADD COLUMN theoretical_scope text;

-- Consumo oficial de la importacion por una campana (fase posterior).
-- NULL = sin consumo por campana.
ALTER TABLE inventarios.stock_imports ADD COLUMN consumed_campaign_id uuid;

-- modality solo aplica a importaciones legacy por sitio; el modelo por
-- campana usa theoretical_scope. Se relaja el NOT NULL sin tocar registros.
ALTER TABLE inventarios.stock_imports ALTER COLUMN modality DROP NOT NULL;

ALTER TABLE inventarios.stock_imports
    DROP CONSTRAINT chk_inventarios_stock_imports_modality;

ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_modality
    CHECK (modality IS NULL OR modality IN ('GENERAL', 'POR_UBICACION'));

-- Valores permitidos del alcance teorico (GENERAL no se reutiliza)
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_theoretical_scope
    CHECK (theoretical_scope IS NULL OR theoretical_scope IN ('TOTAL_CAMPAIGN', 'BY_SITE', 'BY_LOCATION'));

-- Marca de modelo: importacion por campana o legacy por sitio, nunca ambas.
-- Legacy: campaign_id IS NULL AND theoretical_scope IS NULL.
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_campaign_scope
    CHECK ((campaign_id IS NULL) = (theoretical_scope IS NULL));

-- Consumo por sesion (legacy) o por campana, nunca ambos
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_consumption_exclusive
    CHECK (consumed_session_id IS NULL OR consumed_campaign_id IS NULL);

-- El consumo por campana exige estado CONSUMED (espejo del contrato legacy)
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_consumed_campaign_status
    CHECK (consumed_campaign_id IS NULL OR status = 'CONSUMED');

-- Una importacion solo puede ser consumida por su propia campana
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT chk_inventarios_stock_imports_consumed_campaign_matches
    CHECK (consumed_campaign_id IS NULL OR consumed_campaign_id = campaign_id);

-- Relaciones canonicas importacion -> campana (misma empresa)
ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT fk_inventarios_stock_imports_campaign
    FOREIGN KEY (company_id, campaign_id)
    REFERENCES inventarios.inventory_campaigns(company_id, id)
    ON DELETE RESTRICT;

ALTER TABLE inventarios.stock_imports
    ADD CONSTRAINT fk_inventarios_stock_imports_consumed_campaign
    FOREIGN KEY (company_id, consumed_campaign_id)
    REFERENCES inventarios.inventory_campaigns(company_id, id)
    ON DELETE RESTRICT;

-- Regla de importacion oficial unica: a lo sumo una importacion consumida
-- por campana. Los intentos DRAFT/REJECTED/VALIDATED no oficiales conviven.
CREATE UNIQUE INDEX uq_inventarios_stock_imports_consumed_campaign
    ON inventarios.stock_imports (company_id, campaign_id)
    WHERE consumed_campaign_id IS NOT NULL;

-- Idempotencia de archivos por campana (el indice legacy por sitio se
-- conserva intacto para las importaciones existentes)
CREATE UNIQUE INDEX uq_inventarios_stock_imports_campaign_idempotency
    ON inventarios.stock_imports (company_id, campaign_id, theoretical_scope, cutoff_at, file_sha256)
    WHERE file_sha256 IS NOT NULL AND status <> 'CONSUMED' AND campaign_id IS NOT NULL;

CREATE INDEX idx_inventarios_stock_imports_campaign
    ON inventarios.stock_imports (company_id, campaign_id, status);

-- ============================================================
-- 2. FILAS: REFERENCIA RAW Y RESOLUCION POR UNIDAD
-- ============================================================

-- Codigo de unidad informado en el Excel (BY_SITE) para auditoria y
-- revalidacion. La identidad canonica resuelta va en resolved_inventory_site_id.
ALTER TABLE inventarios.stock_import_rows ADD COLUMN entered_site_code text;

-- Unidad resuelta para filas BY_SITE (canonica de Inventarios).
ALTER TABLE inventarios.stock_import_rows ADD COLUMN resolved_inventory_site_id uuid;

-- Codigo de ubicacion informado en el Excel (BY_LOCATION) para auditoria y
-- revalidacion. La identidad canonica resuelta es inventory_site_location_id
-- (existente); inventory_site_id sigue siendo la unidad derivada.
ALTER TABLE inventarios.stock_import_rows ADD COLUMN entered_location_code text;

ALTER TABLE inventarios.stock_import_rows
    ADD CONSTRAINT fk_inventarios_stock_import_rows_resolved_site
    FOREIGN KEY (company_id, resolved_inventory_site_id)
    REFERENCES inventarios.inventory_sites(company_id, id)
    ON DELETE RESTRICT;

CREATE INDEX idx_inventarios_stock_import_rows_resolved_site
    ON inventarios.stock_import_rows (company_id, resolved_inventory_site_id);
