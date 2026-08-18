-- Complete the report contract rewrite for installations where the previous
-- migration had only replaced the first repeated CTE.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
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
             WHERE si.company_id = p_company_id AND si.campaign_id = p_campaign_id
               AND si.status = 'VALIDATED' AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
               AND r.company_id = p_company_id AND r.row_status = 'VALID'
               AND r.product_id IS NOT NULL AND r.bsale_variant_id IS NOT NULL
               AND r.sku IS NOT NULL AND pg_catalog.btrim(r.sku) <> ''
               AND r.theoretical_quantity IS NOT NULL
         ) r
         WHERE r.product_rank = 1
     ),
$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.list_inventory_campaign_variances(uuid,uuid,text,text,text,integer,integer,text,text)'::regprocedure
    ) INTO v_definition;
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        '(?s)\s+theoretical AS \(.*?\s+\),\s+base AS',
        v_new_theoretical || '     base AS',
        'g'
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        '(?s)CASE\s+WHEN d\.physical_quantity > 0 THEN ''COUNTED''.*?END AS coverage_status',
        $$CASE
                   WHEN NOT d.in_theoretical_stock THEN 'OUT_OF_SNAPSHOT'
                   WHEN d.contribution_count > 0 THEN 'COUNTED'
                   ELSE 'NOT_COUNTED'
               END AS coverage_status$$,
        'g'
    );
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        '(?s)CASE\s+WHEN \(d\.physical_quantity - d\.theoretical_quantity\) < 0 THEN ''FALTANTE''.*?END AS variance_status',
        $$CASE
                   WHEN d.contribution_count = 0 THEN 'SIN_CONTEO'
                   WHEN (d.physical_quantity - d.theoretical_quantity) < 0 THEN 'FALTANTE'
                   WHEN (d.physical_quantity - d.theoretical_quantity) > 0 THEN 'SOBRANTE'
                   ELSE 'SIN_DIFERENCIA'
               END AS variance_status$$,
        'g'
    );
    EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.get_inventory_campaign_review_summary(uuid,uuid)'::regprocedure
    ) INTO v_definition;
    v_definition := pg_catalog.regexp_replace(
        v_definition,
        '(?s)SELECT pg_catalog\.count\(\*\) INTO v_products_theoretical.*?scope_level = ''TOTAL_CAMPAIGN'';',
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
     ) universe;$$,
        'g'
    );
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
