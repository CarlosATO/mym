-- =========================================================================================
-- MIGRATION: M1.5H - list_inventory_audit_resolvable_audits (contrato read-only ERP)
-- =========================================================================================
-- Objetivo:
--   Permitir que la UI de resolucion administrativa reentre en auditorias parcialmente
--   resueltas. Devuelve las auditorias de una campana que AUN admiten decision de producto:
--     * SUBMITTED            -> todos los productos pendientes;
--     * PARTIALLY_RESOLVED   -> quedan productos SUBMITTED pendientes (y otros ya decididos).
--   Es el contrato read-only especifico del flujo de RESOLUCION: no reutiliza
--   list_inventory_audit_candidates (flujo de ASIGNACION) y no mezcla ambos.
--
--   No muta nada. No forma parte del motor de APPROVE/REJECT.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_audit_resolvable_audits(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_status text;
    v_items jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT ic.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns ic
    WHERE ic.company_id = p_company_id AND ic.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', a.id,
                'audit_number', a.audit_number,
                'status', a.status,
                'assigned_user_id', a.assigned_user_id,
                'auditor_name', pu.nombre,
                'product_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id),
                'pending_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id AND ap.status = 'SUBMITTED'),
                'location_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l WHERE l.audit_id = a.id),
                'created_at', a.created_at
            ) ORDER BY a.audit_number
        )
    END
    INTO v_items
    FROM inventarios.inventory_audits a
    LEFT JOIN portal.users pu ON pu.id = a.assigned_user_id
    WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND a.status IN ('SUBMITTED','PARTIALLY_RESOLVED');

    RETURN pg_catalog.jsonb_build_object(
        'company_id', p_company_id,
        'campaign_id', p_campaign_id,
        'campaign_status', v_campaign_status,
        'total', pg_catalog.jsonb_array_length(v_items),
        'items', v_items
    );
END;
$function$;

ALTER FUNCTION inventarios.list_inventory_audit_resolvable_audits(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_inventory_audit_resolvable_audits(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_audit_resolvable_audits(uuid, uuid)
    TO authenticated, service_role;

COMMIT;
