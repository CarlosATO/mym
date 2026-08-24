-- COMV2-05B: operational V2 eligibility follows the validated V1 contract.
-- Only the commercial resolution is V2-specific. Payment semantics come from
-- comercial.vw_customer_invoice_receivables and are not recalculated here.

DROP FUNCTION IF EXISTS comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date);

CREATE FUNCTION comisiones.get_sales_line_payment_eligibility(
    p_company_id uuid,
    p_seller_bsale_id bigint,
    p_from date,
    p_to date
)
RETURNS TABLE (
    company_id uuid,
    document_id uuid,
    document_bsale_id bigint,
    document_number bigint,
    document_type_id integer,
    emission_date date,
    customer_bsale_id bigint,
    customer_name text,
    detail_id uuid,
    detail_bsale_id bigint,
    line_number integer,
    quantity numeric,
    net_amount numeric,
    variant_id integer,
    variant_code_snapshot text,
    variant_description_snapshot text,
    product_id uuid,
    current_sku text,
    current_product_description text,
    product_is_active boolean,
    bsale_brand_id integer,
    real_supplier_id uuid,
    real_supplier_business_name text,
    family_bsale_product_type_id integer,
    family_name text,
    resolution_status text,
    resolution_code text,
    resolution_message text,
    seller_bsale_id bigint,
    seller_name text,
    seller_primary_count bigint,
    seller_primary_ids bigint[],
    seller_is_commissionable boolean,
    seller_is_active boolean,
    receivable_status text,
    total_amount numeric,
    paid_amount numeric,
    pending_amount numeric,
    full_payment_date timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones
AS $$
WITH eligible_invoices AS MATERIALIZED (
    SELECT
        r.company_id,
        r.bsale_client_id,
        r.client_name AS customer_name,
        r.bsale_document_id,
        r.document_number,
        r.document_type_id,
        r.emission_date,
        r.receivable_status,
        r.total_amount,
        r.paid_amount,
        r.pending_amount,
        r.last_payment_date,
        ds.seller_bsale_id,
        ds.seller_name,
        sp.is_commissionable AS seller_is_commissionable,
        sp.active AS seller_is_active,
        (
            SELECT count(*)
            FROM integraciones.bsale_document_sellers all_ds
            WHERE all_ds.company_id = ds.company_id
              AND all_ds.bsale_document_id = ds.bsale_document_id
              AND all_ds.is_primary
        ) AS seller_primary_count,
        (
            SELECT array_agg(all_ds.seller_bsale_id ORDER BY all_ds.seller_bsale_id)
            FROM integraciones.bsale_document_sellers all_ds
            WHERE all_ds.company_id = ds.company_id
              AND all_ds.bsale_document_id = ds.bsale_document_id
              AND all_ds.is_primary
        ) AS seller_primary_ids
    FROM comercial.vw_customer_invoice_receivables r
    JOIN integraciones.bsale_document_sellers ds
      ON ds.company_id = r.company_id
     AND ds.bsale_document_id = r.bsale_document_id
     AND ds.is_primary
     AND ds.seller_bsale_id = p_seller_bsale_id
    JOIN comisiones.seller_profiles sp
      ON sp.company_id = ds.company_id
     AND sp.seller_bsale_id = ds.seller_bsale_id
     AND sp.active
     AND sp.is_commissionable
    WHERE r.company_id = p_company_id
      AND r.document_type_id = 5
      AND r.receivable_status = 'PAGADA'
      AND r.pending_amount = 0
      AND r.last_payment_date::date BETWEEN p_from AND p_to
      AND r.is_internal_account = false
      AND r.is_commissionable = true
), eligible_lines AS MATERIALIZED (
    SELECT
        i.*,
        d.id AS detail_id,
        d.bsale_id AS detail_bsale_id,
        d.line_number,
        d.quantity,
        d.net_amount,
        d.variant_id
    FROM eligible_invoices i
    JOIN integraciones.bsale_document_details d
      ON d.company_id = i.company_id
     AND d.bsale_document_id = i.bsale_document_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM comisiones.line_locks lock
        WHERE lock.company_id = d.company_id
          AND lock.source_document_line_id = d.id
          AND lock.status = 'ACTIVE'
    )
)
SELECT
    r.company_id,
    r.document_id,
    r.document_bsale_id::bigint,
    r.document_number::bigint,
    r.document_type_id,
    r.emission_date,
    e.bsale_client_id::bigint,
    e.customer_name,
    e.detail_id,
    e.detail_bsale_id::bigint,
    e.line_number,
    e.quantity,
    e.net_amount,
    e.variant_id,
    r.variant_code_snapshot::text,
    r.variant_description_snapshot::text,
    r.product_id,
    r.current_sku::text,
    r.current_product_description::text,
    r.product_is_active,
    r.bsale_brand_id,
    r.real_supplier_id,
    r.real_supplier_business_name,
    r.family_bsale_product_type_id,
    r.family_name::text,
    r.resolution_status::text,
    r.resolution_code::text,
    r.resolution_message,
    e.seller_bsale_id,
    e.seller_name,
    e.seller_primary_count,
    e.seller_primary_ids,
    e.seller_is_commissionable,
    e.seller_is_active,
    e.receivable_status,
    e.total_amount,
    e.paid_amount,
    e.pending_amount,
    e.last_payment_date
FROM eligible_lines e
JOIN comisiones.vw_sales_line_resolution r
  ON r.company_id = e.company_id
 AND r.detail_id = e.detail_id
ORDER BY e.last_payment_date DESC, e.document_number DESC, e.line_number;
$$;

COMMENT ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date) IS
    'COMV2 operational preview: returns only V1-eligible paid invoice lines, enriched by the V2 variant commercial resolution.';

REVOKE ALL ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date) TO authenticated, service_role;
