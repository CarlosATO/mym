-- El catálogo de Servicios solo presenta proveedores reales, activos y con RUT válido.
CREATE OR REPLACE FUNCTION public.cxp_service_suppliers()
RETURNS TABLE (
    id uuid,
    business_name text,
    fantasy_name text,
    rut text,
    payment_terms text,
    credit_days integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT s.id, s.business_name::text, s.fantasy_name::text,
        coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''))::text,
        s.payment_terms::text, s.credit_days
    FROM adquisiciones.suppliers s
    WHERE (s.company_id IS NULL OR s.company_id = v_company_id)
      AND s.supplier_kind = 'REAL'
      AND s.is_active = true
      AND s.status = 'ACTIVE'
      AND cuentas_por_pagar.is_valid_chilean_rut(
          upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), '')), '[.[:space:]-]', '', 'g'))
      )
    ORDER BY s.business_name;
END;
$$;

NOTIFY pgrst, 'reload schema';
