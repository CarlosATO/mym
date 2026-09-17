-- Preserve the optimized refresh while making persisted daily booleans NULL-safe.
ALTER TABLE integraciones.bsale_stock_availability_daily_60d
    ALTER COLUMN available_during_day DROP NOT NULL,
    ALTER COLUMN stockout_confirmed DROP NOT NULL,
    ALTER COLUMN state_known DROP NOT NULL;

ALTER FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date)
    RENAME TO refresh_bsale_stock_break_read_models_before_null_safe;

CREATE OR REPLACE FUNCTION integraciones.refresh_bsale_stock_break_read_models(
    p_company_id uuid,
    p_office_id int,
    p_date_from date,
    p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, integraciones
AS $$
DECLARE
    result jsonb;
BEGIN
    result := integraciones.refresh_bsale_stock_break_read_models_before_null_safe(
        p_company_id, p_office_id, p_date_from, p_date_to
    );

    UPDATE integraciones.bsale_stock_availability_daily_60d
    SET available_during_day = COALESCE(available_during_day, false),
        stockout_confirmed = COALESCE(stockout_confirmed, false),
        state_known = COALESCE(state_known, false)
    WHERE company_id = p_company_id
      AND office_id = p_office_id
      AND availability_date BETWEEN p_date_to - 59 AND p_date_to;

    ALTER TABLE integraciones.bsale_stock_availability_daily_60d
        ALTER COLUMN available_during_day SET NOT NULL,
        ALTER COLUMN stockout_confirmed SET NOT NULL,
        ALTER COLUMN state_known SET NOT NULL;

    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integraciones.refresh_bsale_stock_break_read_models(uuid, int, date, date) TO service_role;
