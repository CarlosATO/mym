-- Explicitly resolve a counting location as empty or abandon it by mistake.
-- Empty resolution is coverage evidence only; it never creates a count entry.

BEGIN;

ALTER TABLE inventarios.task_locations
    ADD COLUMN IF NOT EXISTS resolution_status text;

ALTER TABLE inventarios.task_locations
    DROP CONSTRAINT IF EXISTS chk_inventarios_task_locations_resolution_status;
ALTER TABLE inventarios.task_locations
    ADD CONSTRAINT chk_inventarios_task_locations_resolution_status
    CHECK (resolution_status IS NULL OR resolution_status IN ('COUNTED', 'EMPTY_REVIEWED', 'OPENED_BY_MISTAKE'));

CREATE OR REPLACE FUNCTION inventarios.task_selected_coverage_ok(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_session_zone_id uuid,
    p_cycle integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_required bigint;
BEGIN
    -- Every physical location must have a terminal visit. A mistake cancellation
    -- is deliberately not coverage and must be followed by a valid visit.
    SELECT count(*) INTO v_required
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id
      AND szl.session_id = p_session_id
      AND szl.session_zone_id = p_session_zone_id
      AND NOT EXISTS (
          SELECT 1
          FROM inventarios.task_locations tl
          WHERE tl.company_id = szl.company_id
            AND tl.task_id = p_task_id
            AND tl.session_zone_location_id = szl.id
            AND tl.status = 'CLOSED'
            AND coalesce(tl.resolution_status, 'COUNTED') <> 'OPENED_BY_MISTAKE'
            AND NOT EXISTS (
                SELECT 1
                FROM inventarios.task_locations newer
                WHERE newer.company_id = tl.company_id
                  AND newer.task_id = tl.task_id
                  AND newer.session_zone_location_id = tl.session_zone_location_id
                  AND newer.opened_at > tl.opened_at
            )
      );
    IF v_required > 0 THEN
        RETURN false;
    END IF;

    -- EMPTY_REVIEWED satisfies physical coverage without satisfying any
    -- product-location count combination. Counted locations retain the old
    -- product coverage rule.
    SELECT count(*) INTO v_required
    FROM (
        SELECT sp.id AS snapshot_product_id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = sps.company_id
         AND sp.product_id = sps.product_id
         AND sp.snapshot_id = (
             SELECT os.id FROM inventarios.operational_snapshots os
             WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
             ORDER BY os.snapshot_version DESC LIMIT 1
         )
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = p_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
        EXCEPT
        SELECT ce.snapshot_product_id, ce.snapshot_location_id
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND ce.task_id = p_task_id
          AND ce.task_cycle = p_cycle
          AND ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
        EXCEPT
        SELECT sp.id, szl.snapshot_location_id
        FROM inventarios.session_product_scopes sps
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = sps.company_id
         AND sp.product_id = sps.product_id
         AND sp.snapshot_id = (
             SELECT os.id FROM inventarios.operational_snapshots os
             WHERE os.company_id = sps.company_id AND os.session_id = sps.session_id
             ORDER BY os.snapshot_version DESC LIMIT 1
         )
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = sps.company_id
         AND szl.session_id = sps.session_id
         AND szl.session_zone_id = p_session_zone_id
        WHERE sps.company_id = p_company_id
          AND sps.session_id = p_session_id
          AND sps.inclusion_type = 'INCLUDED'
          AND sps.product_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM inventarios.task_locations tl
              WHERE tl.company_id = szl.company_id
                AND tl.task_id = p_task_id
                AND tl.session_zone_location_id = szl.id
                AND tl.status = 'CLOSED'
                AND tl.resolution_status = 'EMPTY_REVIEWED'
                AND NOT EXISTS (
                    SELECT 1 FROM inventarios.task_locations newer
                    WHERE newer.company_id = tl.company_id
                      AND newer.task_id = tl.task_id
                      AND newer.session_zone_location_id = tl.session_zone_location_id
                      AND newer.opened_at > tl.opened_at
                )
          )
    ) missing_combinations;

    RETURN v_required = 0;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios._resolve_my_counting_location(
    p_zone_id uuid,
    p_location_id uuid,
    p_resolution_status text,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid; v_company_id uuid; v_session_id uuid; v_task_id uuid;
    v_task_cycle integer; v_assignment_id uuid; v_task_location_id uuid;
    v_event_id uuid; v_operation jsonb; v_operation_id uuid;
    v_occurred_at timestamptz := pg_catalog.now(); v_response jsonb;
BEGIN
    IF p_zone_id IS NULL OR p_location_id IS NULL OR p_idempotency_key IS NULL
       OR p_resolution_status NOT IN ('EMPTY_REVIEWED','OPENED_BY_MISTAKE') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF p_resolution_status = 'OPENED_BY_MISTAKE'
       AND pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason,''))) < 5 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_REASON_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','Debes indicar el motivo de la apertura accidental.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    SELECT z.company_id, z.session_id, t.id, t.validation_cycle, a.id
    INTO v_company_id, v_session_id, v_task_id, v_task_cycle, v_assignment_id
    FROM inventarios.task_assignments a
    JOIN inventarios.tasks t ON t.id=a.task_id
    JOIN inventarios.session_zones z ON z.id=t.session_zone_id
    JOIN inventarios.sessions s ON s.id=z.session_id
    WHERE z.id=p_zone_id AND a.user_id=v_actor_id AND a.released_at IS NULL
      AND s.status='COUNTING' AND z.is_enabled AND t.status='IN_PROGRESS'
      AND t.active_user_id=v_actor_id AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL AND t.invalidated_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a esta zona o la sesión no es válida.','retryable',false)::text;
    END IF;
    PERFORM inventarios.require_company_access(v_company_id);

    v_operation := inventarios.begin_idempotent_operation(
        v_company_id, 'inventarios.resolve_my_counting_location', p_idempotency_key,
        inventarios.compute_request_hash(pg_catalog.jsonb_build_object(
            'zone_id',p_zone_id,'location_id',p_location_id,
            'resolution_status',p_resolution_status,'reason',p_reason)));
    IF v_operation->>'mode'='REPLAY' THEN RETURN v_operation->'response_payload'; END IF;
    v_operation_id := (v_operation->>'operation_id')::uuid;

    SELECT tl.id INTO v_task_location_id
    FROM inventarios.task_locations tl
    JOIN inventarios.session_zone_locations szl ON szl.id=tl.session_zone_location_id
    WHERE tl.company_id=v_company_id AND tl.task_id=v_task_id
      AND szl.session_zone_id=p_zone_id AND szl.location_id=p_location_id
      AND tl.opened_by=v_actor_id AND tl.status='OPEN'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_LOCATION_NOT_OPEN',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no está abierta por este usuario.','retryable',false)::text;
    END IF;

    UPDATE inventarios.task_locations
    SET status='CLOSED', closed_at=v_occurred_at, closed_by=v_actor_id,
        resolution_status=p_resolution_status
    WHERE id=v_task_location_id AND status='OPEN';

    INSERT INTO inventarios.task_events(
        company_id,session_id,session_zone_id,task_id,event_type,actor_id,cycle,
        occurred_at,idempotency_key,source,technical_metadata,created_at,created_by)
    VALUES(
        v_company_id,v_session_id,p_zone_id,v_task_id,
        CASE WHEN p_resolution_status='EMPTY_REVIEWED' THEN 'LOCATION_CLOSED' ELSE 'CANCELLED' END,
        v_actor_id,v_task_cycle,v_occurred_at,
        (pg_catalog.md5(p_idempotency_key::text || ':LOCATION_RESOLVED'))::uuid,
        'ANDROID',pg_catalog.jsonb_build_object(
            'task_location_id',v_task_location_id,'location_id',p_location_id,
            'zone_id',p_zone_id,'resolution_status',p_resolution_status,'reason',p_reason),
        v_occurred_at,v_actor_id)
    ON CONFLICT (company_id,idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING RETURNING id INTO v_event_id;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.resolve_my_counting_location','entity_id',v_task_location_id,
        'state','CLOSED','version',NULL::integer,'cycle_number',v_task_cycle,
        'assignment_id',v_assignment_id,'event_id',v_event_id,'replayed',false,
        'occurred_at',v_occurred_at,'data',pg_catalog.jsonb_build_object(
            'zone_id',p_zone_id,'location_id',p_location_id,
            'task_location_id',v_task_location_id,'status','CLOSED',
            'resolution_status',p_resolution_status,'reason',p_reason,
            'physically_visited',p_resolution_status='EMPTY_REVIEWED'));
    RETURN inventarios.complete_idempotent_operation(v_company_id,v_operation_id,v_task_location_id,v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.resolve_my_counting_location_empty(p_zone_id uuid,p_location_id uuid,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
    RETURN inventarios._resolve_my_counting_location(p_zone_id,p_location_id,'EMPTY_REVIEWED','PHYSICALLY_REVIEWED_EMPTY',p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.cancel_my_counting_location(p_zone_id uuid,p_location_id uuid,p_reason text,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
    RETURN inventarios._resolve_my_counting_location(p_zone_id,p_location_id,'OPENED_BY_MISTAKE',p_reason,p_idempotency_key);
END;
$function$;

-- Reopening a closed location starts a new visit and clears its prior resolution.
DO $migration$
DECLARE v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.open_my_counting_location(uuid,uuid,uuid)'::regprocedure) INTO v_definition;
    v_definition := pg_catalog.replace(v_definition, 'closed_by = NULL', 'closed_by = NULL, resolution_status = NULL');
    EXECUTE v_definition;
END;
$migration$;

-- A normal close with product counts is an explicitly counted visit.
DO $migration$
DECLARE v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.complete_my_counting_zone(uuid,uuid)'::regprocedure) INTO v_definition;
    v_definition := pg_catalog.replace(v_definition, 'SET status = ''CLOSED'', closed_at = v_occurred_at, closed_by = v_actor_id', 'SET status = ''CLOSED'', closed_at = v_occurred_at, closed_by = v_actor_id, resolution_status = ''COUNTED''');
    v_definition := pg_catalog.regexp_replace(v_definition, '(?s)\s*-- Guarda nueva: al menos una contribucion efectiva de la tarea/zona/ciclo.*?END IF;\s*', '', 'n');
    EXECUTE v_definition;
END;
$migration$;

DO $migration$
DECLARE v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef('inventarios.complete_inventory_task(uuid,uuid,integer,uuid)'::regprocedure) INTO v_definition;
    v_definition := pg_catalog.regexp_replace(v_definition, '(?s)\s*-- GUARDA NUEVA: al menos una contribucion efectiva de la tarea/zona/ciclo.*?END IF;\s*', '', 'n');
    EXECUTE v_definition;
END;
$migration$;

ALTER FUNCTION inventarios._resolve_my_counting_location(uuid,uuid,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.resolve_my_counting_location_empty(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.cancel_my_counting_location(uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._resolve_my_counting_location(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inventarios.resolve_my_counting_location_empty(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inventarios.cancel_my_counting_location(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inventarios.resolve_my_counting_location_empty(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.cancel_my_counting_location(uuid,uuid,text,uuid) TO authenticated;

COMMIT;
