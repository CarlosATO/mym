-- Amplia exclusivamente los contratos publicos read-only campaign-level.
-- No modifica conciliacion, aplicaciones ni Kardex.

DROP FUNCTION IF EXISTS inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid);

CREATE FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS TABLE (
    id uuid,
    reconciliation_id uuid,
    bsale_variant_id integer,
    bsale_office_id integer,
    sku text,
    product_name text,
    physical_quantity numeric,
    bsale_quantity numeric,
    difference_quantity numeric,
    reconciliation_status text,
    logistics_applicability_status text,
    logistics_application_status text,
    logistics_block_reasons text[],
    source_count bigint,
    line_count bigint,
    latest_bsale_sync_run_id uuid,
    bsale_synced_at timestamptz
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    RETURN QUERY
    WITH latest AS (
        SELECT r.id
        FROM integraciones.bsale_sync_runs r
        WHERE r.company_id = p_company_id AND r.status = 'COMPLETED'
        ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
        LIMIT 1
    )
    SELECT i.id,
           i.reconciliation_id,
           i.bsale_variant_id,
           i.bsale_office_id,
           product.sku,
           product.product_name,
           i.physical_quantity,
           i.bsale_quantity,
           i.difference_quantity,
           CASE WHEN i.reconciliation_status <> 'APPLIED'
                      AND i.bsale_sync_run_id IS NOT NULL
                      AND i.bsale_sync_run_id IS DISTINCT FROM latest.id
                THEN 'STALE' ELSE i.reconciliation_status END,
           CASE WHEN i.reconciliation_status <> 'APPLIED'
                      AND i.bsale_sync_run_id IS NOT NULL
                      AND i.bsale_sync_run_id IS DISTINCT FROM latest.id
                THEN 'BLOCKED' ELSE i.logistics_applicability_status END,
           CASE WHEN i.reconciliation_status = 'APPLIED'
                      OR EXISTS (
                          SELECT 1
                          FROM inventarios.inventory_campaign_logistics_application_items ai
                          WHERE ai.company_id = i.company_id
                            AND ai.reconciliation_item_id = i.id
                            AND ai.result IN ('APPLIED', 'NO_OP')
                      )
                THEN 'APPLIED' ELSE 'NOT_APPLIED' END,
           i.logistics_block_reasons,
           (
               SELECT count(*)
               FROM inventarios.inventory_campaign_reconciliation_sources src
               WHERE src.reconciliation_id = i.reconciliation_id
                 AND src.source_status <> 'CANCELLED_EXCLUDED'
                 AND (
                     (src.official_version_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM inventarios.official_version_items oi
                         WHERE oi.company_id = src.company_id
                           AND oi.official_version_id = src.official_version_id
                           AND oi.bsale_variant_id = i.bsale_variant_id
                     ))
                     OR (src.official_version_id IS NULL AND EXISTS (
                         SELECT 1
                         FROM inventarios.inventory_campaign_reconciliation_lines il
                         JOIN inventarios.session_product_scopes sps
                           ON sps.company_id = il.company_id
                          AND sps.session_id = il.session_id
                          AND sps.bsale_variant_id = i.bsale_variant_id
                         WHERE il.company_id = i.company_id
                           AND il.reconciliation_item_id = i.id
                           AND il.session_id = src.session_id
                     ))
                 )
           ),
           (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_lines line WHERE line.reconciliation_item_id = i.id),
           latest.id,
           i.bsale_synced_at
    FROM inventarios.inventory_campaign_reconciliation_items i
    JOIN inventarios.inventory_campaign_reconciliations r
      ON r.id = i.reconciliation_id
    LEFT JOIN latest ON true
    LEFT JOIN LATERAL (
        SELECT sp.sku, sp.name AS product_name
        FROM inventarios.inventory_campaign_reconciliation_lines line
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = line.company_id
         AND sp.snapshot_id = line.snapshot_id
         AND sp.id = line.snapshot_product_id
        WHERE line.company_id = i.company_id
          AND line.reconciliation_item_id = i.id
        ORDER BY line.session_id, line.id
        LIMIT 1
    ) product ON true
    WHERE i.company_id = p_company_id
      AND r.company_id = p_company_id
      AND r.campaign_id = p_campaign_id
    ORDER BY i.bsale_variant_id, i.bsale_office_id, i.id;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(
    p_company_id uuid,
    p_campaign_id uuid,
    p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_item jsonb;
    v_sources jsonb;
    v_lines jsonb;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT to_jsonb(x) INTO v_item
    FROM (
        SELECT i.*,
               product.sku,
               product.product_name,
               CASE WHEN i.reconciliation_status = 'APPLIED'
                          OR EXISTS (
                              SELECT 1
                              FROM inventarios.inventory_campaign_logistics_application_items ai
                              WHERE ai.company_id = i.company_id
                                AND ai.reconciliation_item_id = i.id
                                AND ai.result IN ('APPLIED', 'NO_OP')
                          )
                    THEN 'APPLIED' ELSE 'NOT_APPLIED' END AS logistics_application_status
        FROM inventarios.inventory_campaign_reconciliation_items i
        JOIN inventarios.inventory_campaign_reconciliations r
          ON r.id = i.reconciliation_id
        LEFT JOIN LATERAL (
            SELECT sp.sku, sp.name AS product_name
            FROM inventarios.inventory_campaign_reconciliation_lines line
            JOIN inventarios.snapshot_products sp
              ON sp.company_id = line.company_id
             AND sp.snapshot_id = line.snapshot_id
             AND sp.id = line.snapshot_product_id
            WHERE line.company_id = i.company_id
              AND line.reconciliation_item_id = i.id
            ORDER BY line.session_id, line.id
            LIMIT 1
        ) product ON true
        WHERE i.company_id = p_company_id
          AND r.company_id = p_company_id
          AND r.campaign_id = p_campaign_id
          AND i.id = p_item_id
    ) x;
    IF v_item IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_RECONCILIATION_ITEM_NOT_FOUND';
    END IF;

    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.session_id), '[]'::jsonb)
    INTO v_sources
    FROM (
        SELECT s.*
        FROM inventarios.inventory_campaign_reconciliation_sources s
        WHERE s.company_id = p_company_id
          AND s.reconciliation_id = (v_item->>'reconciliation_id')::uuid
          AND s.bsale_office_id = (v_item->>'bsale_office_id')::integer
          AND (
              (s.official_version_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM inventarios.official_version_items oi
                  WHERE oi.company_id = s.company_id
                    AND oi.official_version_id = s.official_version_id
                    AND oi.bsale_variant_id = (v_item->>'bsale_variant_id')::integer
              ))
              OR (s.official_version_id IS NULL AND EXISTS (
                  SELECT 1 FROM inventarios.session_product_scopes sps
                  WHERE sps.company_id = s.company_id
                    AND sps.session_id = s.session_id
                    AND sps.bsale_variant_id = (v_item->>'bsale_variant_id')::integer
              ))
          )
    ) x;

    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.session_id, x.warehouse_id, x.logistics_location_id, x.id), '[]'::jsonb)
    INTO v_lines
    FROM (
        SELECT l.*,
               s.name AS session_name,
               w.name AS warehouse_name,
               loc.code AS logistics_location_code,
               loc.name AS logistics_location_name,
               l.physical_quantity AS target_quantity,
               app.previous_balance,
               app.delta,
               app.result AS application_result,
               app.stock_adjustment_id AS adjustment_id,
               app.stock_adjustment_item_id AS adjustment_item_id,
               app.kardex_movement_id,
               app.applied_at
        FROM inventarios.inventory_campaign_reconciliation_lines l
        LEFT JOIN inventarios.sessions s
          ON s.company_id = l.company_id AND s.id = l.session_id
        LEFT JOIN adquisiciones.warehouses w
          ON w.id = l.warehouse_id
        LEFT JOIN logistica.locations loc
          ON loc.company_id = l.company_id AND loc.id = l.logistics_location_id
        LEFT JOIN LATERAL (
            SELECT ai.previous_balance,
                   ai.delta,
                   ai.result,
                   ai.stock_adjustment_id,
                   ai.stock_adjustment_item_id,
                   ai.kardex_movement_id,
                   ai.applied_at
            FROM inventarios.inventory_campaign_logistics_application_items ai
            WHERE ai.company_id = l.company_id
              AND ai.reconciliation_line_id = l.id
              AND ai.result IN ('APPLIED', 'NO_OP')
            ORDER BY ai.applied_at DESC, ai.id DESC
            LIMIT 1
        ) app ON true
        WHERE l.company_id = p_company_id
          AND l.reconciliation_item_id = p_item_id
    ) x;

    RETURN jsonb_build_object(
        'item', v_item,
        'sources', v_sources,
        'lines', v_lines,
        'read_by', v_actor_id,
        'read_at', now()
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) TO authenticated, service_role;
