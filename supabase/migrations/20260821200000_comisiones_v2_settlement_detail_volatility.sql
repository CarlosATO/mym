-- COMV2-10 correction: permission checks make the detail routine VOLATILE.

CREATE OR REPLACE FUNCTION comisiones.get_settlement_detail(
    p_company_id uuid,
    p_settlement_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, comisiones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_settlement jsonb;
    v_lines jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'AUTH_REQUIRED';
    END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('comisiones.v2.read')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'COMPANY_ACCESS_DENIED';
    END IF;

    SELECT to_jsonb(s) - 'updated_by' INTO v_settlement
    FROM comisiones.settlements s
    WHERE s.company_id = p_company_id AND s.id = p_settlement_id;
    IF v_settlement IS NULL THEN
        RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(sl) ORDER BY sl.document_emission_date DESC, sl.source_document_number DESC, sl.source_document_detail_bsale_id), '[]'::jsonb)
    INTO v_lines
    FROM comisiones.settlement_lines sl
    WHERE sl.company_id = p_company_id AND sl.settlement_id = p_settlement_id;

    RETURN jsonb_build_object('settlement', v_settlement, 'lines', v_lines);
END;
$$;

REVOKE ALL ON FUNCTION comisiones.get_settlement_detail(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION comisiones.get_settlement_detail(uuid, uuid) TO authenticated, service_role;
