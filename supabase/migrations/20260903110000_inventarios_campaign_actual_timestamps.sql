-- Migration: 20260903110000_inventarios_campaign_actual_timestamps.sql
-- Description: Separate planned campaign time from actual lifecycle timestamps.

ALTER TABLE inventarios.inventory_campaigns
    DROP CONSTRAINT IF EXISTS chk_inventarios_campaigns_dates;

ALTER TABLE inventarios.inventory_campaigns
    ADD CONSTRAINT chk_inventarios_campaigns_dates
    CHECK (
        (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
        AND
        (approved_at IS NULL OR (started_at IS NOT NULL AND approved_at >= started_at))
    );

-- Preserve the existing start-session contract while recording the actual
-- first opening even when it happens before planned_at.
DO $migration$
DECLARE
    v_definition text;
    v_old text := $$        started_at = CASE
            WHEN started_at IS NULL AND planned_at IS NOT NULL
                 AND v_occurred_at >= planned_at THEN v_occurred_at
            ELSE started_at
        END,$$;
    v_new text := $$        started_at = COALESCE(started_at, v_occurred_at),$$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.start_inventory_session(uuid,uuid,uuid)'::regprocedure
    ) INTO v_definition;

    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION 'start_inventory_session timestamp contract marker not found';
    END IF;

    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    EXECUTE v_definition;
END;
$migration$;

ALTER FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.start_inventory_session(uuid, uuid, uuid)
    TO authenticated;
