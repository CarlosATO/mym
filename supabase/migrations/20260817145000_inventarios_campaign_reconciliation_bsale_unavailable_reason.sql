-- Conserva la causa Bsale en la aplicabilidad logistica cuando no existe
-- una fila para la variante/oficina en la corrida vigente.
DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'inventarios.refresh_inventory_campaign_stock_reconciliation(uuid, uuid)'::regprocedure
    ) INTO v_definition;

    v_definition := replace(
        v_definition,
        $$IF v_latest_run_id IS NULL OR NOT v_bsale_exists THEN
            v_recon_reasons := array_append(v_recon_reasons, 'BSALE_STOCK_UNAVAILABLE');
        ELSE$$,
        $$IF v_latest_run_id IS NULL OR NOT v_bsale_exists THEN
            v_recon_reasons := array_append(v_recon_reasons, 'BSALE_STOCK_UNAVAILABLE');
            v_logistics_reasons := array_append(v_logistics_reasons, 'BSALE_STOCK_UNAVAILABLE');
        ELSE$$
    );

    EXECUTE v_definition;
END;
$migration$;
