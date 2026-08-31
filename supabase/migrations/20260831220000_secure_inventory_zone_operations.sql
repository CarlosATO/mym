-- Secure inventory zone mutations with the canonical management permission.
-- Keep the function bodies unchanged apart from the authorization guard.

DO $$
DECLARE
    v_signature text;
    v_old_guard text;
    v_definition text;
    v_updated_definition text;
BEGIN
    FOR v_signature, v_old_guard IN
        SELECT * FROM (VALUES
        (
            'inventarios.assign_inventory_counting_zone(uuid,uuid,uuid,uuid,text,uuid[],uuid)',
            'inventarios.require_permission(p_company_id, ''inventarios.sessions.read'');'
        ),
        (
            'inventarios.add_inventory_counting_zone_progressive(uuid,uuid,uuid,uuid,text,uuid[],uuid)',
            'inventarios.require_permission(p_company_id,''inventarios.sessions.read'');'
        ),
        (
            'inventarios.cancel_inventory_counting_zone(uuid,uuid,uuid,uuid,text,uuid)',
            'inventarios.require_permission(p_company_id, ''inventarios.sessions.read'');'
        )
        ) AS guards(signature, old_guard)
    LOOP
        v_definition := pg_get_functiondef(to_regprocedure(v_signature));

        IF v_definition IS NULL THEN
            RAISE EXCEPTION 'Expected function % does not exist', v_signature;
        END IF;

        IF length(v_definition) - length(replace(v_definition, v_old_guard, '')) <> length(v_old_guard) THEN
            RAISE EXCEPTION 'Unexpected authorization guard in %', v_signature;
        END IF;

        v_updated_definition := replace(
            v_definition,
            v_old_guard,
            replace(v_old_guard, 'inventarios.sessions.read', 'inventarios.zones.manage')
        );
        EXECUTE v_updated_definition;
    END LOOP;
END;
$$;
