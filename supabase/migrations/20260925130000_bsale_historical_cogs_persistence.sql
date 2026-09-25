-- Persistencia de costos historicos oficiales observados en BSale.
-- Estas tablas son server-side y no contienen datos iniciales.

CREATE TABLE integraciones.bsale_document_costs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES core.companies(id),
    bsale_document_id   bigint NOT NULL CHECK (bsale_document_id > 0),
    total_cost          numeric(14,2),
    status              text NOT NULL CHECK (status IN (
        'OBSERVED',
        'MISSING',
        'AMBIGUOUS',
        'NOT_DISPATCHED',
        'ZERO_WITH_EVIDENCE'
    )),
    source              text NOT NULL DEFAULT 'BSALE_DOCUMENT_COSTS',
    observed_at         timestamptz NOT NULL,
    raw_json            jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_document_id),
    CHECK (total_cost IS NULL OR total_cost >= 0),
    CHECK (status <> 'OBSERVED' OR total_cost > 0),
    CHECK (status <> 'ZERO_WITH_EVIDENCE' OR total_cost = 0),
    CHECK (status IN ('MISSING', 'AMBIGUOUS', 'NOT_DISPATCHED') OR total_cost IS NOT NULL)
);

COMMENT ON TABLE integraciones.bsale_document_costs IS
    'Costo historico oficial observado desde BSale. No es costo promedio actual ni costo de recepcion.';
COMMENT ON COLUMN integraciones.bsale_document_costs.status IS
    'Clasificacion de disponibilidad/efecto contable; total_cost=0 no implica ZERO_WITH_EVIDENCE.';

CREATE INDEX idx_bsale_document_costs_company_status
    ON integraciones.bsale_document_costs(company_id, status);
CREATE INDEX idx_bsale_document_costs_observed_at
    ON integraciones.bsale_document_costs(company_id, observed_at DESC);

CREATE TABLE integraciones.bsale_document_cost_details (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    bsale_document_id       bigint NOT NULL CHECK (bsale_document_id > 0),
    cost_detail_key         text NOT NULL CHECK (length(trim(cost_detail_key)) > 0),
    bsale_shipping_detail_id bigint CHECK (bsale_shipping_detail_id IS NULL OR bsale_shipping_detail_id > 0),
    bsale_variant_id        bigint CHECK (bsale_variant_id IS NULL OR bsale_variant_id > 0),
    quantity                numeric(14,3),
    unit_cost               numeric(14,2),
    total_cost              numeric(14,2) NOT NULL CHECK (total_cost >= 0),
    raw_json                jsonb NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_document_id, cost_detail_key),
    CHECK (quantity IS NULL OR quantity >= 0),
    CHECK (unit_cost IS NULL OR unit_cost >= 0)
);

COMMENT ON TABLE integraciones.bsale_document_cost_details IS
    'Componentes de cost_detail de BSale. cost_detail_key usa shipping_detail.id cuando esta disponible.';

CREATE INDEX idx_bsale_document_cost_details_document
    ON integraciones.bsale_document_cost_details(company_id, bsale_document_id);
CREATE INDEX idx_bsale_document_cost_details_variant
    ON integraciones.bsale_document_cost_details(company_id, bsale_variant_id);

CREATE TABLE integraciones.bsale_credit_note_returns (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    bsale_credit_note_id    bigint NOT NULL CHECK (bsale_credit_note_id > 0),
    bsale_return_id         bigint NOT NULL CHECK (bsale_return_id > 0),
    referenced_document_id  bigint CHECK (referenced_document_id IS NULL OR referenced_document_id > 0),
    return_date              timestamptz,
    motive                  text,
    return_type             integer,
    amount                  numeric(14,2),
    price_adjustment        boolean,
    edit_texts              boolean,
    accounting_status       text NOT NULL DEFAULT 'AMBIGUOUS' CHECK (accounting_status IN (
        'OBSERVED',
        'MISSING',
        'AMBIGUOUS',
        'NOT_DISPATCHED',
        'ZERO_WITH_EVIDENCE'
    )),
    observed_at             timestamptz NOT NULL,
    raw_json                jsonb NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_return_id),
    UNIQUE (company_id, bsale_credit_note_id, bsale_return_id),
    CHECK (amount IS NULL OR amount >= 0)
);

COMMENT ON TABLE integraciones.bsale_credit_note_returns IS
    'Retornos oficiales de BSale asociados a notas de credito; no determina por si solo el asiento de COGS.';
COMMENT ON COLUMN integraciones.bsale_credit_note_returns.accounting_status IS
    'Estado de resolucion contable de la devolucion, separado de la existencia del retorno en BSale.';

CREATE INDEX idx_bsale_credit_note_returns_credit_note
    ON integraciones.bsale_credit_note_returns(company_id, bsale_credit_note_id);
CREATE INDEX idx_bsale_credit_note_returns_referenced_document
    ON integraciones.bsale_credit_note_returns(company_id, referenced_document_id);

CREATE TABLE integraciones.bsale_credit_note_return_details (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES core.companies(id),
    bsale_return_id         bigint NOT NULL CHECK (bsale_return_id > 0),
    bsale_return_detail_id  bigint NOT NULL CHECK (bsale_return_detail_id > 0),
    bsale_document_detail_id bigint CHECK (bsale_document_detail_id IS NULL OR bsale_document_detail_id > 0),
    bsale_variant_id        bigint CHECK (bsale_variant_id IS NULL OR bsale_variant_id > 0),
    quantity                numeric(14,3),
    quantity_dev_stock      numeric(14,3),
    variant_stock           numeric(14,3),
    variant_cost            numeric(14,2),
    raw_json                jsonb NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, bsale_return_id, bsale_return_detail_id),
    CHECK (quantity IS NULL OR quantity >= 0),
    CHECK (quantity_dev_stock IS NULL OR quantity_dev_stock >= 0),
    CHECK (variant_stock IS NULL OR variant_stock >= 0),
    CHECK (variant_cost IS NULL OR variant_cost >= 0)
);

COMMENT ON TABLE integraciones.bsale_credit_note_return_details IS
    'Detalles oficiales de returns. quantity_dev_stock y variant_cost se conservan sin inferir efecto contable.';

CREATE INDEX idx_bsale_credit_note_return_details_return
    ON integraciones.bsale_credit_note_return_details(company_id, bsale_return_id);
CREATE INDEX idx_bsale_credit_note_return_details_document_detail
    ON integraciones.bsale_credit_note_return_details(company_id, bsale_document_detail_id);

-- No se agregan FK a bsale_documents, bsale_document_details ni bsale_variants:
-- las respuestas oficiales pueden llegar antes que sus replicas documentales.
-- El vinculo se valida por company_id + IDs BSale en la capa server-side.
REVOKE ALL ON integraciones.bsale_document_costs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_document_cost_details FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_credit_note_returns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON integraciones.bsale_credit_note_return_details FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_document_costs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_document_cost_details TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_credit_note_returns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON integraciones.bsale_credit_note_return_details TO service_role;
