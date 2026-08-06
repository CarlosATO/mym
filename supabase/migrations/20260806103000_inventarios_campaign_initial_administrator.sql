-- 4I.3C.7C.3D.2: alta atomica del administrador de campana.
-- A) create_inventory_campaign inserta al actor creador como ADMINISTRATOR
--    activo en la misma transaccion (rollback conjunto si falla).
-- B) Backfill seguro: campañas existentes con creador valido reciben un
--    ADMINISTRATOR con la marca temporal de su creacion.

-- ============================================================
-- A. REDEFINICION DE create_inventory_campaign
--    Copia exacta de la version vigente (20260803140300) mas el alta
--    atomica del ADMINISTRATOR. Envelope de respuesta preservado.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.create_inventory_campaign(
    p_company_id uuid,
    p_name text,
    p_campaign_type text,
    p_planned_at timestamptz,
    p_site_scope text,
    p_product_scope text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_name text; v_campaign_type text; v_site_scope text; v_product_scope text;
    v_campaign_id uuid; v_occurred_at timestamptz;
    v_response jsonb;
BEGIN
    v_name := pg_catalog.btrim(coalesce(p_name, ''));
    v_campaign_type := pg_catalog.upper(pg_catalog.btrim(coalesce(p_campaign_type, '')));
    v_site_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_site_scope, '')));
    v_product_scope := pg_catalog.upper(pg_catalog.btrim(coalesce(p_product_scope, '')));
    IF p_company_id IS NULL OR v_name = '' OR pg_catalog.char_length(v_name) > 200
       OR v_campaign_type NOT IN ('GENERAL','SELECTIVE','EXTERNAL')
       OR v_site_scope NOT IN ('ALL_INTERNAL','SELECTED')
       OR v_product_scope NOT IN ('ALL','SELECTED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    -- Reglas por tipo
    IF v_campaign_type = 'GENERAL' AND (v_site_scope <> 'ALL_INTERNAL' OR v_product_scope <> 'ALL') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana general usa todas las bodegas internas y todos los productos.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'EXTERNAL' AND v_site_scope <> 'SELECTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana externa requiere unidades seleccionadas.','retryable',false)::text;
    END IF;
    IF v_campaign_type = 'SELECTIVE' AND v_site_scope = 'ALL_INTERNAL' AND v_product_scope = 'ALL' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SELECTIVE_SCOPE_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Una campana selectiva debe restringir al menos una dimension.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.manage');
    v_occurred_at := pg_catalog.now();

    INSERT INTO inventarios.inventory_campaigns (
        company_id, name, campaign_type, status, planned_at, site_scope, product_scope,
        created_at, created_by, updated_at, updated_by
    ) VALUES (
        p_company_id, v_name, v_campaign_type, 'DRAFT', p_planned_at,
        v_site_scope, v_product_scope,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_campaign_id;

    -- Alta atomica del ADMINISTRATOR: si falla, rollback completo de la campana.
    INSERT INTO inventarios.inventory_campaign_participants (
        company_id, campaign_id, user_id, participant_role, active_from, created_at, created_by
    ) VALUES (
        p_company_id, v_campaign_id, v_actor_id, 'ADMINISTRATOR',
        v_occurred_at, v_occurred_at, v_actor_id
    );

    v_response := pg_catalog.jsonb_build_object(
        'entity_id', v_campaign_id, 'state', 'DRAFT', 'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object('campaign_id', v_campaign_id, 'status', 'DRAFT')
    );
    RETURN v_response;
END;
$$;

ALTER FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.create_inventory_campaign(uuid, text, text, timestamptz, text, text) TO authenticated;

-- ============================================================
-- B. BACKFILL SEGURO DE ADMINISTRADORES EXISTENTES
--    Solo creadores validos: usuario activo y acceso activo a la
--    empresa. Idempotente: no duplica ADMINISTRATOR activos.
-- ============================================================
INSERT INTO inventarios.inventory_campaign_participants (
    company_id, campaign_id, user_id, participant_role, active_from, created_at, created_by
)
SELECT c.company_id, c.id, c.created_by, 'ADMINISTRATOR',
       c.created_at, c.created_at, c.created_by
FROM inventarios.inventory_campaigns c
WHERE c.created_by IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM portal.users u
      WHERE u.id = c.created_by AND u.is_active = true AND u.deleted_at IS NULL
  )
  AND EXISTS (
      SELECT 1 FROM core.user_company_access uca
      WHERE uca.user_id = c.created_by AND uca.company_id = c.company_id
        AND uca.is_active = true
  )
  AND NOT EXISTS (
      SELECT 1 FROM inventarios.inventory_campaign_participants p
      WHERE p.company_id = c.company_id AND p.campaign_id = c.id
        AND p.participant_role = 'ADMINISTRATOR' AND p.revoked_at IS NULL
  );
