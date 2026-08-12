-- =========================================================================================
-- MIGRATION: M1.5E.13 - Contexto de evidencia para conteo manual (solo lectura)
-- =========================================================================================
-- RPC de solo lectura que entrega a Mobile los datos para construir el path de Storage
-- de evidencias fotograficas en futuros conteos manuales:
--     {company_id}/{session_id}/{actor_id}/{idempotency_key}.{ext}
-- Los valores company_id, session_id y actor_id provienen EXCLUSIVAMENTE del servidor:
--   - actor_id   = auth.uid() (via require_actor);
--   - company_id = zona/sesion/tarea contextuales autorizadas del COUNTER;
--   - session_id = sesion de la zona contextual autorizada.
-- No se confia en user_metadata/app_metadata ni en parametros de empresa/sesion de Mobile.
-- Guardas identicas al flujo COUNTER validado: acceso a empresa, COUNTER activo y vigente,
-- sesion COUNTING, tarea propia IN_PROGRESS, active_user_id=actor, asignacion vigente,
-- ubicacion OPEN y opened_by=actor. Ante cualquier falla se rechaza sin devolver contexto.

CREATE OR REPLACE FUNCTION inventarios.get_my_mobile_evidence_context(p_zone_id uuid, p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_session_id uuid;
    v_task_id uuid;
    v_is_authorized boolean := false;
    v_is_open boolean := false;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT z.company_id, t.id, z.session_id, true
    INTO v_company_id, v_task_id, v_session_id, v_is_authorized
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id = a.task_id
    JOIN inventarios.session_zones z ON z.id = t.session_zone_id
    JOIN inventarios.sessions s ON s.id = z.session_id
    JOIN inventarios.session_participants p ON p.id = a.session_participant_id
    WHERE z.id = p_zone_id
      AND a.user_id = v_actor_id
      AND a.released_at IS NULL
      AND p.user_id = v_actor_id
      AND p.functional_role = 'COUNTER'
      AND p.active_from <= pg_catalog.now()
      AND p.revoked_at IS NULL
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND t.status = 'IN_PROGRESS'
      AND t.active_user_id = v_actor_id
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;

    IF v_is_authorized IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'No tienes acceso a esta zona o la sesión no es válida.', 'retryable', false)::text;
    END IF;

    PERFORM inventarios.require_company_access(v_company_id);

    SELECT true INTO v_is_open
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id = tl.session_zone_location_id
    WHERE tl.company_id = v_company_id
      AND tl.task_id = v_task_id
      AND tl.session_zone_id = p_zone_id
      AND szl.session_zone_id = p_zone_id
      AND szl.location_id = p_location_id
      AND tl.opened_by = v_actor_id
      AND tl.status = 'OPEN';

    IF v_is_open IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_ACCESS_DENIED',
            DETAIL = pg_catalog.jsonb_build_object('message', 'La ubicación no está abierta para esta tarea.', 'retryable', false)::text;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'session_id', v_session_id,
        'actor_id', v_actor_id,
        'bucket', 'inventory-evidence'
    );
END;
$function$;

ALTER FUNCTION inventarios.get_my_mobile_evidence_context(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_my_mobile_evidence_context(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_my_mobile_evidence_context(uuid, uuid) TO authenticated;
