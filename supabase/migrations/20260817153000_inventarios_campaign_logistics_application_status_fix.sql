-- Corrige el recálculo de cabecera: PostgreSQL no permite agregados dentro
-- de la expresión de un UPDATE.
DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'inventarios.apply_inventory_campaign_logistics(uuid, uuid, uuid[], uuid)'::regprocedure
    ) INTO v_definition;
    v_definition := replace(v_definition, 'v_failed_count integer := 0;',
        'v_failed_count integer := 0;
    v_pending_item_count integer := 0;
    v_applied_item_count integer := 0;
    v_ready_item_count integer := 0;');
    v_definition := replace(v_definition,
        $$UPDATE inventarios.inventory_campaign_reconciliations r
    SET status=CASE
        WHEN count(i.id) FILTER (WHERE i.reconciliation_status <> 'APPLIED')=0
             AND count(i.id) FILTER (WHERE i.reconciliation_status='APPLIED')>0 THEN 'APPLIED'
        WHEN count(i.id) FILTER (WHERE i.reconciliation_status='APPLIED')>0 THEN 'PARTIALLY_APPLIED'
        WHEN count(i.id) FILTER (WHERE i.reconciliation_status='READY')>0 THEN 'READY'
        ELSE 'BLOCKED' END,
        updated_at=now()
    FROM inventarios.inventory_campaign_reconciliation_items i
    WHERE r.id=v_reconciliation_id AND i.reconciliation_id=r.id;$$,
        $$SELECT count(*) FILTER (WHERE i.reconciliation_status <> 'APPLIED'),
           count(*) FILTER (WHERE i.reconciliation_status = 'APPLIED'),
           count(*) FILTER (WHERE i.reconciliation_status = 'READY')
    INTO v_pending_item_count, v_applied_item_count, v_ready_item_count
    FROM inventarios.inventory_campaign_reconciliation_items i
    WHERE i.reconciliation_id=v_reconciliation_id;
    UPDATE inventarios.inventory_campaign_reconciliations r
    SET status=CASE
        WHEN v_pending_item_count=0 AND v_applied_item_count>0 THEN 'APPLIED'
        WHEN v_applied_item_count>0 THEN 'PARTIALLY_APPLIED'
        WHEN v_ready_item_count>0 THEN 'READY'
        ELSE 'BLOCKED' END,
        updated_at=now()
    WHERE r.id=v_reconciliation_id;$$);
    EXECUTE v_definition;
END;
$migration$;
