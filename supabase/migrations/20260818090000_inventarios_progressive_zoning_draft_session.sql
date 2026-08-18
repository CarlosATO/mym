-- A DRAFT session may finish its initial zone configuration even when another
-- session in the same campaign is already PREPARED or COUNTING.
-- Campaign terminal states remain globally blocking.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_campaign_guard text := $guard$
    IF v_campaign_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_DRAFT', DETAIL=pg_catalog.jsonb_build_object('message','La campana no esta en DRAFT.','retryable',false,'status',v_campaign_status)::text;
    END IF;
    IF inventarios.campaign_is_prepared(p_company_id, p_campaign_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ALREADY_PREPARED', DETAIL=pg_catalog.jsonb_build_object('message','La campana ya fue preparada y no admite configuracion.','retryable',false)::text;
    END IF;
$guard$;
    v_replacement text := $replacement$
    IF v_campaign_status NOT IN ('DRAFT','IN_PROGRESS') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_NOT_OPEN', DETAIL=pg_catalog.jsonb_build_object('message','El inventario ya no admite nuevas zonas.','retryable',false,'status',v_campaign_status)::text;
    END IF;
$replacement$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.assign_inventory_counting_zone(uuid,uuid,uuid,uuid,text,uuid[],uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, v_campaign_guard) = 0 THEN
        RAISE EXCEPTION 'assign_inventory_counting_zone campaign guard was not found';
    END IF;

    v_definition := pg_catalog.replace(v_definition, v_campaign_guard, v_replacement);
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
