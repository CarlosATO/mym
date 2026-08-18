-- Apply pagination to variance rows before JSON aggregation.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_old text;
    v_new text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.list_inventory_campaign_variances(uuid,uuid,text,text,text,integer,integer,text,text)'::regprocedure
    ) INTO v_definition;

    v_old := E'FROM computed c\\s+CROSS JOIN LATERAL \\(';
    v_new := E'     FROM (\n'
        || E'         SELECT c.*\n'
        || E'         FROM computed c\n'
        || E'         WHERE (v_search = '''' OR c.sku ILIKE ''%'' || v_search || ''%'' OR c.name ILIKE ''%'' || v_search || ''%'')\n'
        || E'           AND (v_var_status = '''' OR c.variance_status = v_var_status)\n'
        || E'           AND (v_cov_status = '''' OR c.coverage_status = v_cov_status)\n'
        || E'         ORDER BY\n'
        || E'             CASE\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''SKU'' THEN c.sku\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''NAME'' THEN c.name\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''VARIANCE_STATUS'' THEN c.variance_status\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''COVERAGE_STATUS'' THEN c.coverage_status\n'
        || E'             END ASC NULLS LAST,\n'
        || E'             CASE\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''SKU'' THEN c.sku\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''NAME'' THEN c.name\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''VARIANCE_STATUS'' THEN c.variance_status\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''COVERAGE_STATUS'' THEN c.coverage_status\n'
        || E'             END DESC NULLS LAST,\n'
        || E'             CASE\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''THEORETICAL'' THEN c.theoretical_quantity\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''PHYSICAL'' THEN c.physical_quantity\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''DIFFERENCE'' THEN c.difference_quantity\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''UNIT_COST'' THEN c.unit_cost\n'
        || E'                 WHEN v_sort_dir = ''ASC'' AND v_sort_by = ''DIFFERENCE_VALUE'' THEN coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)\n'
        || E'             END ASC NULLS LAST,\n'
        || E'             CASE\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''THEORETICAL'' THEN c.theoretical_quantity\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''PHYSICAL'' THEN c.physical_quantity\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''DIFFERENCE'' THEN c.difference_quantity\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''UNIT_COST'' THEN c.unit_cost\n'
        || E'                 WHEN v_sort_dir = ''DESC'' AND v_sort_by = ''DIFFERENCE_VALUE'' THEN coalesce(c.difference_quantity, 0::numeric) * coalesce(c.unit_cost, 0::numeric)\n'
        || E'             END DESC NULLS LAST,\n'
        || E'             c.sku, c.bsale_variant_id\n'
        || E'         LIMIT v_page_size OFFSET v_offset\n'
        || E'     ) c\n     CROSS JOIN LATERAL (';

    IF pg_catalog.regexp_replace(v_definition, v_old, v_new, 'n') = v_definition THEN
        RAISE EXCEPTION 'variance aggregation source block not found';
    END IF;
    v_definition := pg_catalog.regexp_replace(v_definition, v_old, v_new, 'n');

    v_old := E'(?s)(\\) ev\\s*)WHERE \\(v_search = ''''.*?LIMIT v_page_size OFFSET v_offset;';
    IF pg_catalog.regexp_replace(v_definition, v_old, E'\\1;', 'n') = v_definition THEN
        RAISE EXCEPTION 'variance aggregation trailing pagination block not found';
    END IF;
    v_definition := pg_catalog.regexp_replace(v_definition, v_old, E'\\1;', 'n');

    IF pg_catalog.strpos(v_definition, 'LIMIT v_page_size OFFSET v_offset') = 0
       OR pg_catalog.strpos(v_definition, 'SELECT c.*') = 0 THEN
        RAISE EXCEPTION 'variance row pagination was not installed';
    END IF;
    EXECUTE v_definition;
END;
$migration$;

ALTER FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
