-- Use canonical RBAC authorization for global campaign closing.
-- Keep all close/readiness behavior unchanged apart from authorization.

DO $$
DECLARE
    v_signature text;
    v_old_text text;
    v_new_text text;
    v_definition text;
    v_updated_definition text;
BEGIN
    FOR v_signature, v_old_text, v_new_text IN
        SELECT * FROM (VALUES
        (
            'inventarios.admin_close_inventory_campaign(uuid,uuid,text,uuid,boolean)',
            E'    -- ---------- Autorización ----------\n    SELECT r.name INTO v_role_name\n    FROM portal.users u\n    JOIN portal.roles r ON r.id = u.role_id\n    WHERE u.id = v_actor_id AND u.is_active = true;\n    v_is_super := coalesce(v_role_name = ''SUPER_USUARIO'', false);\n\n    SELECT EXISTS (\n        SELECT 1 FROM inventarios.inventory_campaign_participants icp\n        WHERE icp.company_id = p_company_id\n          AND icp.campaign_id = p_campaign_id\n          AND icp.user_id = v_actor_id\n          AND icp.participant_role = ''ADMINISTRATOR''\n          AND icp.active_from <= pg_catalog.now()\n          AND icp.revoked_at IS NULL\n    ) INTO v_is_campaign_admin;\n\n    IF NOT (v_is_super OR v_is_campaign_admin) THEN\n        RAISE EXCEPTION USING ERRCODE=''P0001'', MESSAGE=''INV_PERMISSION_REQUIRED'',\n            DETAIL=pg_catalog.jsonb_build_object(''message'',''No tienes permisos para cerrar este inventario.'',''retryable'',false)::text;\n    END IF;\n',
            E'    -- ---------- Autorización canónica ----------\n    v_actor_id := inventarios.require_permission(p_company_id, ''inventarios.campaigns.manage'');\n'
        ),
        (
            'inventarios.get_inventory_campaign_close_readiness(uuid,uuid)',
            E'    SELECT r.name INTO v_role_name\n    FROM portal.users u\n    JOIN portal.roles r ON r.id = u.role_id\n    WHERE u.id = v_actor_id AND u.is_active = true;\n    v_is_super := coalesce(v_role_name = ''SUPER_USUARIO'', false);\n\n    SELECT EXISTS (\n        SELECT 1 FROM inventarios.inventory_campaign_participants icp\n        WHERE icp.company_id = p_company_id\n          AND icp.campaign_id = p_campaign_id\n          AND icp.user_id = v_actor_id\n          AND icp.participant_role = ''ADMINISTRATOR''\n          AND icp.active_from <= pg_catalog.now()\n          AND icp.revoked_at IS NULL\n    ) INTO v_is_campaign_admin;\n\n    v_can_close_authorized := (v_is_super OR v_is_campaign_admin);\n',
            E'    v_can_close_authorized := core.has_permission_for_company(v_actor_id, p_company_id, ''inventarios.campaigns.manage'');\n'
        )
        ) AS replacements(signature, old_text, new_text)
    LOOP
        v_definition := pg_get_functiondef(to_regprocedure(v_signature));

        IF v_definition IS NULL THEN
            RAISE EXCEPTION 'Expected function % does not exist', v_signature;
        END IF;

        IF strpos(v_definition, v_old_text) = 0
           OR length(v_definition) - length(replace(v_definition, v_old_text, '')) <> length(v_old_text) THEN
            RAISE EXCEPTION 'Unexpected authorization block in %', v_signature;
        END IF;

        v_updated_definition := replace(v_definition, v_old_text, v_new_text);
        EXECUTE v_updated_definition;
    END LOOP;
END;
$$;
