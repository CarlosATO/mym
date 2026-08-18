-- Allow the read-only location-count contract to inspect the actor's
-- completed task using immutable completion history.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_pattern text;
    v_replacement text;
    v_updated text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.list_my_location_counts(uuid,uuid)'::regprocedure
    ) INTO v_definition;

    v_pattern := E'(?s)AND a\\.released_at IS NULL.*?AND t\\.invalidated_at IS NULL;';
    v_replacement := $replacement$
      AND a.user_id = v_actor_id
      AND p.user_id = v_actor_id
      AND s.status = 'COUNTING'
      AND z.is_enabled = true
      AND (
          (
              t.status = 'IN_PROGRESS'
              AND a.released_at IS NULL
              AND p.active_from <= pg_catalog.now()
              AND p.revoked_at IS NULL
              AND t.active_user_id = v_actor_id
          )
          OR
          (
              t.status = 'COMPLETED'
              AND t.completed_by = v_actor_id
              AND EXISTS (
                  SELECT 1
                  FROM inventarios.task_state_transitions tst
                  WHERE tst.company_id = z.company_id
                    AND tst.session_id = z.session_id
                    AND tst.session_zone_id = p_zone_id
                    AND tst.task_id = t.id
                    AND tst.assignment_id = a.id
                    AND tst.transition_type = 'COMPLETED'
                    AND tst.previous_status = 'IN_PROGRESS'
                    AND tst.next_status = 'COMPLETED'
                    AND tst.actor_id = v_actor_id
              )
          )
      )
      AND t.cancelled_at IS NULL
      AND t.superseded_at IS NULL
      AND t.invalidated_at IS NULL;$replacement$;

    v_updated := pg_catalog.regexp_replace(v_definition, v_pattern, v_replacement, 'n');
    IF v_updated = v_definition THEN
        RAISE EXCEPTION 'list_my_location_counts authorization block not found';
    END IF;
    IF pg_catalog.strpos(v_updated, 't.status = ''COMPLETED''') = 0
       OR pg_catalog.strpos(v_updated, 'tst.transition_type = ''COMPLETED''') = 0
       OR pg_catalog.strpos(v_updated, 'a.released_at IS NULL') = 0 THEN
        RAISE EXCEPTION 'list_my_location_counts completed-read authorization was not installed';
    END IF;

    EXECUTE v_updated;
END;
$migration$;

ALTER FUNCTION inventarios.list_my_location_counts(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_location_counts(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_location_counts(uuid, uuid) TO authenticated;

COMMIT;
