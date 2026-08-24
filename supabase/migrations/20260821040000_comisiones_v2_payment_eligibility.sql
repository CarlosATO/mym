-- COMV2-05: read-only seller + full-payment eligibility contract.
-- Payment semantics are inherited from comercial.vw_customer_invoice_receivables.
-- V2 uses only comisiones.seller_profiles for seller configuration.

CREATE OR REPLACE FUNCTION comisiones.get_sales_line_payment_eligibility(
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
    emission_date date,
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
    seller_resolution_status text,
    seller_resolution_message text,
    seller_is_commissionable boolean,
    seller_is_active boolean,
    receivable_status text,
    total_amount numeric,
    paid_amount numeric,
    pending_amount numeric,
    full_payment_date timestamptz,
    payment_eligibility_status text,
    payment_eligibility_message text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, core, portal, comisiones, comercial, integraciones
AS $$
WITH primary_sellers AS (
    SELECT
        ds.company_id,
        ds.bsale_document_id,
        count(*) FILTER (WHERE ds.is_primary) AS primary_count,
        min(ds.seller_bsale_id) FILTER (WHERE ds.is_primary) AS primary_seller_id,
        array_agg(ds.seller_bsale_id ORDER BY ds.seller_bsale_id) FILTER (WHERE ds.is_primary) AS primary_seller_ids
    FROM integraciones.bsale_document_sellers ds
    GROUP BY ds.company_id, ds.bsale_document_id
), source_rows AS (
    SELECT
        r.company_id,
        r.document_id,
        r.document_bsale_id,
        r.document_number,
        r.emission_date,
        r.detail_id,
        r.detail_bsale_id,
        r.line_number,
        r.quantity,
        r.net_amount,
        r.variant_id,
        r.variant_code_snapshot,
        r.variant_description_snapshot,
        r.product_id,
        r.current_sku,
        r.current_product_description,
        r.product_is_active,
        r.bsale_brand_id,
        r.real_supplier_id,
        r.real_supplier_business_name,
        r.family_bsale_product_type_id,
        r.family_name,
        r.resolution_status::text AS resolution_status,
        r.resolution_code::text AS resolution_code,
        r.resolution_message,
        CASE WHEN ps.primary_count = 1 THEN ps.primary_seller_id END AS seller_bsale_id,
        sp.seller_name,
        COALESCE(ps.primary_count, 0) AS seller_primary_count,
        ps.primary_seller_ids AS seller_primary_ids,
        CASE
            WHEN COALESCE(ps.primary_count, 0) <> 1 THEN 'SELLER_UNRESOLVED'
            WHEN sp.id IS NULL THEN 'SELLER_UNRESOLVED'
            ELSE 'RESOLVED'
        END AS seller_resolution_status,
        CASE
            WHEN COALESCE(ps.primary_count, 0) = 0 THEN 'No existe vendedor primario para la factura.'
            WHEN ps.primary_count > 1 THEN 'La factura tiene múltiples vendedores primarios; no se eligió uno.'
            WHEN sp.id IS NULL THEN 'El vendedor primario no tiene perfil V2 en comisiones.seller_profiles.'
            ELSE 'Vendedor primario resuelto contra el perfil V2.'
        END AS seller_resolution_message,
        sp.is_commissionable AS seller_is_commissionable,
        sp.active AS seller_is_active,
        rec.receivable_status,
        rec.total_amount,
        rec.paid_amount,
        rec.pending_amount,
        rec.last_payment_date AS full_payment_date
    FROM comisiones.vw_sales_line_resolution r
    LEFT JOIN primary_sellers ps
      ON ps.company_id = r.company_id
     AND ps.bsale_document_id = r.document_bsale_id
    LEFT JOIN comisiones.seller_profiles sp
      ON sp.company_id = r.company_id
     AND sp.seller_bsale_id = CASE WHEN ps.primary_count = 1 THEN ps.primary_seller_id END
    LEFT JOIN comercial.vw_customer_invoice_receivables rec
      ON rec.company_id = r.company_id
     AND rec.bsale_document_id = r.document_bsale_id
     AND rec.document_type_id = 5
    WHERE r.company_id = p_company_id
      AND r.document_type_id = 5
      AND (rec.last_payment_date IS NULL OR rec.last_payment_date::date <= p_to)
      AND (
          (ps.primary_count = 1 AND ps.primary_seller_id = p_seller_bsale_id)
          OR COALESCE(ps.primary_count, 0) <> 1
      )
), classified AS (
    SELECT
        sr.*,
        CASE
            WHEN sr.seller_resolution_status = 'SELLER_UNRESOLVED' THEN 'SELLER_UNRESOLVED'
            WHEN sr.seller_bsale_id <> p_seller_bsale_id THEN 'SELLER_MISMATCH'
            WHEN sr.seller_is_active IS NOT TRUE OR sr.seller_is_commissionable IS NOT TRUE THEN 'SELLER_NOT_COMMISSIONABLE'
            WHEN sr.receivable_status IS NULL THEN 'PAYMENT_UNRESOLVED'
            WHEN sr.pending_amount <> 0 OR sr.receivable_status <> 'PAGADA' OR sr.full_payment_date IS NULL THEN 'NOT_FULLY_PAID'
            WHEN sr.full_payment_date::date < p_from OR sr.full_payment_date::date > p_to THEN 'PAYMENT_DATE_OUTSIDE_PERIOD'
            ELSE 'PAYMENT_ELIGIBLE'
        END AS payment_eligibility_status
    FROM source_rows sr
)
SELECT
    c.company_id,
    c.document_id,
    c.document_bsale_id::bigint,
    c.document_number::bigint,
    c.emission_date,
    c.detail_id,
    c.detail_bsale_id::bigint,
    c.line_number,
    c.quantity,
    c.net_amount,
    c.variant_id,
    c.variant_code_snapshot::text,
    c.variant_description_snapshot::text,
    c.product_id,
    c.current_sku::text,
    c.current_product_description::text,
    c.product_is_active,
    c.bsale_brand_id,
    c.real_supplier_id,
    c.real_supplier_business_name,
    c.family_bsale_product_type_id,
    c.family_name::text,
    c.resolution_status,
    c.resolution_code,
    c.resolution_message,
    c.seller_bsale_id,
    c.seller_name,
    c.seller_primary_count,
    c.seller_primary_ids,
    c.seller_resolution_status,
    c.seller_resolution_message,
    c.seller_is_commissionable,
    c.seller_is_active,
    c.receivable_status,
    c.total_amount,
    c.paid_amount,
    c.pending_amount,
    c.full_payment_date,
    c.payment_eligibility_status,
    CASE
        WHEN c.payment_eligibility_status = 'PAYMENT_ELIGIBLE' THEN 'Vendedor V2 y pago completo dentro del período.'
        WHEN c.payment_eligibility_status = 'NOT_FULLY_PAID' THEN 'La factura no está completamente pagada según el contrato de cuentas por cobrar.'
        WHEN c.payment_eligibility_status = 'PAYMENT_DATE_OUTSIDE_PERIOD' THEN 'El pago completo existe, pero su fecha está fuera del período seleccionado.'
        WHEN c.payment_eligibility_status = 'PAYMENT_UNRESOLVED' THEN 'No existe una fila de cuentas por cobrar para determinar el pago completo.'
        WHEN c.payment_eligibility_status = 'SELLER_MISMATCH' THEN 'El vendedor primario no coincide con el vendedor V2 seleccionado.'
        WHEN c.payment_eligibility_status = 'SELLER_NOT_COMMISSIONABLE' THEN 'El perfil V2 del vendedor no está activo o no es comisionable.'
        ELSE c.seller_resolution_message
    END AS payment_eligibility_message
FROM classified c
$$;

REVOKE ALL ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION comisiones.get_sales_line_payment_eligibility(uuid, bigint, date, date) TO authenticated, service_role;
