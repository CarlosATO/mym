-- Backfill inicial del mismo mecanismo usado por los triggers.
-- Permite instalar la sincronizacion en bases con warehouses preexistentes
-- sin insertar sites o mappings fuera del contrato central.
DO $$
DECLARE
    v_company_id uuid;
    v_actor_id uuid;
    v_warehouse record;
BEGIN
    FOR v_company_id IN
        SELECT DISTINCT company_id
        FROM adquisiciones.warehouses
        WHERE company_id IS NOT NULL
    LOOP
        SELECT u.id INTO v_actor_id
        FROM portal.users u
        JOIN core.user_company_access a ON a.user_id = u.id
            AND a.company_id = v_company_id AND a.is_active = true
        WHERE u.is_active = true
        ORDER BY u.created_at
        LIMIT 1;

        IF v_actor_id IS NULL THEN
            RAISE EXCEPTION 'No existe un usuario activo para el backfill de Inventarios en la empresa %', v_company_id;
        END IF;

        FOR v_warehouse IN
            SELECT id FROM adquisiciones.warehouses
            WHERE company_id = v_company_id
            ORDER BY code, id
        LOOP
            PERFORM inventarios.sync_internal_warehouse(
                v_company_id, v_warehouse.id, v_actor_id
            );
        END LOOP;
    END LOOP;
END;
$$;
