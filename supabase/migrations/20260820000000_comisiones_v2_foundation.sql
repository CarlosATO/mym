-- COMV2-02: isolated Comisiones V2 foundation.
-- This migration intentionally does not read, copy, alter, or lock legacy
-- commission objects.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS comisiones;

CREATE TABLE comisiones.settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    currency_code char(3) NOT NULL DEFAULT 'CLP',
    base_amount_type text NOT NULL DEFAULT 'NET',
    requires_full_payment boolean NOT NULL DEFAULT true,
    first_eligible_full_payment_date date,
    active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_settings_company UNIQUE (company_id),
    CONSTRAINT chk_comisiones_settings_currency CHECK (currency_code ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_comisiones_settings_base_amount CHECK (base_amount_type = 'NET'),
    CONSTRAINT chk_comisiones_settings_full_payment CHECK (requires_full_payment),
    CONSTRAINT chk_comisiones_settings_cutover CHECK (NOT active OR first_eligible_full_payment_date IS NOT NULL)
);

CREATE TABLE comisiones.seller_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    seller_bsale_id bigint NOT NULL,
    seller_name text NOT NULL,
    is_commissionable boolean NOT NULL DEFAULT false,
    seller_type text NOT NULL DEFAULT 'OTHER',
    active boolean NOT NULL DEFAULT true,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_seller_profiles_company_seller UNIQUE (company_id, seller_bsale_id),
    CONSTRAINT chk_comisiones_seller_profiles_seller_id CHECK (seller_bsale_id > 0),
    CONSTRAINT chk_comisiones_seller_profiles_type CHECK (seller_type IN ('FIELD', 'ADMIN', 'MANAGEMENT', 'DISPATCH', 'OTHER')),
    CONSTRAINT uq_comisiones_seller_profiles_company_id_id UNIQUE (company_id, id)
);

CREATE TABLE comisiones.commission_plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    supplier_id uuid NOT NULL REFERENCES adquisiciones.suppliers(id) ON DELETE RESTRICT,
    plan_code text NOT NULL,
    version_no integer NOT NULL,
    plan_type text NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    status text NOT NULL DEFAULT 'DRAFT',
    active boolean NOT NULL DEFAULT false,
    supersedes_plan_id uuid REFERENCES comisiones.commission_plans(id) ON DELETE RESTRICT,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_plans_company_code_version UNIQUE (company_id, plan_code, version_no),
    CONSTRAINT uq_comisiones_plans_company_id_id UNIQUE (company_id, id),
    CONSTRAINT chk_comisiones_plans_version CHECK (version_no > 0),
    CONSTRAINT chk_comisiones_plans_type CHECK (plan_type IN ('FAMILY_FIXED_PERCENT', 'SUPPLIER_SALES_TARGET')),
    CONSTRAINT chk_comisiones_plans_status CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED')),
    CONSTRAINT chk_comisiones_plans_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT chk_comisiones_plans_active_status CHECK (active = (status = 'ACTIVE'))
);

-- A supplier has at most one active base plan for any overlapping date range.
ALTER TABLE comisiones.commission_plans
    ADD CONSTRAINT ex_comisiones_plans_active_supplier_period
    EXCLUDE USING gist (
        company_id WITH =,
        supplier_id WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&
    ) WHERE (active);

CREATE TABLE comisiones.commission_plan_family_rates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    family_bsale_product_type_id integer NOT NULL,
    family_name_snapshot text NOT NULL,
    percentage numeric(7,4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_plan_family_rates_plan FOREIGN KEY (company_id, plan_id)
        REFERENCES comisiones.commission_plans(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_plan_family_rates_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_comisiones_plan_family_rates_plan_family UNIQUE (company_id, plan_id, family_bsale_product_type_id),
    CONSTRAINT chk_comisiones_plan_family_rates_family_id CHECK (family_bsale_product_type_id > 0),
    CONSTRAINT chk_comisiones_plan_family_rates_percentage CHECK (percentage >= 0 AND percentage <= 100)
);

CREATE TABLE comisiones.commission_plan_tiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    tier_order smallint NOT NULL,
    lower_bound numeric(18,2) NOT NULL,
    upper_bound numeric(18,2),
    percentage numeric(7,4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_plan_tiers_plan FOREIGN KEY (company_id, plan_id)
        REFERENCES comisiones.commission_plans(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_plan_tiers_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_comisiones_plan_tiers_plan_order UNIQUE (company_id, plan_id, tier_order),
    CONSTRAINT chk_comisiones_plan_tiers_order CHECK (tier_order > 0),
    CONSTRAINT chk_comisiones_plan_tiers_bounds CHECK (lower_bound >= 0 AND (upper_bound IS NULL OR upper_bound >= lower_bound)),
    CONSTRAINT chk_comisiones_plan_tiers_percentage CHECK (percentage >= 0 AND percentage <= 100)
);

CREATE TABLE comisiones.commission_plan_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    family_bsale_product_type_id integer,
    percentage numeric(7,4) NOT NULL,
    justification text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_plan_exceptions_plan FOREIGN KEY (company_id, plan_id)
        REFERENCES comisiones.commission_plans(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_plan_exceptions_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_comisiones_plan_exceptions_plan_variant UNIQUE (company_id, plan_id, bsale_variant_id),
    CONSTRAINT chk_comisiones_plan_exceptions_variant_id CHECK (bsale_variant_id > 0),
    CONSTRAINT chk_comisiones_plan_exceptions_family_id CHECK (family_bsale_product_type_id IS NULL OR family_bsale_product_type_id > 0),
    CONSTRAINT chk_comisiones_plan_exceptions_percentage CHECK (percentage >= 0 AND percentage <= 100),
    CONSTRAINT chk_comisiones_plan_exceptions_justification CHECK (btrim(justification) <> '')
);

CREATE TABLE comisiones.settlement_sequences (
    company_id uuid PRIMARY KEY REFERENCES core.companies(id) ON DELETE CASCADE,
    last_settlement_number bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_comisiones_sequences_last_number CHECK (last_settlement_number >= 0)
);

CREATE TABLE comisiones.settlements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_number bigint,
    settlement_code text NOT NULL,
    seller_profile_id uuid,
    seller_bsale_id bigint NOT NULL,
    seller_name_snapshot text NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    payment_cutoff_date date NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    settlement_kind text NOT NULL DEFAULT 'NORMAL',
    adjusts_settlement_id uuid,
    total_net_amount numeric(18,2) NOT NULL DEFAULT 0,
    total_commission_amount numeric(18,2) NOT NULL DEFAULT 0,
    issued_at timestamptz,
    issued_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancellation_reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_settlements_company_code UNIQUE (company_id, settlement_code),
    CONSTRAINT uq_comisiones_settlements_company_id_id UNIQUE (company_id, id),
    CONSTRAINT chk_comisiones_settlements_number CHECK (settlement_number IS NULL OR settlement_number > 0),
    CONSTRAINT chk_comisiones_settlements_seller_id CHECK (seller_bsale_id > 0),
    CONSTRAINT chk_comisiones_settlements_dates CHECK (period_to >= period_from),
    CONSTRAINT chk_comisiones_settlements_status CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED')),
    CONSTRAINT chk_comisiones_settlements_kind CHECK (settlement_kind IN ('NORMAL', 'ADJUSTMENT')),
    CONSTRAINT chk_comisiones_settlements_adjustment_shape CHECK (
        (settlement_kind = 'NORMAL' AND adjusts_settlement_id IS NULL)
        OR (settlement_kind = 'ADJUSTMENT' AND adjusts_settlement_id IS NOT NULL)
    ),
    CONSTRAINT chk_comisiones_settlements_totals CHECK (total_net_amount >= 0 OR settlement_kind = 'ADJUSTMENT'),
    CONSTRAINT chk_comisiones_settlements_commission_total CHECK (total_commission_amount >= 0 OR settlement_kind = 'ADJUSTMENT'),
    CONSTRAINT fk_comisiones_settlements_adjusts FOREIGN KEY (company_id, adjusts_settlement_id)
        REFERENCES comisiones.settlements(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlements_seller_profile FOREIGN KEY (company_id, seller_profile_id)
        REFERENCES comisiones.seller_profiles(company_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_comisiones_settlements_normal_draft_seller_period
    ON comisiones.settlements(company_id, seller_bsale_id, period_from, period_to)
    WHERE status = 'DRAFT' AND settlement_kind = 'NORMAL';

CREATE TABLE comisiones.settlement_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL,
    line_kind text NOT NULL,
    source_document_bsale_id integer NOT NULL,
    source_document_number bigint,
    source_document_type_id integer,
    source_document_line_id uuid,
    source_document_detail_bsale_id integer,
    original_invoice_bsale_id integer,
    original_invoice_line_id uuid,
    original_invoice_detail_bsale_id integer,
    bsale_variant_id integer,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE SET NULL,
    sku_snapshot text,
    description_snapshot text,
    quantity numeric(18,3) NOT NULL DEFAULT 0,
    net_amount numeric(18,2) NOT NULL DEFAULT 0,
    bsale_brand_id integer,
    brand_name_snapshot text,
    real_supplier_id uuid REFERENCES adquisiciones.suppliers(id) ON DELETE RESTRICT,
    real_supplier_name_snapshot text,
    family_bsale_product_type_id integer,
    family_name_snapshot text,
    seller_bsale_id bigint NOT NULL,
    seller_name_snapshot text NOT NULL,
    client_bsale_id bigint,
    customer_id uuid,
    customer_name_snapshot text,
    plan_id uuid,
    plan_version_no integer,
    plan_type text,
    family_rate_id uuid,
    tier_id uuid,
    tier_lower_bound numeric(18,2),
    tier_upper_bound numeric(18,2),
    percentage numeric(7,4),
    base_amount numeric(18,2) NOT NULL DEFAULT 0,
    commission_amount numeric(18,2) NOT NULL DEFAULT 0,
    currency_code char(3) NOT NULL DEFAULT 'CLP',
    document_emission_date date,
    full_payment_date date,
    credit_note_date date,
    calculated_at timestamptz,
    issued_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_comisiones_settlement_lines_settlement FOREIGN KEY (company_id, settlement_id)
        REFERENCES comisiones.settlements(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_plan FOREIGN KEY (company_id, plan_id)
        REFERENCES comisiones.commission_plans(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_family_rate FOREIGN KEY (company_id, family_rate_id)
        REFERENCES comisiones.commission_plan_family_rates(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_tier FOREIGN KEY (company_id, tier_id)
        REFERENCES comisiones.commission_plan_tiers(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_source_document FOREIGN KEY (company_id, source_document_bsale_id)
        REFERENCES integraciones.bsale_documents(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_source_detail FOREIGN KEY (company_id, source_document_detail_bsale_id)
        REFERENCES integraciones.bsale_document_details(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_source_line FOREIGN KEY (source_document_line_id)
        REFERENCES integraciones.bsale_document_details(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_settlement_lines_original_line FOREIGN KEY (original_invoice_line_id)
        REFERENCES integraciones.bsale_document_details(id) ON DELETE RESTRICT,
    CONSTRAINT chk_comisiones_settlement_lines_kind CHECK (line_kind IN ('INVOICE', 'CREDIT_NOTE')),
    CONSTRAINT chk_comisiones_settlement_lines_document_ids CHECK (source_document_bsale_id > 0 AND (source_document_detail_bsale_id IS NULL OR source_document_detail_bsale_id > 0)),
    CONSTRAINT chk_comisiones_settlement_lines_variant_id CHECK (bsale_variant_id IS NULL OR bsale_variant_id > 0),
    CONSTRAINT chk_comisiones_settlement_lines_numeric CHECK (quantity >= 0 AND (percentage IS NULL OR (percentage >= 0 AND percentage <= 100))),
    CONSTRAINT chk_comisiones_settlement_lines_shape CHECK (
        (line_kind = 'INVOICE'
            AND net_amount >= 0 AND base_amount >= 0 AND commission_amount >= 0
            AND original_invoice_bsale_id IS NULL AND original_invoice_line_id IS NULL)
        OR (line_kind = 'CREDIT_NOTE'
            AND source_document_line_id IS NOT NULL
            AND original_invoice_bsale_id IS NOT NULL
            AND original_invoice_line_id IS NOT NULL
            AND net_amount <= 0 AND base_amount <= 0 AND commission_amount <= 0)
    ),
    CONSTRAINT chk_comisiones_settlement_lines_date_order CHECK (
        (document_emission_date IS NULL OR full_payment_date IS NULL OR full_payment_date >= document_emission_date)
        AND (credit_note_date IS NULL OR document_emission_date IS NULL OR credit_note_date >= document_emission_date)
    )
);
ALTER TABLE comisiones.settlement_lines
    ADD CONSTRAINT uq_comisiones_settlement_lines_company_id UNIQUE (company_id, id);

CREATE TABLE comisiones.line_locks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL,
    settlement_line_id uuid NOT NULL,
    source_document_line_id uuid NOT NULL REFERENCES integraciones.bsale_document_details(id) ON DELETE RESTRICT,
    source_document_detail_bsale_id integer NOT NULL,
    line_kind text NOT NULL,
    lock_kind text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE',
    reserved_at timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz,
    consumed_at timestamptz,
    reason text,
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_line_locks_settlement FOREIGN KEY (company_id, settlement_id)
        REFERENCES comisiones.settlements(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_line_locks_line FOREIGN KEY (settlement_line_id)
        REFERENCES comisiones.settlement_lines(id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_line_locks_source_detail FOREIGN KEY (company_id, source_document_detail_bsale_id)
        REFERENCES integraciones.bsale_document_details(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT chk_comisiones_line_locks_detail_id CHECK (source_document_detail_bsale_id > 0),
    CONSTRAINT chk_comisiones_line_locks_kind CHECK (line_kind IN ('INVOICE', 'CREDIT_NOTE')),
    CONSTRAINT chk_comisiones_line_locks_lock_kind CHECK (lock_kind IN ('RESERVATION', 'DEFINITIVE')),
    CONSTRAINT chk_comisiones_line_locks_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED')),
    CONSTRAINT chk_comisiones_line_locks_timestamps CHECK (
        (status = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
        OR (status = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
        OR (status = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
    )
);

CREATE TABLE comisiones.credit_note_adjustments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    credit_note_bsale_id integer NOT NULL,
    credit_note_line_id uuid NOT NULL REFERENCES integraciones.bsale_document_details(id) ON DELETE RESTRICT,
    credit_note_detail_bsale_id integer NOT NULL,
    original_invoice_bsale_id integer NOT NULL,
    original_invoice_line_id uuid NOT NULL REFERENCES integraciones.bsale_document_details(id) ON DELETE RESTRICT,
    original_invoice_detail_bsale_id integer,
    related_variant_id integer,
    pre_issue_settlement_id uuid,
    post_issue_adjustment_id uuid,
    original_settlement_line_id uuid,
    status text NOT NULL DEFAULT 'PENDING',
    original_net_amount numeric(18,2) NOT NULL,
    adjusted_net_amount numeric(18,2) NOT NULL,
    original_commission_amount numeric(18,2) NOT NULL,
    adjusted_commission_amount numeric(18,2) NOT NULL,
    reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_comisiones_credit_note_adjustments_company_line UNIQUE (company_id, credit_note_line_id),
    CONSTRAINT chk_comisiones_credit_note_adjustments_ids CHECK (
        credit_note_bsale_id > 0 AND credit_note_detail_bsale_id > 0 AND original_invoice_bsale_id > 0
        AND (original_invoice_detail_bsale_id IS NULL OR original_invoice_detail_bsale_id > 0)
        AND (related_variant_id IS NULL OR related_variant_id > 0)
    ),
    CONSTRAINT chk_comisiones_credit_note_adjustments_status CHECK (status IN ('PENDING', 'APPLIED', 'CANCELLED')),
    CONSTRAINT chk_comisiones_credit_note_adjustments_amounts CHECK (
        original_net_amount >= 0 AND adjusted_net_amount >= 0 AND adjusted_net_amount <= original_net_amount
        AND original_commission_amount >= 0 AND adjusted_commission_amount >= 0
        AND adjusted_commission_amount <= original_commission_amount
    ),
    CONSTRAINT fk_comisiones_credit_note_document FOREIGN KEY (company_id, credit_note_bsale_id)
        REFERENCES integraciones.bsale_documents(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_detail FOREIGN KEY (company_id, credit_note_detail_bsale_id)
        REFERENCES integraciones.bsale_document_details(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_original_document FOREIGN KEY (company_id, original_invoice_bsale_id)
        REFERENCES integraciones.bsale_documents(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_original_detail FOREIGN KEY (company_id, original_invoice_detail_bsale_id)
        REFERENCES integraciones.bsale_document_details(company_id, bsale_id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_pre_issue FOREIGN KEY (company_id, pre_issue_settlement_id)
        REFERENCES comisiones.settlements(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_post_issue FOREIGN KEY (company_id, post_issue_adjustment_id)
        REFERENCES comisiones.settlements(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_comisiones_credit_note_original_line FOREIGN KEY (original_settlement_line_id)
        REFERENCES comisiones.settlement_lines(id) ON DELETE RESTRICT
);

CREATE TABLE comisiones.audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    event_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    before_data jsonb,
    after_data jsonb,
    reason text,
    request_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_comisiones_seller_profiles_company_status
    ON comisiones.seller_profiles(company_id, active, is_commissionable);
CREATE INDEX idx_comisiones_plans_company_supplier_dates
    ON comisiones.commission_plans(company_id, supplier_id, active, valid_from, valid_to);
CREATE INDEX idx_comisiones_plan_family_rates_plan
    ON comisiones.commission_plan_family_rates(company_id, plan_id);
CREATE INDEX idx_comisiones_plan_tiers_plan
    ON comisiones.commission_plan_tiers(company_id, plan_id, tier_order);
CREATE INDEX idx_comisiones_plan_exceptions_plan
    ON comisiones.commission_plan_exceptions(company_id, plan_id, active);
CREATE INDEX idx_comisiones_settlements_company_seller_period
    ON comisiones.settlements(company_id, seller_bsale_id, period_to DESC);
CREATE INDEX idx_comisiones_settlement_lines_settlement
    ON comisiones.settlement_lines(company_id, settlement_id);
CREATE INDEX idx_comisiones_settlement_lines_source
    ON comisiones.settlement_lines(company_id, source_document_bsale_id, source_document_detail_bsale_id);
CREATE INDEX idx_comisiones_settlement_lines_supplier
    ON comisiones.settlement_lines(company_id, real_supplier_id);
CREATE INDEX idx_comisiones_line_locks_status
    ON comisiones.line_locks(company_id, status, source_document_line_id);
CREATE UNIQUE INDEX uq_comisiones_line_locks_active_line
    ON comisiones.line_locks(company_id, source_document_line_id)
    WHERE status = 'ACTIVE';
CREATE INDEX idx_comisiones_credit_note_adjustments_original
    ON comisiones.credit_note_adjustments(company_id, original_invoice_line_id, status);
CREATE INDEX idx_comisiones_audit_events_entity
    ON comisiones.audit_events(company_id, entity_type, entity_id, created_at DESC);

COMMENT ON COLUMN comisiones.settings.first_eligible_full_payment_date IS
    'First eligible V2 day. Nullable while settings are inactive; activation requires an explicit cutover.';
COMMENT ON TABLE comisiones.commission_plans IS
    'Supplier REAL eligibility and publication validation are enforced by the later plan workflow.';
COMMENT ON TABLE comisiones.credit_note_adjustments IS
    'Per-row and deferred cumulative caps prevent applied adjustments from exceeding the original snapshot.';
COMMENT ON TABLE comisiones.audit_events IS 'Append-only V2 audit contract.';

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'settings', 'seller_profiles', 'commission_plans',
        'commission_plan_family_rates', 'commission_plan_tiers',
        'commission_plan_exceptions', 'settlement_sequences', 'settlements',
        'settlement_lines', 'line_locks', 'credit_note_adjustments', 'audit_events'
    ] LOOP
        EXECUTE format('ALTER TABLE comisiones.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE format('REVOKE ALL ON TABLE comisiones.%I FROM PUBLIC, anon', v_table);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE comisiones.%I TO authenticated', v_table);
        EXECUTE format('GRANT ALL ON TABLE comisiones.%I TO service_role', v_table);
        EXECUTE format('DROP POLICY IF EXISTS comisiones_v2_read ON comisiones.%I', v_table);
        EXECUTE format('CREATE POLICY comisiones_v2_read ON comisiones.%I FOR SELECT TO authenticated USING (portal.has_permission(''system.admin'') OR (portal.has_permission(''comisiones.v2.read'') AND core.has_company_access(auth.uid(), company_id)))', v_table);
    END LOOP;
END $$;

-- RBAC decision pending: the proposed comisiones.v2.* permission codes are
-- referenced by the policies below, but this foundation does not create catalog
-- permissions or assign them to roles.
REVOKE UPDATE, DELETE ON comisiones.audit_events FROM authenticated, service_role;
GRANT SELECT, INSERT ON comisiones.audit_events TO authenticated, service_role;

CREATE POLICY comisiones_v2_write_settings ON comisiones.settings
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_settings ON comisiones.settings
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_plans ON comisiones.commission_plans
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_plans ON comisiones.commission_plans
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_seller_profiles ON comisiones.seller_profiles
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_seller_profiles ON comisiones.seller_profiles
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.plans.manage') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_settlement_draft ON comisiones.settlements
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_settlement ON comisiones.settlements
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_settlement_lines ON comisiones.settlement_lines
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_settlement_lines ON comisiones.settlement_lines
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_locks ON comisiones.line_locks
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_locks ON comisiones.line_locks
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.draft.create') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_credit_notes ON comisiones.credit_note_adjustments
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_credit_notes ON comisiones.credit_note_adjustments
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_sequences ON comisiones.settlement_sequences
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id)));
CREATE POLICY comisiones_v2_update_sequences ON comisiones.settlement_sequences
    FOR UPDATE TO authenticated USING (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id))) WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.issue') AND core.has_company_access(auth.uid(), company_id)));

CREATE POLICY comisiones_v2_write_audit_events ON comisiones.audit_events
    FOR INSERT TO authenticated WITH CHECK (portal.has_permission('system.admin') OR (portal.has_permission('comisiones.v2.history.audit') AND core.has_company_access(auth.uid(), company_id)));

GRANT USAGE ON SCHEMA comisiones TO authenticated, service_role;

DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'settings', 'seller_profiles', 'commission_plans',
        'commission_plan_family_rates', 'commission_plan_tiers',
        'commission_plan_exceptions', 'settlement_sequences', 'settlements',
        'settlement_lines', 'line_locks', 'credit_note_adjustments', 'audit_events'
    ] LOOP
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON comisiones.%I FOR EACH ROW EXECUTE FUNCTION portal.set_updated_at()', 'trg_comisiones_' || v_table || '_updated_at', v_table);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION comisiones.enforce_credit_note_cumulative_caps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_net_total numeric(18,2);
    v_commission_total numeric(18,2);
BEGIN
    IF NEW.status <> 'APPLIED' OR NEW.original_settlement_line_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Serialize applications for one emitted source line before summing them.
    PERFORM 1
    FROM comisiones.settlement_lines
    WHERE id = NEW.original_settlement_line_id
    FOR UPDATE;

    SELECT
        COALESCE(sum(adjusted_net_amount), 0),
        COALESCE(sum(adjusted_commission_amount), 0)
    INTO v_net_total, v_commission_total
    FROM comisiones.credit_note_adjustments
    WHERE company_id = NEW.company_id
      AND original_settlement_line_id = NEW.original_settlement_line_id
      AND status = 'APPLIED'
      AND id <> NEW.id;

    IF v_net_total + NEW.adjusted_net_amount > NEW.original_net_amount
       OR v_commission_total + NEW.adjusted_commission_amount > NEW.original_commission_amount THEN
        RAISE EXCEPTION 'COMV2_CREDIT_NOTE_ADJUSTMENT_EXCEEDS_ORIGINAL';
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_comisiones_credit_note_cumulative_caps
    AFTER INSERT OR UPDATE OF status, adjusted_net_amount, adjusted_commission_amount,
        original_settlement_line_id
    ON comisiones.credit_note_adjustments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION comisiones.enforce_credit_note_cumulative_caps();
