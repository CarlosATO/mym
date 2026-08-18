-- Flujo de revisión de incidencias de códigos de barras (V1) — Modelo.
--
-- 1. inventarios.product_barcode_aliases: tabla de asociación oficial aprobada
--    por ERP entre un barcode y un producto. NO se sobrescribe
--    snapshot_products.barcode ni integraciones.bsale_variants.bar_code.
--
--    Regla crítica: un barcode activo no puede pertenecer a dos productos dentro
--    de la misma company. Se garantiza con índice único parcial
--    (company_id, barcode) WHERE is_active = true. Un producto puede tener
--    varios barcodes activos.
--
-- 2. product_barcode_proposals.review_reason_code: motivo tipificado de rechazo.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE TABLE IF NOT EXISTS inventarios.product_barcode_aliases (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    barcode text NOT NULL,
    bsale_variant_id integer NULL,
    product_id uuid NULL,
    source text NOT NULL DEFAULT 'ADMIN_REVIEW',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL,
    reviewed_at timestamptz NULL,
    reviewed_by uuid NULL,
    CONSTRAINT product_barcode_aliases_pkey PRIMARY KEY (id),
    CONSTRAINT uq_inventarios_barcode_aliases_company_id UNIQUE (company_id, id),
    CONSTRAINT chk_inventarios_barcode_aliases_barcode CHECK (length(btrim(barcode)) > 0),
    CONSTRAINT chk_inventarios_barcode_aliases_source CHECK (source IN ('ADMIN_REVIEW','MOBILE')),
    CONSTRAINT product_barcode_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES core.companies(id) ON DELETE RESTRICT,
    CONSTRAINT product_barcode_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT product_barcode_aliases_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES portal.users(id) ON DELETE RESTRICT
);

COMMENT ON TABLE inventarios.product_barcode_aliases
    IS 'Asociación oficial barcode-producto aprobada por ERP (revisión de incidencias de códigos).';

-- Un barcode activo por producto por company.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventarios_barcode_aliases_active
    ON inventarios.product_barcode_aliases (company_id, barcode)
    WHERE is_active = true;

-- Índice de búsqueda por producto.
CREATE INDEX IF NOT EXISTS idx_inventarios_barcode_aliases_product
    ON inventarios.product_barcode_aliases (company_id, bsale_variant_id)
    WHERE is_active = true;

ALTER TABLE inventarios.product_barcode_proposals
    ADD COLUMN IF NOT EXISTS review_reason_code text;

ALTER TABLE inventarios.product_barcode_proposals
    ADD CONSTRAINT chk_inventarios_barcode_proposals_reason_code
        CHECK (review_reason_code IS NULL OR review_reason_code IN (
            'CODE_NOT_MATCH_PRODUCT','PHOTO_INVALID','LABEL_OTHER_PRODUCT',
            'INTERNAL_NOT_REUSABLE','OTHER'));

COMMENT ON COLUMN inventarios.product_barcode_proposals.review_reason_code
    IS 'Motivo tipificado de rechazo (whitelist de negocio).';

COMMIT;
