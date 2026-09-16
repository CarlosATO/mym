CREATE OR REPLACE FUNCTION integraciones.get_bsale_stock_break_summary_60d(
    p_company_id uuid,
    p_office_id int
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, integraciones
AS $$
    SELECT COALESCE(
        jsonb_object_agg(
            variant_id::text,
            jsonb_build_object(
                'breakDays', confirmed_break_days_60d,
                'lastBreakDate', last_break_date
            )
        ),
        '{}'::jsonb
    )
    FROM integraciones.bsale_stock_break_summary_60d
    WHERE company_id = p_company_id
      AND office_id = p_office_id;
$$;

REVOKE ALL ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.get_bsale_stock_break_summary_60d(uuid, int) TO service_role;
