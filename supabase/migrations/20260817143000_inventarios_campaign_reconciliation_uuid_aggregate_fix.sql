-- PostgreSQL no define max(uuid). Corrige la selección determinista de la
-- única official_version vigente sin modificar el contrato del RPC.

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'inventarios.refresh_inventory_campaign_stock_reconciliation(uuid, uuid)'::regprocedure
    ) INTO v_definition;

    v_definition := replace(
        v_definition,
        'max(ov.id) AS official_version_id',
        '(array_agg(ov.id ORDER BY ov.id))[1] AS official_version_id'
    );
    v_definition := replace(
        v_definition,
        'max(ov.snapshot_id) AS snapshot_id',
        '(array_agg(ov.snapshot_id ORDER BY ov.snapshot_id))[1] AS snapshot_id'
    );

    EXECUTE v_definition;
END;
$migration$;
