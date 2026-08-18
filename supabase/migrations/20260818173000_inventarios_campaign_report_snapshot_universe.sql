-- Align the web report with the frozen campaign stock universe.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_replaced text;
    v_new_theoretical text := $replacement$
     theoretical AS (
         SELECT r.product_id, r.bsale_variant_id, r.sku,
                coalesce(NULLIF(pg_catalog.btrim(r.entered_description), ''), r.sku) AS name,
                r.theoretical_quantity, r.unit_cost
         FROM (
             SELECT r.*,
                    pg_catalog.row_number() OVER (
                        PARTITION BY r.product_id ORDER BY r.row_index ASC, r.id ASC
                    ) AS product_rank
             FROM inventarios.stock_import_rows r
             JOIN inventarios.stock_imports si ON si.id = r.import_id
             WHERE si.company_id = p_company_id
               AND si.campaign_id = p_campaign_id
               AND si.status = 'VALIDATED'
               AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
               AND r.company_id = p_company_id
               AND r.row_status = 'VALID'
               AND r.product_id IS NOT NULL
               AND r.bsale_variant_id IS NOT NULL
               AND r.sku IS NOT NULL
               AND pg_catalog.btrim(r.sku) <> ''
               AND r.theoretical_quantity IS NOT NULL
         ) r
         WHERE r.product_rank = 1
     ),
$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.list_inventory_campaign_variances(uuid,uuid,text,text,text,integer,integer,text,text)'::regprocedure
    ) INTO v_definition;

    v_replaced := pg_catalog.regexp_replace(v_definition, '(?s)\s+theoretical AS \(.*?\s+\),\s+base AS', v_new_theoretical || '     base AS', 'gn');
    IF v_replaced = v_definition THEN
        RAISE EXCEPTION 'variance theoretical universe block not found';
    END IF;
    v_definition := v_replaced;

    v_definition := pg_catalog.replace(v_definition,
        'coalesce(ph.physical_quantity, 0) AS physical_quantity',
        'CASE WHEN coalesce(ph.contribution_count, 0) > 0 THEN ph.physical_quantity ELSE NULL END AS physical_quantity');
    v_definition := pg_catalog.replace(v_definition,
        '(d.physical_quantity - d.theoretical_quantity) AS difference_quantity',
        'CASE WHEN d.contribution_count > 0 THEN d.physical_quantity - d.theoretical_quantity ELSE NULL END AS difference_quantity');
    v_definition := pg_catalog.replace(v_definition,
        $$CASE
                    WHEN d.physical_quantity > 0 THEN 'COUNTED'
                    WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                    ELSE 'OUT_OF_SNAPSHOT'
                END AS coverage_status$$,
        $$CASE
                    WHEN NOT d.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT'
                    WHEN d.contribution_count > 0 THEN 'COUNTED'
                    ELSE 'NOT_COUNTED'
                END AS coverage_status$$);
    v_definition := pg_catalog.replace(v_definition,
        $$CASE
                    WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA'
                END AS variance_status$$,
        $$CASE
                    WHEN d.contribution_count = 0 THEN 'SIN_CONTEO'
                    WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                    WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                    ELSE 'SIN_DIFERENCIA'
                END AS variance_status$$);

    EXECUTE v_definition;
END;
$migration$;

-- The summary uses the same frozen import as the report. Its operational part is
-- retained from the existing contract; only stock fields are delegated to the
-- report read-model, preventing a second definition of the product universe.
DO $migration$
DECLARE
    v_definition text;
    v_replaced text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.get_inventory_campaign_review_summary(uuid,uuid)'::regprocedure
    ) INTO v_definition;
    v_replaced := pg_catalog.replace(v_definition,
        $$SELECT pg_catalog.count(*) INTO v_products_theoretical
     FROM inventarios.inventory_campaign_theoretical_stocks icts
     JOIN inventarios.inventory_campaign_snapshots cs
       ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id AND cs.campaign_id = p_campaign_id
     WHERE icts.company_id = p_company_id AND icts.scope_level = 'TOTAL_CAMPAIGN';$$,
        $$SELECT pg_catalog.count(*) INTO v_products_theoretical
     FROM (
         SELECT r.product_id
         FROM inventarios.stock_import_rows r
         JOIN inventarios.stock_imports si ON si.id = r.import_id
         WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
           AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
           AND r.company_id = p_company_id AND r.row_status = 'VALID'
           AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL
         GROUP BY r.product_id
     ) universe;$$);
    v_replaced := pg_catalog.replace(v_replaced,
        'coalesce(ph.physical_quantity, 0) AS physical_quantity',
        'ph.physical_quantity AS physical_quantity');
    v_replaced := pg_catalog.replace(v_replaced,
        '(d.physical_quantity - d.theoretical_quantity) AS difference_quantity',
        'CASE WHEN d.physical_quantity IS NOT NULL THEN d.physical_quantity - d.theoretical_quantity ELSE NULL END AS difference_quantity');
    v_replaced := pg_catalog.replace(v_replaced,
        $$CASE WHEN d.physical_quantity > 0 THEN 'COUNTED'
                     WHEN d.in_any_snapshot THEN 'NOT_COUNTED'
                     ELSE 'OUT_OF_SNAPSHOT' END AS coverage_status$$,
        $$CASE WHEN NOT d.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT'
                     WHEN d.physical_quantity IS NOT NULL THEN 'COUNTED'
                     ELSE 'NOT_COUNTED' END AS coverage_status$$);
    v_replaced := pg_catalog.replace(v_replaced,
        $$CASE WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                     WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                     ELSE 'SIN_DIFERENCIA' END AS variance_status$$,
        $$CASE WHEN d.physical_quantity IS NULL THEN 'SIN_CONTEO'
                     WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                     WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                     ELSE 'SIN_DIFERENCIA' END AS variance_status$$);
    IF v_replaced = v_definition THEN
        RAISE EXCEPTION 'campaign review summary stock block not found';
    END IF;
    EXECUTE v_replaced;
END;
$migration$;

ALTER FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_variances(uuid, uuid, text, text, text, integer, integer, text, text) TO authenticated, service_role;

COMMIT;
