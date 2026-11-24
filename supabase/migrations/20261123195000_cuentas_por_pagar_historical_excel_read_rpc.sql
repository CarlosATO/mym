-- Cuentas por Pagar | RPC de lectura controlada para coincidencias exactas del Excel histórico pagado.
-- Reutiliza cuentas_por_pagar.vw_historical_paid_excel_sii_match sin modificar tablas ni datos.

CREATE OR REPLACE FUNCTION public.cxp_historical_paid_excel_sii_matches()
RETURNS TABLE (
    batch_id uuid,
    source_row integer,
    issuer_rut_normalized text,
    document_folio text,
    document_issue_date date,
    reference_payment_date date,
    payment_date_basis text,
    document_total_clp numeric,
    credit_note_amount_clp numeric,
    has_excel_observation boolean,
    declared_payment_status text,
    declared_pending_balance_clp numeric,
    sii_matches integer,
    sii_document_id bigint,
    sii_emission_date date,
    sii_total_clp numeric,
    sii_code text,
    sii_match_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF auth.uid() IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        v.batch_id,
        v.source_row,
        v.issuer_rut_normalized::text,
        v.document_folio::text,
        v.document_issue_date,
        v.reference_payment_date,
        v.payment_date_basis::text,
        v.document_total_clp,
        v.credit_note_amount_clp,
        v.has_excel_observation,
        v.declared_payment_status::text,
        v.declared_pending_balance_clp,
        v.sii_matches,
        v.sii_document_id,
        v.sii_emission_date,
        v.sii_total_clp,
        v.sii_code::text,
        v.sii_match_status::text
    FROM cuentas_por_pagar.vw_historical_paid_excel_sii_match v
    WHERE v.company_id = v_company_id
      AND v.sii_match_status = 'EXACT'
      AND v.sii_matches = 1
      AND v.sii_document_id IS NOT NULL
    ORDER BY v.source_row ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_historical_paid_excel_sii_matches() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_historical_paid_excel_sii_matches() TO authenticated;

NOTIFY pgrst, 'reload schema';
