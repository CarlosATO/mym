-- Explicit resolution of uncovered invoice balances without creating payments.

ALTER TABLE adquisiciones.route_settlement_items
    ADD COLUMN IF NOT EXISTS resolution_type varchar(30),
    ADD COLUMN IF NOT EXISTS resolution_notes text,
    ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES portal.users(id),
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE adquisiciones.route_settlement_items
    DROP CONSTRAINT IF EXISTS chk_route_settlement_items_resolution_type;

ALTER TABLE adquisiciones.route_settlement_items
    ADD CONSTRAINT chk_route_settlement_items_resolution_type
    CHECK (resolution_type IS NULL OR resolution_type IN (
        'PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED', 'REVIEW_REQUIRED'
    ));

CREATE OR REPLACE FUNCTION adquisiciones.set_route_settlement_item_resolution(
    p_settlement_item_id uuid,
    p_resolution_type text,
    p_resolution_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_company_id uuid;
    v_settlement_id uuid;
    v_settlement_status varchar(30);
    v_workflow_status varchar(30);
    v_invoice_number text;
    v_expected_amount numeric(14,2);
    v_applied_amount numeric(14,2);
    v_resolution_type varchar(30);
    v_notes text := NULLIF(btrim(p_resolution_notes), '');
    v_old_data jsonb;
BEGIN
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;

    IF p_settlement_item_id IS NULL THEN
        RAISE EXCEPTION 'settlement_item_id es obligatorio.';
    END IF;

    v_resolution_type := NULLIF(upper(btrim(p_resolution_type)), '');

    IF v_resolution_type IS NOT NULL
       AND v_resolution_type NOT IN ('PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED', 'REVIEW_REQUIRED') THEN
        RAISE EXCEPTION 'Tipo de resolución no permitido: %.', v_resolution_type;
    END IF;

    IF v_resolution_type IN ('NOT_DELIVERED', 'REVIEW_REQUIRED') AND v_notes IS NULL THEN
        RAISE EXCEPTION 'Debes indicar un motivo para la resolución %.', v_resolution_type;
    END IF;

    SELECT
        si.company_id,
        si.settlement_id,
        si.invoice_number,
        si.expected_amount,
        s.status,
        s.workflow_status,
        jsonb_build_object(
            'settlement_item_id', si.id,
            'resolution_type', si.resolution_type,
            'resolution_notes', si.resolution_notes,
            'resolved_by', si.resolved_by,
            'resolved_at', si.resolved_at
        )
    INTO
        v_company_id,
        v_settlement_id,
        v_invoice_number,
        v_expected_amount,
        v_settlement_status,
        v_workflow_status,
        v_old_data
    FROM adquisiciones.route_settlement_items si
    JOIN adquisiciones.route_settlements s
      ON s.id = si.settlement_id
     AND s.company_id = si.company_id
    WHERE si.id = p_settlement_item_id
    FOR UPDATE OF si, s;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura de rendición no encontrada.';
    END IF;

    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;

    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.update') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para actualizar rendiciones.';
    END IF;

    IF v_settlement_status IN ('CLOSED', 'CANCELLED')
       OR v_workflow_status IN ('CLOSED', 'CANCELLED') THEN
        RAISE EXCEPTION 'La rendición está cerrada o cancelada y no permite resolver facturas.';
    END IF;

    PERFORM pg_advisory_xact_lock(
        pg_catalog.hashtextextended('route-settlement-resolution:' || p_settlement_item_id::text, 0)
    );

    SELECT COALESCE(sum(a.amount_applied), 0)::numeric(14,2)
    INTO v_applied_amount
    FROM adquisiciones.route_settlement_payment_allocations a
    JOIN adquisiciones.route_settlement_payments p
      ON p.id = a.payment_id
     AND p.company_id = a.company_id
     AND p.settlement_id = a.settlement_id
     AND p.customer_bsale_id = a.customer_bsale_id
    WHERE a.company_id = v_company_id
      AND a.settlement_id = v_settlement_id
      AND a.settlement_item_id = p_settlement_item_id
      AND a.voided_at IS NULL
      AND p.verification_status <> 'VOIDED';

    IF v_resolution_type = 'NOT_DELIVERED' AND v_applied_amount > 0 THEN
        RAISE EXCEPTION 'La factura % no puede marcarse como no entregada porque ya tiene un pago aplicado.', v_invoice_number;
    END IF;

    UPDATE adquisiciones.route_settlement_items
    SET
        resolution_type = v_resolution_type,
        resolution_notes = CASE WHEN v_resolution_type IS NULL THEN NULL ELSE v_notes END,
        resolved_by = CASE WHEN v_resolution_type IS NULL THEN NULL ELSE v_actor_user_id END,
        resolved_at = CASE WHEN v_resolution_type IS NULL THEN NULL ELSE now() END
    WHERE id = p_settlement_item_id
      AND company_id = v_company_id
      AND settlement_id = v_settlement_id;

    INSERT INTO portal.audit_logs (
        schema_name,
        module_code,
        table_name,
        record_id,
        action,
        old_data,
        new_data,
        performed_by,
        event_type,
        severity
    ) VALUES (
        'adquisiciones',
        'ADQUISICIONES',
        'route_settlement_items',
        p_settlement_item_id,
        'UPDATE',
        v_old_data,
        jsonb_build_object(
            'settlement_item_id', p_settlement_item_id,
            'resolution_type', v_resolution_type,
            'resolution_notes', CASE WHEN v_resolution_type IS NULL THEN NULL ELSE v_notes END,
            'resolved_by', CASE WHEN v_resolution_type IS NULL THEN NULL ELSE v_actor_user_id END,
            'resolved_at', CASE WHEN v_resolution_type IS NULL THEN NULL ELSE now() END,
            'applied_amount', v_applied_amount,
            'unapplied_amount', GREATEST(v_expected_amount - v_applied_amount, 0)
        ),
        v_actor_user_id,
        'ROUTE_SETTLEMENT_ITEM_RESOLUTION_UPDATED',
        'INFO'
    );

    RETURN jsonb_build_object(
        'settlement_item_id', p_settlement_item_id,
        'invoice_number', v_invoice_number,
        'resolution_type', v_resolution_type,
        'resolution_notes', CASE WHEN v_resolution_type IS NULL THEN NULL ELSE v_notes END,
        'applied_amount', v_applied_amount,
        'unapplied_amount', GREATEST(v_expected_amount - v_applied_amount, 0),
        'resolved_for_settlement', CASE
            WHEN v_applied_amount >= v_expected_amount THEN true
            WHEN v_resolution_type IN ('PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED') THEN true
            ELSE false
        END
    );
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.set_route_settlement_item_resolution(uuid, text, text)
    FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION adquisiciones.set_route_settlement_item_resolution(uuid, text, text)
    TO authenticated;

COMMENT ON FUNCTION adquisiciones.set_route_settlement_item_resolution(uuid, text, text) IS
    'Sets or clears an explicit resolution for the uncovered balance of a route settlement invoice without creating payments.';

-- Read model: retain the existing contract and add explicit no-payment resolution facts.
CREATE OR REPLACE FUNCTION adquisiciones.get_route_settlement_detail(
    p_settlement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, logistica, integraciones, core, portal
AS $$
DECLARE
    v_actor_user_id uuid := auth.uid();
    v_company_id uuid;
    v_result jsonb;
BEGIN
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.' USING ERRCODE = '28000';
    END IF;
    IF p_settlement_id IS NULL THEN
        RAISE EXCEPTION 'settlement_id es obligatorio.';
    END IF;

    SELECT s.company_id INTO v_company_id
    FROM adquisiciones.route_settlements s
    WHERE s.id = p_settlement_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada.'; END IF;
    IF NOT core.has_company_access(v_actor_user_id, v_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa de la rendición.';
    END IF;
    IF NOT portal.user_has_permission(v_actor_user_id, 'adquisiciones.route_settlements.view') THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para visualizar rendiciones.';
    END IF;

    WITH settlement_scope AS (
        SELECT s.id, s.company_id, s.settlement_number, s.route_guide_id,
               s.settlement_date, s.workflow_status, s.financial_result, s.status, s.notes,
               g.guide_number AS route_guide_number, g.guide_date
        FROM adquisiciones.route_settlements s
        JOIN logistica.route_guides g ON g.id = s.route_guide_id AND g.company_id = s.company_id
        WHERE s.id = p_settlement_id AND s.company_id = v_company_id
    ),
    invoice_facts AS (
        SELECT
            si.company_id, si.settlement_id, si.id AS settlement_item_id,
            si.route_guide_item_id, si.invoice_number, si.customer_name,
            si.customer_bsale_id, si.expected_payment_method, si.expected_amount,
            si.status AS legacy_status, si.received_amount AS legacy_received_amount,
            si.difference_amount AS legacy_difference_amount, si.notes AS legacy_notes,
            si.resolution_type, si.resolution_notes, si.resolved_by, si.resolved_at,
            gi.line_number,
            COALESCE(active.applied_amount, 0)::numeric(14,2) AS applied_amount,
            GREATEST(si.expected_amount - COALESCE(active.applied_amount, 0), 0)::numeric(14,2)
                AS unapplied_amount
        FROM adquisiciones.route_settlement_items si
        JOIN settlement_scope ss ON ss.id = si.settlement_id AND ss.company_id = si.company_id
        JOIN logistica.route_guide_items gi
          ON gi.id = si.route_guide_item_id AND gi.route_guide_id = ss.route_guide_id AND gi.company_id = ss.company_id
        LEFT JOIN LATERAL (
            SELECT sum(a.amount_applied) AS applied_amount
            FROM adquisiciones.route_settlement_payment_allocations a
            JOIN adquisiciones.route_settlement_payments p
              ON p.id = a.payment_id AND p.company_id = a.company_id
             AND p.settlement_id = a.settlement_id AND p.customer_bsale_id = a.customer_bsale_id
            WHERE a.company_id = si.company_id AND a.settlement_id = si.settlement_id
              AND a.settlement_item_id = si.id AND a.voided_at IS NULL
              AND p.verification_status <> 'VOIDED'
        ) active ON true
    ),
    invoice_derived AS (
        SELECT i.*,
            CASE
                WHEN i.applied_amount >= i.expected_amount THEN 'PAID'
                WHEN i.resolution_type = 'PENDING_PAYMENT' THEN 'PENDING_PAYMENT'
                WHEN i.resolution_type = 'CREDIT' THEN 'CREDIT'
                WHEN i.resolution_type = 'NOT_DELIVERED' THEN 'NOT_DELIVERED'
                WHEN i.resolution_type = 'REVIEW_REQUIRED' THEN 'REVIEW_REQUIRED'
                WHEN i.applied_amount > 0 THEN 'PARTIAL'
                ELSE 'PENDING'
            END AS invoice_result,
            CASE
                WHEN i.applied_amount >= i.expected_amount THEN true
                WHEN i.resolution_type IN ('PENDING_PAYMENT', 'CREDIT', 'NOT_DELIVERED') THEN true
                ELSE false
            END AS resolved_for_settlement
        FROM invoice_facts i
    ),
    invoice_payloads AS (
        SELECT i.customer_bsale_id,
            jsonb_agg(jsonb_build_object(
                'settlement_item_id', i.settlement_item_id,
                'route_guide_item_id', i.route_guide_item_id,
                'invoice_number', i.invoice_number,
                'expected_payment_method', i.expected_payment_method,
                'expected_amount', i.expected_amount,
                'customer_bsale_id', i.customer_bsale_id,
                'applied_amount', i.applied_amount,
                'pending_amount', i.unapplied_amount,
                'unapplied_amount', i.unapplied_amount,
                'result', CASE WHEN i.applied_amount >= i.expected_amount THEN 'PAID'
                               WHEN i.applied_amount > 0 THEN 'PARTIAL' ELSE 'PENDING' END,
                'invoice_result', i.invoice_result,
                'resolved_for_settlement', i.resolved_for_settlement,
                'resolution_type', i.resolution_type,
                'resolution_notes', i.resolution_notes,
                'resolved_by', i.resolved_by,
                'resolved_at', i.resolved_at,
                'legacy_status', i.legacy_status,
                'legacy_received_amount', i.legacy_received_amount,
                'legacy_difference_amount', i.legacy_difference_amount,
                'legacy_notes', i.legacy_notes
            ) ORDER BY i.line_number, i.invoice_number, i.settlement_item_id) AS invoices
        FROM invoice_derived i GROUP BY i.customer_bsale_id
    ),
    payment_facts AS (
        SELECT p.company_id, p.settlement_id, p.customer_bsale_id, p.id,
            p.payment_method_received, p.amount_received, p.verification_status,
            p.received_at, p.reference_number, p.bank_name, p.check_number,
            p.check_date, p.notes, p.custody_user_id, p.custody_received_at,
            p.voided_at, p.void_reason,
            COALESCE(active.applied_amount, 0)::numeric(14,2) AS active_applied_amount,
            COALESCE(history.allocations, '[]'::jsonb) AS allocations
        FROM adquisiciones.route_settlement_payments p
        JOIN settlement_scope ss ON ss.id = p.settlement_id AND ss.company_id = p.company_id
        LEFT JOIN LATERAL (
            SELECT sum(a.amount_applied) AS applied_amount
            FROM adquisiciones.route_settlement_payment_allocations a
            WHERE a.company_id = p.company_id AND a.settlement_id = p.settlement_id
              AND a.payment_id = p.id AND a.voided_at IS NULL AND p.verification_status <> 'VOIDED'
        ) active ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(jsonb_build_object(
                'allocation_id', a.id, 'settlement_item_id', a.settlement_item_id,
                'invoice_number', si.invoice_number, 'amount_applied', a.amount_applied,
                'voided_at', a.voided_at
            ) ORDER BY a.created_at, a.id) AS allocations
            FROM adquisiciones.route_settlement_payment_allocations a
            JOIN adquisiciones.route_settlement_items si
              ON si.id = a.settlement_item_id AND si.company_id = a.company_id
             AND si.settlement_id = a.settlement_id AND si.customer_bsale_id = a.customer_bsale_id
            WHERE a.company_id = p.company_id AND a.settlement_id = p.settlement_id AND a.payment_id = p.id
        ) history ON true
    ),
    payment_payloads AS (
        SELECT p.customer_bsale_id,
            count(*) FILTER (WHERE p.verification_status <> 'VOIDED')::integer AS payment_count,
            jsonb_agg(jsonb_build_object(
                'id', p.id, 'payment_method_received', p.payment_method_received,
                'amount_received', p.amount_received, 'amount_applied', p.active_applied_amount,
                'unallocated_amount', CASE WHEN p.verification_status = 'VOIDED' THEN 0::numeric
                    ELSE GREATEST(p.amount_received - p.active_applied_amount, 0)::numeric(14,2) END,
                'verification_status', p.verification_status, 'received_at', p.received_at,
                'reference_number', p.reference_number, 'bank_name', p.bank_name,
                'check_number', p.check_number, 'check_date', p.check_date, 'notes', p.notes,
                'custody_user_id', p.custody_user_id, 'custody_received_at', p.custody_received_at,
                'voided_at', p.voided_at, 'void_reason', p.void_reason, 'allocations', p.allocations
            ) ORDER BY p.received_at, p.id) AS payments
        FROM payment_facts p GROUP BY p.customer_bsale_id
    ),
    client_rollup AS (
        SELECT i.customer_bsale_id, min(i.line_number) AS first_line_number,
            (array_agg(i.customer_name ORDER BY i.line_number, i.settlement_item_id))[1] AS customer_name,
            count(*)::integer AS invoice_count, sum(i.expected_amount)::numeric(14,2) AS expected_amount,
            sum(i.applied_amount)::numeric(14,2) AS applied_amount,
            sum(i.unapplied_amount)::numeric(14,2) AS pending_amount,
            count(*) FILTER (WHERE i.resolved_for_settlement)::integer AS resolved_invoice_count,
            count(*) FILTER (WHERE NOT i.resolved_for_settlement)::integer AS unresolved_invoice_count,
            count(*) FILTER (WHERE i.resolution_type = 'REVIEW_REQUIRED')::integer AS review_required_count,
            CASE WHEN sum(i.applied_amount) = 0 THEN 'PENDING'
                 WHEN sum(i.applied_amount) < sum(i.expected_amount) THEN 'PARTIAL' ELSE 'PAID' END AS summary_status
        FROM invoice_derived i GROUP BY i.customer_bsale_id
    ),
    client_payloads AS (
        SELECT jsonb_agg(jsonb_build_object(
            'customer_bsale_id', c.customer_bsale_id, 'customer_name', c.customer_name,
            'rut', NULLIF(bc.code, ''), 'invoice_count', c.invoice_count,
            'expected_amount', c.expected_amount, 'applied_amount', c.applied_amount,
            'pending_amount', c.pending_amount, 'payment_count', COALESCE(pp.payment_count, 0),
            'resolved_invoice_count', c.resolved_invoice_count,
            'unresolved_invoice_count', c.unresolved_invoice_count,
            'review_required_count', c.review_required_count,
            'status', c.summary_status, 'invoices', COALESCE(ip.invoices, '[]'::jsonb),
            'payments', COALESCE(pp.payments, '[]'::jsonb)
        ) ORDER BY c.first_line_number, c.customer_bsale_id) AS clients
        FROM client_rollup c
        LEFT JOIN invoice_payloads ip ON ip.customer_bsale_id IS NOT DISTINCT FROM c.customer_bsale_id
        LEFT JOIN payment_payloads pp ON pp.customer_bsale_id IS NOT DISTINCT FROM c.customer_bsale_id
        LEFT JOIN integraciones.bsale_clients bc ON bc.company_id = v_company_id AND bc.bsale_client_id = c.customer_bsale_id
    ),
    settlement_totals AS (
        SELECT count(*)::integer AS invoice_count, count(DISTINCT customer_bsale_id)::integer AS customer_count,
            sum(expected_amount)::numeric(14,2) AS expected_amount,
            sum(applied_amount)::numeric(14,2) AS applied_amount,
            sum(unapplied_amount)::numeric(14,2) AS pending_amount,
            count(*) FILTER (WHERE resolved_for_settlement)::integer AS resolved_invoice_count,
            count(*) FILTER (WHERE NOT resolved_for_settlement)::integer AS unresolved_invoice_count,
            count(*) FILTER (WHERE resolution_type = 'REVIEW_REQUIRED')::integer AS review_required_count
        FROM invoice_derived
    )
    SELECT jsonb_build_object(
        'settlement', jsonb_build_object(
            'id', ss.id, 'settlement_number', ss.settlement_number, 'route_guide_id', ss.route_guide_id,
            'route_guide_number', ss.route_guide_number, 'guide_date', ss.guide_date,
            'settlement_date', ss.settlement_date, 'workflow_status', ss.workflow_status,
            'financial_result', ss.financial_result, 'status', ss.status,
            'customer_count', st.customer_count, 'invoice_count', st.invoice_count,
            'total_expected', st.expected_amount, 'total_applied_new', st.applied_amount,
            'total_pending_new', st.pending_amount, 'total_difference_new', 0::numeric(14,2),
            'resolved_invoice_count', st.resolved_invoice_count,
            'unresolved_invoice_count', st.unresolved_invoice_count,
            'review_required_count', st.review_required_count, 'notes', ss.notes
        ),
        'clients', COALESCE(cp.clients, '[]'::jsonb)
    ) INTO v_result
    FROM settlement_scope ss CROSS JOIN settlement_totals st CROSS JOIN client_payloads cp;

    RETURN COALESCE(v_result, jsonb_build_object('settlement', NULL, 'clients', '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION adquisiciones.get_route_settlement_detail(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION adquisiciones.get_route_settlement_detail(uuid) TO authenticated;
