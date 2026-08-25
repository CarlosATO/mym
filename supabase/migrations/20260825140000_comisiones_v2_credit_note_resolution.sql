-- COMV2-28A: read-only credit-note resolution for Comisiones V2.
-- Bsale's current payload stores the referenced invoice folio in
-- referenced_document_number; referenced_document_id is preferred when it is
-- present. SKU, description and line position are deliberately not used.

CREATE OR REPLACE FUNCTION comisiones.get_credit_note_adjustment_candidates(
    p_company_id uuid,
    p_period_from date,
    p_period_to date
)
RETURNS TABLE (
    company_id uuid,
    credit_note_document_id uuid,
    credit_note_bsale_id bigint,
    credit_note_number bigint,
    credit_note_date date,
    credit_note_detail_id uuid,
    credit_note_detail_bsale_id bigint,
    nc_quantity numeric,
    nc_net_amount numeric,
    variant_id integer,
    original_invoice_document_id uuid,
    original_invoice_bsale_id bigint,
    original_invoice_number bigint,
    original_invoice_detail_id uuid,
    original_invoice_detail_bsale_id bigint,
    original_invoice_full_payment_date date,
    seller_bsale_id bigint,
    seller_name text,
    customer_bsale_id bigint,
    customer_name text,
    real_supplier_id uuid,
    real_supplier_name text,
    family_bsale_product_type_id integer,
    family_name text,
    original_settlement_id uuid,
    original_settlement_line_id uuid,
    original_plan_id uuid,
    original_plan_version_no integer,
    original_plan_type text,
    original_percentage numeric,
    original_base_amount numeric,
    original_commission_amount numeric,
    original_net_amount numeric,
    already_reversed_net_amount numeric,
    already_reversed_commission_amount numeric,
    remaining_reversible_net_amount numeric,
    remaining_reversible_commission_amount numeric,
    placement_status text,
    resolution_code text,
    resolution_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones, adquisiciones
AS $$
WITH settings AS (
    SELECT s.first_eligible_full_payment_date
    FROM comisiones.settings s
    WHERE s.company_id = p_company_id
      AND s.active
), credit_notes AS MATERIALIZED (
    SELECT
        n.company_id,
        n.id AS credit_note_document_id,
        n.bsale_id AS credit_note_bsale_id,
        n.number AS credit_note_number,
        n.emission_date AS credit_note_date,
        r.referenced_document_id,
        NULLIF(regexp_replace(COALESCE(r.referenced_document_number, ''), '[^0-9]', '', 'g'), '')::bigint AS referenced_number,
        COALESCE(r.referenced_document_type_id::text, r.referenced_document_type) AS referenced_type,
        r.id AS reference_row_id
    FROM integraciones.bsale_documents n
    CROSS JOIN settings s
    LEFT JOIN integraciones.bsale_document_references r
      ON r.company_id = n.company_id
     AND r.bsale_document_id = n.bsale_id
    WHERE n.company_id = p_company_id
      AND n.document_type_id = 2
      AND n.emission_date >= s.first_eligible_full_payment_date
      AND n.emission_date <= p_period_to
), document_resolution AS MATERIALIZED (
    SELECT
        cn.*,
        by_id.id AS id_document_id,
        by_id.bsale_id AS id_bsale_id,
        by_id.number AS id_number,
        by_number.document_id AS number_document_id,
        by_number.bsale_id AS number_bsale_id,
        by_number.number AS number_number,
        by_number.match_count AS number_match_count,
        CASE
            WHEN cn.reference_row_id IS NULL THEN 'UNRESOLVED'
            WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN ('5', '33') THEN 'AMBIGUOUS'
            WHEN cn.referenced_document_id IS NOT NULL
             AND by_id.bsale_id IS NOT NULL
             AND by_number.bsale_id IS NOT NULL
             AND by_id.bsale_id <> by_number.bsale_id THEN 'AMBIGUOUS'
            WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN 'RESOLVED'
            WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN 'RESOLVED'
            WHEN by_number.match_count > 1 THEN 'AMBIGUOUS'
            ELSE 'UNRESOLVED'
        END AS document_resolution_status,
        CASE
            WHEN cn.reference_row_id IS NULL THEN 'REFERENCE_MISSING'
            WHEN cn.referenced_type IS NOT NULL AND cn.referenced_type NOT IN ('5', '33') THEN 'REFERENCE_TYPE_CONFLICT'
            WHEN cn.referenced_document_id IS NOT NULL
             AND by_id.bsale_id IS NOT NULL
             AND by_number.bsale_id IS NOT NULL
             AND by_id.bsale_id <> by_number.bsale_id THEN 'REFERENCE_ID_NUMBER_CONFLICT'
            WHEN cn.referenced_document_id IS NOT NULL AND by_id.bsale_id IS NOT NULL THEN 'REFERENCE_ID_RESOLVED'
            WHEN cn.referenced_document_id IS NULL AND by_number.match_count = 1 THEN 'REFERENCE_NUMBER_RESOLVED'
            WHEN by_number.match_count > 1 THEN 'REFERENCE_NUMBER_AMBIGUOUS'
            ELSE 'REFERENCE_INVOICE_NOT_FOUND'
        END AS document_resolution_code
    FROM credit_notes cn
    LEFT JOIN integraciones.bsale_documents by_id
      ON by_id.company_id = cn.company_id
     AND by_id.bsale_id = cn.referenced_document_id
     AND by_id.document_type_id = 5
    LEFT JOIN LATERAL (
        SELECT d.id AS document_id, d.bsale_id, d.number, count(*) OVER () AS match_count
        FROM integraciones.bsale_documents d
        WHERE d.company_id = cn.company_id
          AND d.document_type_id = 5
          AND d.number = cn.referenced_number::integer
    ) by_number ON true
), nc_lines AS MATERIALIZED (
    SELECT
        dr.*,
        nd.id AS credit_note_detail_id,
        nd.bsale_id AS credit_note_detail_bsale_id,
        nd.quantity AS raw_quantity,
        nd.net_amount AS raw_net_amount,
        nd.variant_id,
        original_doc.id AS original_invoice_document_id,
        original_doc.bsale_id AS original_invoice_bsale_id,
        original_doc.number AS original_invoice_number,
        original_doc.emission_date AS original_invoice_emission_date,
        original_detail.id AS original_invoice_detail_id,
        original_detail.bsale_id AS original_invoice_detail_bsale_id,
        original_detail.net_amount AS original_invoice_line_net_amount,
        original_detail.match_count AS original_variant_match_count,
        original_detail.id AS resolved_original_detail_id,
        original_detail.variant_id AS resolved_variant_id
    FROM document_resolution dr
    JOIN integraciones.bsale_document_details nd
      ON nd.company_id = dr.company_id
     AND nd.bsale_document_id = dr.credit_note_bsale_id
    LEFT JOIN integraciones.bsale_documents original_doc
      ON original_doc.company_id = dr.company_id
     AND original_doc.bsale_id = CASE
            WHEN dr.document_resolution_status = 'RESOLVED'
            THEN COALESCE(dr.id_bsale_id, dr.number_bsale_id)
            ELSE NULL
        END
     AND original_doc.document_type_id = 5
    LEFT JOIN LATERAL (
        SELECT
            (array_agg(d.id ORDER BY d.id))[1] AS id,
            min(d.bsale_id) AS bsale_id,
            min(d.net_amount) AS net_amount,
            min(d.variant_id) AS variant_id,
            count(*)::bigint AS match_count
        FROM integraciones.bsale_document_details d
        WHERE d.company_id = nd.company_id
          AND d.bsale_document_id = original_doc.bsale_id
          AND d.variant_id = nd.variant_id
    ) original_detail ON true
), original_context AS MATERIALIZED (
    SELECT
        l.*,
        r.last_payment_date::date AS original_invoice_full_payment_date,
        r.bsale_client_id::bigint AS customer_bsale_id,
        r.client_name AS customer_name,
        ds.seller_bsale_id,
        ds.seller_name,
        sr.real_supplier_id AS current_real_supplier_id,
        sr.real_supplier_business_name AS current_real_supplier_name,
        sr.family_bsale_product_type_id AS current_family_id,
        sr.family_name AS current_family_name
    FROM nc_lines l
    LEFT JOIN comisiones.vw_v2_real_invoice_receivables r
      ON r.company_id = l.company_id
     AND r.bsale_document_id = l.original_invoice_bsale_id
    LEFT JOIN LATERAL (
        SELECT s.seller_bsale_id, s.seller_name
        FROM integraciones.bsale_document_sellers s
        WHERE s.company_id = l.company_id
          AND s.bsale_document_id = l.original_invoice_bsale_id
          AND s.is_primary
        ORDER BY s.id
        LIMIT 1
    ) ds ON true
    LEFT JOIN comisiones.vw_sales_line_resolution sr
      ON sr.company_id = l.company_id
     AND sr.detail_id = l.resolved_original_detail_id
), issued_invoice AS MATERIALIZED (
    SELECT
        sl.company_id,
        COALESCE(sl.original_invoice_line_id, sl.source_document_line_id) AS original_line_id,
        count(*) AS issued_invoice_count,
        (array_agg(sl.id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS original_settlement_line_id,
        (array_agg(sl.settlement_id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS original_settlement_id,
        (array_agg(sl.plan_id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS plan_id,
        (array_agg(sl.plan_version_no ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS plan_version_no,
        (array_agg(sl.plan_type ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS plan_type,
        (array_agg(sl.percentage ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS percentage,
        (array_agg(sl.base_amount ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS base_amount,
        (array_agg(sl.commission_amount ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS commission_amount,
        (array_agg(sl.net_amount ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS net_amount,
        (array_agg(sl.real_supplier_id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS real_supplier_id,
        (array_agg(sl.real_supplier_name_snapshot ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS real_supplier_name,
        (array_agg(sl.family_bsale_product_type_id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS family_id,
        (array_agg(sl.family_name_snapshot ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS family_name,
        (array_agg(sl.seller_bsale_id ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS seller_bsale_id,
        (array_agg(sl.seller_name_snapshot ORDER BY sl.issued_at DESC NULLS LAST, sl.id DESC))[1] AS seller_name
    FROM comisiones.settlement_lines sl
    JOIN comisiones.settlements s
      ON s.company_id = sl.company_id
     AND s.id = sl.settlement_id
    WHERE sl.company_id = p_company_id
      AND sl.line_kind = 'INVOICE'
      AND s.status = 'ISSUED'
    GROUP BY sl.company_id, COALESCE(sl.original_invoice_line_id, sl.source_document_line_id)
), issued_reversals AS MATERIALIZED (
    SELECT
        sl.company_id,
        sl.original_invoice_line_id AS original_line_id,
        sum(ABS(sl.net_amount)) AS already_reversed_net_amount,
        sum(ABS(sl.commission_amount)) AS already_reversed_commission_amount
    FROM comisiones.settlement_lines sl
    JOIN comisiones.settlements s
      ON s.company_id = sl.company_id
     AND s.id = sl.settlement_id
    WHERE sl.company_id = p_company_id
      AND sl.line_kind = 'CREDIT_NOTE'
      AND s.status = 'ISSUED'
      AND sl.original_invoice_line_id IS NOT NULL
    GROUP BY sl.company_id, sl.original_invoice_line_id
)
SELECT
    o.company_id,
    o.credit_note_document_id,
    o.credit_note_bsale_id::bigint,
    o.credit_note_number::bigint,
    o.credit_note_date,
    o.credit_note_detail_id,
    o.credit_note_detail_bsale_id::bigint,
    -ABS(COALESCE(o.raw_quantity, 0)),
    -ABS(COALESCE(o.raw_net_amount, 0)),
    o.variant_id,
    o.original_invoice_document_id,
    o.original_invoice_bsale_id::bigint,
    o.original_invoice_number::bigint,
    o.original_invoice_detail_id,
    o.original_invoice_detail_bsale_id::bigint,
    o.original_invoice_full_payment_date,
    COALESCE(h.seller_bsale_id, o.seller_bsale_id),
    COALESCE(h.seller_name, o.seller_name),
    o.customer_bsale_id,
    o.customer_name,
    COALESCE(h.real_supplier_id, o.current_real_supplier_id),
    COALESCE(h.real_supplier_name, o.current_real_supplier_name),
    COALESCE(h.family_id, o.current_family_id),
    COALESCE(h.family_name, o.current_family_name),
    CASE WHEN h.issued_invoice_count = 1 THEN h.original_settlement_id END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.original_settlement_line_id END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.plan_id END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.plan_version_no END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.plan_type END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.percentage END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.base_amount END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.commission_amount END,
    CASE WHEN h.issued_invoice_count = 1 THEN h.net_amount ELSE ABS(COALESCE(o.original_invoice_line_net_amount, 0)) END,
    COALESCE(x.already_reversed_net_amount, 0),
    COALESCE(x.already_reversed_commission_amount, 0),
    GREATEST(CASE WHEN h.issued_invoice_count = 1 THEN h.net_amount ELSE 0 END - COALESCE(x.already_reversed_net_amount, 0), 0),
    GREATEST(CASE WHEN h.issued_invoice_count = 1 THEN h.commission_amount ELSE 0 END - COALESCE(x.already_reversed_commission_amount, 0), 0),
    CASE
        WHEN o.document_resolution_status <> 'RESOLVED' THEN o.document_resolution_status
        WHEN o.variant_id IS NULL OR o.original_variant_match_count = 0 THEN 'UNRESOLVED'
        WHEN o.original_variant_match_count > 1 THEN 'AMBIGUOUS'
        WHEN h.issued_invoice_count > 1 THEN 'AMBIGUOUS'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_net_amount, 0) + ABS(o.raw_net_amount) > h.net_amount
            THEN 'UNRESOLVED'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_commission_amount, 0) >= h.commission_amount
            THEN 'UNRESOLVED'
        WHEN h.issued_invoice_count = 1 THEN 'HISTORICAL'
        WHEN o.original_invoice_full_payment_date BETWEEN p_period_from AND p_period_to
         AND o.original_invoice_full_payment_date >= (SELECT first_eligible_full_payment_date FROM settings)
         AND o.original_invoice_full_payment_date IS NOT NULL
            THEN 'SAME_PERIOD'
        ELSE 'NO_COMMISSION_HISTORY'
    END,
    CASE
        WHEN o.document_resolution_status <> 'RESOLVED' THEN o.document_resolution_code
        WHEN o.variant_id IS NULL THEN 'NC_VARIANT_MISSING'
        WHEN o.original_variant_match_count = 0 THEN 'ORIGINAL_VARIANT_NOT_FOUND'
        WHEN o.original_variant_match_count > 1 THEN 'ORIGINAL_VARIANT_AMBIGUOUS'
        WHEN h.issued_invoice_count > 1 THEN 'ORIGINAL_ISSUED_LINE_AMBIGUOUS'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_net_amount, 0) + ABS(o.raw_net_amount) > h.net_amount
            THEN 'REVERSAL_NET_EXCEEDS_REMAINING'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_commission_amount, 0) >= h.commission_amount
            THEN 'REVERSAL_COMMISSION_EXHAUSTED'
        WHEN h.issued_invoice_count = 1 THEN 'HISTORICAL_SNAPSHOT'
        WHEN o.original_invoice_full_payment_date BETWEEN p_period_from AND p_period_to
         AND o.original_invoice_full_payment_date >= (SELECT first_eligible_full_payment_date FROM settings)
            THEN 'CURRENT_PERIOD_PAYMENT_ELIGIBLE'
        ELSE 'NO_ISSUED_COMMISSION_HISTORY'
    END,
    CASE
        WHEN o.document_resolution_status = 'UNRESOLVED' THEN 'No deterministic Bsale invoice reference was found.'
        WHEN o.document_resolution_status = 'AMBIGUOUS' THEN 'Bsale invoice references conflict or identify more than one invoice.'
        WHEN o.variant_id IS NULL THEN 'Credit-note detail has no variant_id.'
        WHEN o.original_variant_match_count = 0 THEN 'No original invoice detail has the same variant_id.'
        WHEN o.original_variant_match_count > 1 THEN 'More than one original invoice detail has the same variant_id.'
        WHEN h.issued_invoice_count > 1 THEN 'More than one ISSUED V2 invoice line matches the original detail.'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_net_amount, 0) + ABS(o.raw_net_amount) > h.net_amount
            THEN 'Credit-note net amount exceeds the remaining reversible historical net amount.'
        WHEN h.issued_invoice_count = 1
         AND COALESCE(x.already_reversed_commission_amount, 0) >= h.commission_amount
            THEN 'Historical commission has no remaining reversible balance.'
        WHEN h.issued_invoice_count = 1 THEN 'Resolved against the ISSUED V2 snapshot; active rules are not consulted.'
        WHEN o.original_invoice_full_payment_date BETWEEN p_period_from AND p_period_to
         AND o.original_invoice_full_payment_date >= (SELECT first_eligible_full_payment_date FROM settings)
            THEN 'Invoice became V2-eligible in this period; the credit note remains an adjustment to that invoice.'
        ELSE 'Original invoice has no ISSUED V2 commission history; no automatic negative commission is allowed.'
    END
FROM original_context o
LEFT JOIN issued_invoice h
  ON h.company_id = o.company_id
 AND h.original_line_id = o.resolved_original_detail_id
LEFT JOIN issued_reversals x
  ON x.company_id = o.company_id
 AND x.original_line_id = o.resolved_original_detail_id
WHERE NOT EXISTS (
    SELECT 1
    FROM comisiones.line_locks lock
    WHERE lock.company_id = o.company_id
      AND lock.source_document_line_id = o.credit_note_detail_id
      AND lock.status IN ('ACTIVE', 'CONSUMED')
)
ORDER BY o.credit_note_date, o.credit_note_number, o.credit_note_detail_bsale_id;
$$;

REVOKE ALL ON FUNCTION comisiones.get_credit_note_adjustment_candidates(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_credit_note_adjustment_candidates(uuid, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION comisiones.get_credit_note_adjustment_candidates(uuid, date, date) IS
    'COMV2-28A deterministic Bsale credit-note to invoice/detail resolver. Uses stable IDs, then a unique invoice folio; never uses SKU or line position. Historical commission values come only from ISSUED settlement snapshots.';
