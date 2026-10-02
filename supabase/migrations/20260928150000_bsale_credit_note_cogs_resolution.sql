-- Resolucion semantica de COGS para notas de credito.
-- Separada de la disponibilidad tecnica de bsale_document_costs.

CREATE TABLE integraciones.bsale_credit_note_cogs_resolutions (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                 uuid NOT NULL REFERENCES core.companies(id),
    bsale_credit_note_id       bigint NOT NULL CHECK (bsale_credit_note_id > 0),
    bsale_return_id             bigint CHECK (bsale_return_id IS NULL OR bsale_return_id > 0),
    bsale_reference_document_id bigint CHECK (bsale_reference_document_id IS NULL OR bsale_reference_document_id > 0),
    resolution_status           text NOT NULL CHECK (resolution_status IN (
        'RESOLVED_PHYSICAL_RETURN',
        'RESOLVED_PRICE_ADJUSTMENT',
        'RESOLVED_NO_STOCK_REENTRY',
        'RESOLVED_MIXED',
        'MISSING_RETURN',
        'MISSING_REFERENCE',
        'AMBIGUOUS'
    )),
    reversal_cogs                numeric(14,2) NOT NULL DEFAULT 0 CHECK (reversal_cogs >= 0),
    evidence                     jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_at                  timestamptz NOT NULL,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_credit_note_id)
);

COMMENT ON TABLE integraciones.bsale_credit_note_cogs_resolutions IS
    'Resolucion semantica de efecto COGS de una nota de credito; no reemplaza el status tecnico del retorno o document cost.';
COMMENT ON COLUMN integraciones.bsale_credit_note_cogs_resolutions.reversal_cogs IS
    'Magnitud positiva calculada solo desde quantity_dev_stock por linea fisica. El signo contable se aplica posteriormente.';

CREATE INDEX idx_bsale_credit_note_cogs_resolution_status
    ON integraciones.bsale_credit_note_cogs_resolutions(company_id, resolution_status);
CREATE INDEX idx_bsale_credit_note_cogs_resolution_reference
    ON integraciones.bsale_credit_note_cogs_resolutions(company_id, bsale_reference_document_id);

CREATE TABLE integraciones.bsale_credit_note_cogs_resolution_details (
    id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                 uuid NOT NULL REFERENCES core.companies(id),
    bsale_credit_note_id       bigint NOT NULL CHECK (bsale_credit_note_id > 0),
    bsale_return_id             bigint NOT NULL CHECK (bsale_return_id > 0),
    bsale_return_detail_id      bigint NOT NULL CHECK (bsale_return_detail_id > 0),
    bsale_document_detail_id    bigint CHECK (bsale_document_detail_id IS NULL OR bsale_document_detail_id > 0),
    quantity                    numeric(14,3),
    quantity_dev_stock           numeric(14,3),
    variant_cost                 numeric(14,2),
    reversal_cogs                numeric(14,2) NOT NULL DEFAULT 0 CHECK (reversal_cogs >= 0),
    semantic_status              text NOT NULL CHECK (semantic_status IN (
        'RESOLVED_PHYSICAL_RETURN',
        'RESOLVED_PRICE_ADJUSTMENT',
        'RESOLVED_NO_STOCK_REENTRY',
        'AMBIGUOUS'
    )),
    evidence                     jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_at                  timestamptz NOT NULL,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_credit_note_id, bsale_return_id, bsale_return_detail_id)
);

COMMENT ON TABLE integraciones.bsale_credit_note_cogs_resolution_details IS
    'Resolucion de COGS a nivel de return detail. quantity_dev_stock es la unica cantidad admitida para reversal.';

CREATE INDEX idx_bsale_credit_note_cogs_resolution_details_note
    ON integraciones.bsale_credit_note_cogs_resolution_details(company_id, bsale_credit_note_id);
CREATE INDEX idx_bsale_credit_note_cogs_resolution_details_return
    ON integraciones.bsale_credit_note_cogs_resolution_details(company_id, bsale_return_id);
CREATE INDEX idx_bsale_credit_note_cogs_resolution_details_document_detail
    ON integraciones.bsale_credit_note_cogs_resolution_details(company_id, bsale_document_detail_id);

REVOKE ALL ON integraciones.bsale_credit_note_cogs_resolutions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_credit_note_cogs_resolution_details FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_credit_note_cogs_resolutions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_credit_note_cogs_resolution_details TO service_role;
