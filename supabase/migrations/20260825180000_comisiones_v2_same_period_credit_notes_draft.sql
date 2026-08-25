-- COMV2-29D: persist the same invoice + SAME_PERIOD credit-note universe
-- already exposed by the period simulation.

ALTER TABLE comisiones.settlement_lines
    DROP CONSTRAINT chk_comisiones_settlement_lines_numeric;

ALTER TABLE comisiones.settlement_lines
    ADD CONSTRAINT chk_comisiones_settlement_lines_numeric CHECK (
        (
            (line_kind = 'INVOICE' AND quantity >= 0)
            OR (line_kind = 'CREDIT_NOTE' AND quantity <= 0)
        )
        AND (
            percentage IS NULL
            OR (percentage >= 0 AND percentage <= 100)
        )
    );

DROP FUNCTION IF EXISTS comisiones.get_sales_line_simulation(uuid, bigint, date, date);

CREATE FUNCTION comisiones.get_sales_line_simulation(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_from date,
    p_to date
)
RETURNS TABLE (
    company_id uuid, document_id uuid, document_bsale_id bigint, document_number bigint,
    document_type_id integer, emission_date date, customer_bsale_id bigint, customer_name text,
    detail_id uuid, detail_bsale_id bigint, line_number integer, quantity numeric, net_amount numeric,
    variant_id integer, variant_code_snapshot text, variant_description_snapshot text,
    product_id uuid, current_sku text, current_product_description text, product_is_active boolean,
    bsale_brand_id integer, real_supplier_id uuid, real_supplier_business_name text,
    family_bsale_product_type_id integer, family_name text, resolution_status text,
    resolution_code text, resolution_message text, seller_bsale_id bigint, seller_name text,
    seller_primary_count bigint, seller_primary_ids bigint[], seller_is_commissionable boolean,
    seller_is_active boolean, receivable_status text, total_amount numeric, paid_amount numeric,
    pending_amount numeric, full_payment_date timestamptz, plan_id uuid, plan_code text,
    plan_type text, family_percentage numeric, supplier_total_net numeric,
    tier_lower_bound numeric, tier_upper_bound numeric, commission_percent numeric,
    commission_amount numeric, simulation_status text, simulation_message text,
    line_kind text, source_document_bsale_id bigint, source_document_number bigint,
    source_document_type_id integer, source_document_line_id uuid,
    source_document_detail_bsale_id bigint, original_invoice_bsale_id bigint,
    original_invoice_number bigint, original_invoice_line_id uuid,
    original_invoice_detail_bsale_id bigint, credit_note_date date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
    SELECT s.company_id, s.document_id, s.document_bsale_id, s.document_number,
           s.document_type_id, s.emission_date, s.customer_bsale_id, s.customer_name,
           s.detail_id, s.detail_bsale_id, s.line_number, s.quantity, s.net_amount,
           s.variant_id, s.variant_code_snapshot, s.variant_description_snapshot,
           s.product_id, s.current_sku, s.current_product_description, s.product_is_active,
           s.bsale_brand_id, s.real_supplier_id, s.real_supplier_business_name,
           s.family_bsale_product_type_id, s.family_name, s.resolution_status,
           s.resolution_code, s.resolution_message, s.seller_bsale_id, s.seller_name,
           s.seller_primary_count, s.seller_primary_ids, s.seller_is_commissionable,
           s.seller_is_active, s.receivable_status, s.total_amount, s.paid_amount,
           s.pending_amount, s.full_payment_date, s.plan_id, s.plan_code,
           s.plan_type, s.family_percentage, s.supplier_total_net,
           s.tier_lower_bound, s.tier_upper_bound, s.commission_percent,
           s.commission_amount, s.simulation_status, s.simulation_message,
           s.line_kind, s.source_document_bsale_id, s.source_document_number,
           s.source_document_type_id, s.source_document_line_id,
           s.source_document_detail_bsale_id, s.original_invoice_bsale_id,
           s.original_invoice_number, s.original_invoice_line_id,
           s.original_invoice_detail_bsale_id, s.credit_note_date
    FROM comisiones.get_sales_period_simulation(
        p_company_id, p_from, p_to
    ) s
    WHERE s.seller_bsale_id = p_seller_bsale_id;
$$;

REVOKE ALL ON FUNCTION comisiones.get_sales_line_simulation(uuid, bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_simulation(uuid, bigint, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION comisiones.create_settlement_draft(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_period_from date,
    p_period_to date
)
RETURNS TABLE (
    settlement_id uuid,
    lines_count bigint,
    total_net_amount numeric,
    total_commission_amount numeric
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_profile comisiones.seller_profiles%ROWTYPE;
    v_row record;
    v_plan record;
    v_family_rate_id uuid;
    v_tier_id uuid;
    v_settlement_id uuid;
    v_line_id uuid;
    v_line_count bigint;
    v_invalid_count bigint;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.draft.create')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF p_seller_bsale_id IS NULL OR p_seller_bsale_id <= 0
       OR p_period_from IS NULL OR p_period_to IS NULL OR p_period_to < p_period_from THEN
        RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD';
    END IF;

    SELECT * INTO v_profile
    FROM comisiones.seller_profiles
    WHERE company_id = p_company_id AND seller_bsale_id = p_seller_bsale_id
    FOR UPDATE;
    IF NOT FOUND OR NOT v_profile.active OR NOT v_profile.is_commissionable THEN
        RAISE EXCEPTION 'SELLER_NOT_ACTIVE_COMMISSIONABLE';
    END IF;

    IF EXISTS (
        SELECT 1 FROM comisiones.settlements s
        WHERE s.company_id = p_company_id
          AND s.seller_bsale_id = p_seller_bsale_id
          AND s.status = 'DRAFT'
          AND s.settlement_kind = 'NORMAL'
    ) THEN
        RAISE EXCEPTION 'ACTIVE_NORMAL_DRAFT_EXISTS';
    END IF;

    SELECT count(*), count(*) FILTER (WHERE simulation_status IN ('NO_SALES_TARGET_TIER', 'COMMERCIAL_INCIDENT'))
    INTO v_line_count, v_invalid_count
    FROM comisiones.get_sales_line_simulation(p_company_id, p_seller_bsale_id, p_period_from, p_period_to);
    IF v_line_count = 0 THEN RAISE EXCEPTION 'NO_ELIGIBLE_LINES'; END IF;
    IF v_invalid_count > 0 THEN
        IF EXISTS (
            SELECT 1 FROM comisiones.get_sales_line_simulation(p_company_id, p_seller_bsale_id, p_period_from, p_period_to)
            WHERE simulation_status = 'NO_SALES_TARGET_TIER'
        ) THEN
            RAISE EXCEPTION 'BLOCKING_NO_SALES_TARGET_TIER';
        END IF;
        RAISE EXCEPTION 'BLOCKING_SIMULATION_INCIDENT';
    END IF;

    INSERT INTO comisiones.settlements (
        company_id, settlement_code, seller_profile_id, seller_bsale_id,
        seller_name_snapshot, period_from, period_to, payment_cutoff_date,
        status, settlement_kind, total_net_amount, total_commission_amount,
        metadata, created_by, updated_by
    ) VALUES (
        p_company_id, 'DRAFT-' || gen_random_uuid()::text, v_profile.id,
        p_seller_bsale_id, v_profile.seller_name, p_period_from, p_period_to,
        p_period_to, 'DRAFT', 'NORMAL', 0, 0,
        jsonb_build_object('contract', 'COMV2-29D', 'source', 'SERVER_SIMULATION'),
        v_actor, v_actor
    ) RETURNING id INTO v_settlement_id;

    FOR v_row IN
        SELECT *
        FROM comisiones.get_sales_line_simulation(p_company_id, p_seller_bsale_id, p_period_from, p_period_to)
        ORDER BY full_payment_date DESC, source_document_number DESC, source_document_detail_bsale_id
    LOOP
        IF v_row.simulation_status = 'RULE_APPLIED'
           AND (v_row.plan_id IS NULL OR v_row.plan_type IS NULL
                OR v_row.commission_percent IS NULL OR v_row.commission_amount IS NULL) THEN
            RAISE EXCEPTION 'INCOMPLETE_CALCULATION_SNAPSHOT';
        END IF;

        v_plan := NULL;
        v_family_rate_id := NULL;
        v_tier_id := NULL;
        IF v_row.plan_id IS NOT NULL THEN
            SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type
            INTO v_plan
            FROM comisiones.commission_plans cp
            WHERE cp.company_id = p_company_id AND cp.id = v_row.plan_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_SNAPSHOT_NOT_FOUND'; END IF;

            IF v_row.plan_type = 'FAMILY_FIXED_PERCENT' THEN
                SELECT fr.id INTO v_family_rate_id
                FROM comisiones.commission_plan_family_rates fr
                WHERE fr.company_id = p_company_id
                  AND fr.plan_id = v_row.plan_id
                  AND fr.family_bsale_product_type_id = v_row.family_bsale_product_type_id;
                IF v_family_rate_id IS NULL AND v_row.simulation_status = 'RULE_APPLIED' THEN
                    RAISE EXCEPTION 'FAMILY_RATE_SNAPSHOT_NOT_FOUND';
                END IF;
            ELSIF v_row.plan_type = 'SUPPLIER_SALES_TARGET' THEN
                SELECT t.id INTO v_tier_id
                FROM comisiones.commission_plan_tiers t
                WHERE t.company_id = p_company_id
                  AND t.plan_id = v_row.plan_id
                  AND t.lower_bound = v_row.tier_lower_bound
                  AND t.upper_bound IS NOT DISTINCT FROM v_row.tier_upper_bound
                  AND t.percentage = v_row.commission_percent
                ORDER BY t.tier_order
                LIMIT 1;
                IF v_tier_id IS NULL AND v_row.simulation_status = 'RULE_APPLIED' THEN
                    RAISE EXCEPTION 'TARGET_TIER_SNAPSHOT_NOT_FOUND';
                END IF;
            ELSE
                RAISE EXCEPTION 'UNSUPPORTED_PLAN_TYPE';
            END IF;
        END IF;

        INSERT INTO comisiones.settlement_lines (
            company_id, settlement_id, line_kind, source_document_bsale_id,
            source_document_number, source_document_type_id, source_document_line_id,
            source_document_detail_bsale_id, original_invoice_bsale_id,
            original_invoice_number, original_invoice_line_id, original_invoice_detail_bsale_id,
            bsale_variant_id, product_id, sku_snapshot, description_snapshot, quantity, net_amount,
            bsale_brand_id, real_supplier_id, real_supplier_name_snapshot,
            family_bsale_product_type_id, family_name_snapshot, seller_bsale_id,
            seller_name_snapshot, client_bsale_id, customer_name_snapshot,
            plan_id, plan_code_snapshot, plan_version_no, plan_type, family_rate_id,
            tier_id, tier_lower_bound, tier_upper_bound, supplier_total_net,
            percentage, base_amount, commission_amount, currency_code,
            document_emission_date, full_payment_date, credit_note_date, calculated_at, metadata
        ) VALUES (
            p_company_id, v_settlement_id, v_row.line_kind, v_row.source_document_bsale_id::integer,
            v_row.source_document_number::bigint, v_row.source_document_type_id,
            v_row.source_document_line_id, v_row.source_document_detail_bsale_id::integer,
            v_row.original_invoice_bsale_id::integer, v_row.original_invoice_number::bigint,
            v_row.original_invoice_line_id, v_row.original_invoice_detail_bsale_id::integer,
            v_row.variant_id, v_row.product_id,
            COALESCE(v_row.variant_code_snapshot, v_row.current_sku),
            COALESCE(v_row.current_product_description, v_row.variant_description_snapshot),
            v_row.quantity, v_row.net_amount, v_row.bsale_brand_id,
            v_row.real_supplier_id, v_row.real_supplier_business_name,
            v_row.family_bsale_product_type_id, v_row.family_name, v_row.seller_bsale_id,
            v_row.seller_name, v_row.customer_bsale_id, v_row.customer_name,
            v_row.plan_id, v_plan.plan_code, v_plan.version_no, v_plan.plan_type,
            v_family_rate_id, v_tier_id, v_row.tier_lower_bound, v_row.tier_upper_bound,
            v_row.supplier_total_net, COALESCE(v_row.commission_percent, 0),
            v_row.net_amount, COALESCE(v_row.commission_amount, 0), 'CLP',
            v_row.emission_date, v_row.full_payment_date::date, v_row.credit_note_date,
            now(),
            jsonb_build_object(
                'plan_name_snapshot', v_plan.plan_code,
                'plan_type_snapshot', v_plan.plan_type,
                'supplier_total_net_snapshot', v_row.supplier_total_net,
                'tier_lower_bound_snapshot', v_row.tier_lower_bound,
                'tier_upper_bound_snapshot', v_row.tier_upper_bound,
                'payment_record_date', v_row.full_payment_date::date,
                'simulation_status', v_row.simulation_status,
                'simulation_message', v_row.simulation_message
            ) || CASE WHEN v_row.line_kind = 'CREDIT_NOTE'
                THEN jsonb_build_object('credit_note_placement', 'SAME_PERIOD')
                ELSE '{}'::jsonb END
        ) RETURNING id INTO v_line_id;

        INSERT INTO comisiones.line_locks (
            company_id, settlement_id, settlement_line_id,
            source_document_line_id, source_document_detail_bsale_id,
            line_kind, lock_kind, status, reason, created_by
        ) VALUES (
            p_company_id, v_settlement_id, v_line_id, v_row.source_document_line_id,
            v_row.source_document_detail_bsale_id::integer, v_row.line_kind,
            'RESERVATION', 'ACTIVE', 'COMV2 settlement draft reservation', v_actor
        );
    END LOOP;

    UPDATE comisiones.settlements s
    SET total_net_amount = totals.total_net_amount,
        total_commission_amount = totals.total_commission_amount,
        updated_by = v_actor
    FROM (
        SELECT COALESCE(sum(sl.net_amount), 0)::numeric(18,2) AS total_net_amount,
               COALESCE(sum(sl.commission_amount), 0)::numeric(18,2) AS total_commission_amount
        FROM comisiones.settlement_lines sl
        WHERE sl.company_id = p_company_id AND sl.settlement_id = v_settlement_id
    ) totals
    WHERE s.company_id = p_company_id AND s.id = v_settlement_id;

    RETURN QUERY
    SELECT v_settlement_id, count(*)::bigint, s.total_net_amount, s.total_commission_amount
    FROM comisiones.settlement_lines sl
    JOIN comisiones.settlements s ON s.company_id = sl.company_id AND s.id = sl.settlement_id
    WHERE sl.company_id = p_company_id AND sl.settlement_id = v_settlement_id
    GROUP BY s.total_net_amount, s.total_commission_amount;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.get_sales_line_simulation(uuid, bigint, date, date) IS
    'COMV2-29D seller projection of get_sales_period_simulation, including invoice and SAME_PERIOD credit-note rows.';

COMMENT ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) IS
    'COMV2-29D atomic draft snapshot and reservations for invoice and SAME_PERIOD credit-note simulation rows.';
