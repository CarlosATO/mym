-- Administrative campaign close is allowed to finalize incomplete coverage.
-- Normal session transitions remain guarded by progressive-zoning coverage.
-- Schema affected exclusively: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios._guard_session_scope_coverage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_unzoned bigint;
    v_unvisited bigint;
BEGIN
    -- The campaign-level administrative close has already validated the actor,
    -- blockers, confirmation, and audit reason. Its transaction is the only
    -- path allowed to finalize an intentionally incomplete session.
    IF current_setting('inventarios.admin_close', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.status IN ('UNDER_REVIEW', 'APPROVED') AND OLD.status IS DISTINCT FROM NEW.status THEN
        SELECT count(*) INTO v_unzoned
        FROM inventarios.session_location_scopes slc
        WHERE slc.company_id = NEW.company_id
          AND slc.session_id = NEW.id
          AND slc.inclusion_type = 'INCLUDED'
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.session_zone_locations szl
              WHERE szl.company_id = slc.company_id
                AND szl.session_id = slc.session_id
                AND szl.location_id = slc.location_id
          );
        IF v_unzoned > 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_SCOPE_INCOMPLETE',
                DETAIL = pg_catalog.jsonb_build_object('message','La seccion aun tiene ubicaciones del alcance sin zonificar.','retryable',false,'unzoned_locations',v_unzoned)::text;
        END IF;

        SELECT count(*) INTO v_unvisited
        FROM inventarios.session_zone_locations szl
        WHERE szl.company_id = NEW.company_id
          AND szl.session_id = NEW.id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.task_locations tl
              WHERE tl.company_id = szl.company_id
                AND tl.session_id = szl.session_id
                AND tl.session_zone_location_id = szl.id
          );
        IF v_unvisited > 0 THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_SESSION_COVERAGE_INCOMPLETE',
                DETAIL = pg_catalog.jsonb_build_object('message','La seccion aun tiene ubicaciones zonificadas sin visitar.','retryable',false,'unvisited_locations',v_unvisited)::text;
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DO $migration$
DECLARE
    v_definition text;
    v_marker text := $$    -- ---------- Cancelar recounts abiertos ----------$$;
    v_insert text := $$    PERFORM pg_catalog.set_config('inventarios.admin_close', 'true', true);

    -- ---------- Cancelar recounts abiertos ----------$$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.admin_close_inventory_campaign(uuid,uuid,text,uuid,boolean)'::regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_marker) = 0 THEN
        RAISE EXCEPTION 'admin close progressive coverage marker not found';
    END IF;
    v_definition := pg_catalog.replace(v_definition, v_marker, v_insert);
    EXECUTE v_definition;
END;
$migration$;

ALTER FUNCTION inventarios._guard_session_scope_coverage() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._guard_session_scope_coverage() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
