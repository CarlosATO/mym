-- COMV2-10: V2 settlement draft, immutable calculation snapshot and reservations.

INSERT INTO portal.permissions (code, name, description, module_id)
SELECT
    'comisiones.v2.draft.create',
    'Crear borradores de Comisiones V2',
    'Crear borradores V2 desde la simulación vigente y reservar sus líneas',
    id
FROM portal.modules
WHERE code = 'comercial'
ON CONFLICT (code) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r
JOIN portal.permissions p ON p.code = 'comisiones.v2.draft.create'
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
ON CONFLICT DO NOTHING;

ALTER TABLE comisiones.settlement_lines
    ADD COLUMN IF NOT EXISTS plan_code_snapshot text,
    ADD COLUMN IF NOT EXISTS supplier_total_net numeric(18,2);

COMMENT ON COLUMN comisiones.settlement_lines.plan_code_snapshot IS
    'Plan name/code captured when the settlement line was calculated.';
COMMENT ON COLUMN comisiones.settlement_lines.supplier_total_net IS
    'Supplier accumulated net amount used to select a sales-target tier.';

-- Drafts are created only through the transaction below. Future issue/cancel
-- contracts can grant the narrower writes they need explicitly.
REVOKE INSERT, UPDATE ON comisiones.settlements, comisiones.settlement_lines, comisiones.line_locks FROM authenticated;

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
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.draft.create')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;
    IF p_seller_bsale_id IS NULL OR p_seller_bsale_id <= 0
       OR p_period_from IS NULL OR p_period_to IS NULL OR p_period_to < p_period_from THEN
        RAISE EXCEPTION 'INVALID_SETTLEMENT_PERIOD';
    END IF;

    -- Serializing on the seller row makes the active-draft check deterministic
    -- when two requests target the same seller at the same time.
    SELECT * INTO v_profile
    FROM comisiones.seller_profiles
    WHERE company_id = p_company_id AND seller_bsale_id = p_seller_bsale_id
    FOR UPDATE;
    IF NOT FOUND OR NOT v_profile.active OR NOT v_profile.is_commissionable THEN
        RAISE EXCEPTION 'SELLER_NOT_ACTIVE_COMMISSIONABLE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM comisiones.settlements s
        WHERE s.company_id = p_company_id
          AND s.seller_bsale_id = p_seller_bsale_id
          AND s.status = 'DRAFT'
          AND s.settlement_kind = 'NORMAL'
    ) THEN
        RAISE EXCEPTION 'ACTIVE_NORMAL_DRAFT_EXISTS';
    END IF;

    -- The server-side simulation is the sole source of lines. UI filters,
    -- cached rows and client-provided totals never enter this contract.
    SELECT count(*), count(*) FILTER (WHERE simulation_status <> 'RULE_APPLIED')
    INTO v_line_count, v_invalid_count
    FROM comisiones.get_sales_line_simulation(
        p_company_id, p_seller_bsale_id, p_period_from, p_period_to
    );
    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'NO_ELIGIBLE_LINES';
    END IF;
    IF v_invalid_count > 0 THEN
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
        jsonb_build_object('contract', 'COMV2-10', 'source', 'SERVER_SIMULATION'),
        v_actor, v_actor
    ) RETURNING id INTO v_settlement_id;

    FOR v_row IN
        SELECT *
        FROM comisiones.get_sales_line_simulation(
            p_company_id, p_seller_bsale_id, p_period_from, p_period_to
        )
        ORDER BY detail_id
    LOOP
        IF v_row.plan_id IS NULL OR v_row.plan_type IS NULL
           OR v_row.commission_percent IS NULL OR v_row.commission_amount IS NULL THEN
            RAISE EXCEPTION 'INCOMPLETE_CALCULATION_SNAPSHOT';
        END IF;

        SELECT cp.id, cp.plan_code, cp.version_no, cp.plan_type
        INTO v_plan
        FROM comisiones.commission_plans cp
        WHERE cp.company_id = p_company_id AND cp.id = v_row.plan_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'PLAN_SNAPSHOT_NOT_FOUND';
        END IF;

        v_family_rate_id := NULL;
        v_tier_id := NULL;
        IF v_row.plan_type = 'FAMILY_FIXED_PERCENT' THEN
            SELECT fr.id INTO v_family_rate_id
            FROM comisiones.commission_plan_family_rates fr
            WHERE fr.company_id = p_company_id
              AND fr.plan_id = v_row.plan_id
              AND fr.family_bsale_product_type_id = v_row.family_bsale_product_type_id;
            IF v_family_rate_id IS NULL THEN
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
            IF v_tier_id IS NULL THEN
                RAISE EXCEPTION 'TARGET_TIER_SNAPSHOT_NOT_FOUND';
            END IF;
        ELSE
            RAISE EXCEPTION 'UNSUPPORTED_PLAN_TYPE';
        END IF;

        INSERT INTO comisiones.settlement_lines (
            company_id, settlement_id, line_kind, source_document_bsale_id,
            source_document_number, source_document_type_id, source_document_line_id,
            source_document_detail_bsale_id, bsale_variant_id, product_id,
            sku_snapshot, description_snapshot, quantity, net_amount,
            bsale_brand_id, real_supplier_id, real_supplier_name_snapshot,
            family_bsale_product_type_id, family_name_snapshot, seller_bsale_id,
            seller_name_snapshot, client_bsale_id, customer_name_snapshot,
            plan_id, plan_code_snapshot, plan_version_no, plan_type, family_rate_id,
            tier_id, tier_lower_bound, tier_upper_bound, supplier_total_net,
            percentage, base_amount, commission_amount, currency_code,
            document_emission_date, full_payment_date, calculated_at, metadata
        ) VALUES (
            p_company_id, v_settlement_id, 'INVOICE', v_row.document_bsale_id::integer,
            v_row.document_number::bigint, v_row.document_type_id, v_row.detail_id,
            v_row.detail_bsale_id::integer, v_row.variant_id, v_row.product_id,
            COALESCE(v_row.variant_code_snapshot, v_row.current_sku),
            COALESCE(v_row.current_product_description, v_row.variant_description_snapshot),
            v_row.quantity, v_row.net_amount, v_row.bsale_brand_id,
            v_row.real_supplier_id, v_row.real_supplier_business_name,
            v_row.family_bsale_product_type_id, v_row.family_name,
            v_row.seller_bsale_id, v_row.seller_name, v_row.customer_bsale_id,
            v_row.customer_name, v_row.plan_id, v_plan.plan_code, v_plan.version_no,
            v_plan.plan_type, v_family_rate_id, v_tier_id, v_row.tier_lower_bound,
            v_row.tier_upper_bound, v_row.supplier_total_net, v_row.commission_percent,
            v_row.net_amount, v_row.commission_amount, 'CLP', v_row.emission_date,
            v_row.full_payment_date::date, now(),
            jsonb_build_object(
                'plan_name_snapshot', v_plan.plan_code,
                'plan_type_snapshot', v_plan.plan_type,
                'supplier_total_net_snapshot', v_row.supplier_total_net,
                'tier_lower_bound_snapshot', v_row.tier_lower_bound,
                'tier_upper_bound_snapshot', v_row.tier_upper_bound,
                'payment_record_date', v_row.full_payment_date::date
            )
        ) RETURNING id INTO v_line_id;

        INSERT INTO comisiones.line_locks (
            company_id, settlement_id, settlement_line_id,
            source_document_line_id, source_document_detail_bsale_id,
            line_kind, lock_kind, status, reason, created_by
        ) VALUES (
            p_company_id, v_settlement_id, v_line_id, v_row.detail_id,
            v_row.detail_bsale_id::integer, 'INVOICE', 'RESERVATION',
            'ACTIVE', 'COMV2 settlement draft reservation', v_actor
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
    SELECT v_settlement_id,
           count(*)::bigint,
           s.total_net_amount,
           s.total_commission_amount
    FROM comisiones.settlement_lines sl
    JOIN comisiones.settlements s
      ON s.company_id = sl.company_id AND s.id = sl.settlement_id
    WHERE sl.company_id = p_company_id AND sl.settlement_id = v_settlement_id
    GROUP BY s.total_net_amount, s.total_commission_amount;
END;
$$;

REVOKE ALL ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION comisiones.get_settlement_detail(
    p_company_id uuid,
    p_settlement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_settlement jsonb;
    v_lines jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.read')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;

    SELECT to_jsonb(s) - 'updated_by' INTO v_settlement
    FROM comisiones.settlements s
    WHERE s.company_id = p_company_id AND s.id = p_settlement_id;
    IF v_settlement IS NULL THEN
        RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(sl) ORDER BY sl.document_emission_date DESC, sl.source_document_number DESC, sl.source_document_detail_bsale_id), '[]'::jsonb)
    INTO v_lines
    FROM comisiones.settlement_lines sl
    WHERE sl.company_id = p_company_id AND sl.settlement_id = p_settlement_id;

    RETURN jsonb_build_object('settlement', v_settlement, 'lines', v_lines);
END;
$$;

REVOKE ALL ON FUNCTION comisiones.get_settlement_detail(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_settlement_detail(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.create_settlement_draft(uuid, bigint, date, date) IS
    'COMV2-10 atomic server-side draft creation, calculation snapshot and active line reservations.';
COMMENT ON FUNCTION comisiones.get_settlement_detail(uuid, uuid) IS
    'COMV2 read-only settlement header and immutable calculation snapshot lines.';
