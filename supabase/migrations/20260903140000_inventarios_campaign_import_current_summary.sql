-- Read model correction: file-level and row-level copies of the same issue
-- must not inflate the visible summary.

CREATE OR REPLACE FUNCTION inventarios.get_campaign_stock_import_current(
    p_company_id uuid,
    p_import_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_detail jsonb;
    v_valid_rows bigint;
    v_warning_count bigint;
    v_error_count bigint;
BEGIN
    v_detail := inventarios.get_campaign_stock_import(p_company_id, p_import_id);

    SELECT count(*) INTO v_valid_rows
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id
      AND r.import_id = p_import_id
      AND r.row_status IN ('VALID', 'WARNING')
      AND r.product_id IS NOT NULL
      AND r.bsale_variant_id IS NOT NULL
      AND r.theoretical_quantity IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.stock_import_row_issues i
          WHERE i.company_id = r.company_id AND i.import_id = r.import_id
            AND i.row_id = r.id AND i.issue_level = 'ERROR'
      )
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.stock_import_row_issues i
          WHERE i.company_id = r.company_id AND i.import_id = r.import_id
            AND i.row_id = r.id AND i.issue_code <> 'ZERO_COST'
      );

    SELECT count(*) INTO v_warning_count
    FROM (
        SELECT DISTINCT i.row_index, i.issue_code
        FROM inventarios.stock_import_row_issues i
        WHERE i.company_id = p_company_id
          AND i.import_id = p_import_id
          AND i.issue_level = 'WARNING'
    ) deduplicated;

    SELECT count(*) INTO v_error_count
    FROM inventarios.stock_import_row_issues i
    WHERE i.company_id = p_company_id
      AND i.import_id = p_import_id
      AND i.issue_level = 'ERROR';

    RETURN pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
                v_detail,
                '{summary,valid_rows}',
                pg_catalog.to_jsonb(COALESCE(v_valid_rows, 0)),
                true
            ),
            '{summary,issue_warning_count}',
            pg_catalog.to_jsonb(COALESCE(v_warning_count, 0)),
            true
        ),
        '{summary,issue_error_count}',
        pg_catalog.to_jsonb(COALESCE(v_error_count, 0)),
        true
    );
END;
$$;

ALTER FUNCTION inventarios.get_campaign_stock_import_current(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_campaign_stock_import_current(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_campaign_stock_import_current(uuid, uuid) TO authenticated;
