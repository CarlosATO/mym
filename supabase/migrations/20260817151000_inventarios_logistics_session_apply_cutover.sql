-- Cutover definitivo: la aplicacion de Kardex ya no acepta el contrato
-- session-level. Las aplicaciones historicas permanecen solo como evidencia.

CREATE OR REPLACE FUNCTION inventarios.apply_inventory_logistics_v1(
    p_company_id uuid,
    p_official_version_id uuid,
    p_reconciliation_ids uuid[],
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_LOGISTICS_SESSION_FLOW_DEPRECATED';
END;
$function$;

ALTER FUNCTION inventarios.apply_inventory_logistics_v1(uuid, uuid, uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.apply_inventory_logistics_v1(uuid, uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;
