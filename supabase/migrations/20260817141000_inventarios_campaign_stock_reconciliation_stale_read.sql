-- Calcula STALE en lectura si aparece un sync Bsale posterior al ultimo refresh.
-- No modifica Kardex ni items APPLIED.

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(
    p_company_id uuid,
    p_campaign_id uuid
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
    v_reconciliation_id uuid;
    v_payload jsonb;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    SELECT id INTO v_reconciliation_id
    FROM inventarios.inventory_campaign_reconciliations
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id;
    WITH latest AS (
        SELECT r.id
        FROM integraciones.bsale_sync_runs r
        WHERE r.company_id = p_company_id AND r.status = 'COMPLETED'
        ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
        LIMIT 1
    ), statuses AS (
        SELECT i.*,
               CASE WHEN i.reconciliation_status <> 'APPLIED'
                          AND i.bsale_sync_run_id IS NOT NULL
                          AND i.bsale_sync_run_id IS DISTINCT FROM latest.id
                    THEN 'STALE' ELSE i.reconciliation_status END AS effective_status
        FROM inventarios.inventory_campaign_reconciliation_items i
        LEFT JOIN latest ON true
        WHERE i.reconciliation_id = v_reconciliation_id
    )
    SELECT jsonb_build_object(
        'reconciliation_id', v_reconciliation_id,
        'campaign_id', p_campaign_id,
        'status', r.status,
        'item_count', count(s.*),
        'ready_count', count(s.*) FILTER (WHERE s.effective_status = 'READY'),
        'mismatch_count', count(s.*) FILTER (WHERE s.effective_status = 'MISMATCH'),
        'blocked_count', count(s.*) FILTER (WHERE s.effective_status = 'BLOCKED'),
        'stale_count', count(s.*) FILTER (WHERE s.effective_status = 'STALE'),
        'applied_count', count(s.*) FILTER (WHERE s.effective_status = 'APPLIED'),
        'logistics_ready_count', count(s.*) FILTER (WHERE s.effective_status = 'READY' AND s.logistics_applicability_status = 'READY'),
        'logistics_blocked_count', count(s.*) FILTER (WHERE s.effective_status <> 'READY' OR s.logistics_applicability_status = 'BLOCKED'),
        'source_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources src WHERE src.reconciliation_id = v_reconciliation_id),
        'source_blocked_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources src WHERE src.reconciliation_id = v_reconciliation_id AND src.source_status = 'BLOCKED'),
        'source_cancelled_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources src WHERE src.reconciliation_id = v_reconciliation_id AND src.source_status = 'CANCELLED_EXCLUDED'),
        'read_by', v_actor_id,
        'read_at', now()
    ) INTO v_payload
    FROM inventarios.inventory_campaign_reconciliations r
    LEFT JOIN statuses s ON true
    WHERE r.id = v_reconciliation_id
    GROUP BY r.id, r.status;
    RETURN coalesce(v_payload, jsonb_build_object('reconciliation_id', NULL, 'campaign_id', p_campaign_id, 'item_count', 0));
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS TABLE (
    id uuid,
    reconciliation_id uuid,
    bsale_variant_id integer,
    bsale_office_id integer,
    physical_quantity numeric,
    bsale_quantity numeric,
    difference_quantity numeric,
    reconciliation_status text,
    logistics_applicability_status text,
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
    SELECT i.id, i.reconciliation_id, i.bsale_variant_id, i.bsale_office_id,
           i.physical_quantity, i.bsale_quantity, i.difference_quantity,
           CASE WHEN i.reconciliation_status <> 'APPLIED'
                     AND i.bsale_sync_run_id IS NOT NULL
                     AND i.bsale_sync_run_id IS DISTINCT FROM latest.id
                THEN 'STALE' ELSE i.reconciliation_status END,
           CASE WHEN i.reconciliation_status <> 'APPLIED'
                     AND i.bsale_sync_run_id IS NOT NULL
                     AND i.bsale_sync_run_id IS DISTINCT FROM latest.id
                THEN 'BLOCKED' ELSE i.logistics_applicability_status END,
           i.logistics_block_reasons,
           (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources src
            WHERE src.reconciliation_id = i.reconciliation_id
              AND src.bsale_office_id = i.bsale_office_id
              AND src.source_status <> 'CANCELLED_EXCLUDED'),
           (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_lines line WHERE line.reconciliation_item_id = i.id),
           latest.id, i.bsale_synced_at
    FROM inventarios.inventory_campaign_reconciliation_items i
    JOIN inventarios.inventory_campaign_reconciliations r ON r.id = i.reconciliation_id
    LEFT JOIN latest ON true
    WHERE i.company_id = p_company_id AND r.campaign_id = p_campaign_id
    ORDER BY i.bsale_variant_id, i.bsale_office_id, i.id;
END;
$function$;

ALTER FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) TO authenticated, service_role;
