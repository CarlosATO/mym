-- Migration: 20260815090000_inventarios_list_my_inventories.sql
-- Description: RPC read-only para Mobile: lista los Inventarios (campanas) con los
--              que el usuario autenticado tiene o tuvo participacion, zonas asignadas
--              o auditorias, incluidos activos e historicos. No expone Inventarios ajenos.
-- Author: Assistant
--
-- Criterio de pertenencia del usuario (cualquiera de los siguientes):
--   1. inventory_campaign_participants  -> participo/parecipa en el equipo de la campana.
--   2. session_participants (via sessions.campaign_id) -> participo/parecipa en una jornada.
--   3. task_assignments (via sessions.campaign_id)      -> tuvo zonas/tareas asignadas.
--   4. inventory_audits.assigned_user_id                -> fue/es auditor de la campana.
--   Incluye historial revocado; la exclusion es el resultado del propio criterio.
--
-- is_operable:
--   DRAFT / APPROVED / CANCELLED / UNDER_REVIEW  -> false (visibles, no operables).
--   IN_PROGRESS -> true SOLO si el usuario tiene trabajo vigente:
--       * una asignacion no liberada en una tarea activa de una jornada COUNTING, o
--       * una auditoria activa asignada (PENDING/ASSIGNED/IN_PROGRESS/SUBMITTED).
--
-- Orden: operables/activos primero, luego historicos mas recientes.

CREATE OR REPLACE FUNCTION inventarios.list_my_inventories()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_actor_display_name text;
    v_rows jsonb;
    v_count int;
BEGIN
    v_actor_id := inventarios.require_actor();
    v_actor_display_name := inventarios.user_display_name(v_actor_id);

    WITH my_inventories AS (
        SELECT
            ic.id AS campaign_id,
            ic.company_id,
            ic.name,
            ic.campaign_type,
            ic.status,
            ic.planned_at,
            ic.started_at,
            ic.completed_at,
            ic.approved_at,
            ic.cancelled_at,
            ic.created_at,
            (
                EXISTS (
                    SELECT 1 FROM inventarios.inventory_campaign_participants icp
                    WHERE icp.company_id = ic.company_id AND icp.campaign_id = ic.id
                      AND icp.user_id = v_actor_id
                      AND icp.active_from <= pg_catalog.now() AND icp.revoked_at IS NULL
                )
                OR EXISTS (
                    SELECT 1 FROM inventarios.session_participants sp
                    JOIN inventarios.sessions s
                      ON s.company_id = sp.company_id AND s.id = sp.session_id
                    WHERE sp.company_id = ic.company_id AND s.campaign_id = ic.id
                      AND sp.user_id = v_actor_id
                      AND sp.active_from <= pg_catalog.now() AND sp.revoked_at IS NULL
                )
            ) AS participacion_activa,
            (
                ic.status = 'IN_PROGRESS'
                AND (
                    EXISTS (
                        SELECT 1 FROM inventarios.task_assignments ta
                        JOIN inventarios.tasks t
                          ON t.company_id = ta.company_id AND t.id = ta.task_id
                        JOIN inventarios.sessions s
                          ON s.company_id = ta.company_id AND s.id = ta.session_id
                        WHERE ta.user_id = v_actor_id
                          AND ta.released_at IS NULL
                          AND s.campaign_id = ic.id
                          AND s.status = 'COUNTING'
                          AND t.cancelled_at IS NULL
                          AND t.superseded_at IS NULL
                          AND t.invalidated_at IS NULL
                          AND t.status IN ('ASSIGNED', 'IN_PROGRESS', 'PAUSED')
                    )
                    OR EXISTS (
                        SELECT 1 FROM inventarios.inventory_audits ia
                        WHERE ia.company_id = ic.company_id AND ia.campaign_id = ic.id
                          AND ia.assigned_user_id = v_actor_id
                          AND ia.status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED')
                    )
                )
            ) AS is_operable,
            EXISTS (
                SELECT 1 FROM inventarios.inventory_audits ia
                WHERE ia.company_id = ic.company_id AND ia.campaign_id = ic.id
                  AND ia.assigned_user_id = v_actor_id
            ) AS es_auditor
        FROM inventarios.inventory_campaigns ic
        WHERE
            EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_participants icp
                WHERE icp.company_id = ic.company_id AND icp.campaign_id = ic.id
                  AND icp.user_id = v_actor_id
            )
            OR EXISTS (
                SELECT 1 FROM inventarios.session_participants sp
                JOIN inventarios.sessions s
                  ON s.company_id = sp.company_id AND s.id = sp.session_id
                WHERE sp.company_id = ic.company_id AND s.campaign_id = ic.id
                  AND sp.user_id = v_actor_id
            )
            OR EXISTS (
                SELECT 1 FROM inventarios.task_assignments ta
                JOIN inventarios.sessions s
                  ON s.company_id = ta.company_id AND s.id = ta.session_id
                WHERE ta.company_id = ic.company_id AND s.campaign_id = ic.id
                  AND ta.user_id = v_actor_id
            )
            OR EXISTS (
                SELECT 1 FROM inventarios.inventory_audits ia
                WHERE ia.company_id = ic.company_id AND ia.campaign_id = ic.id
                  AND ia.assigned_user_id = v_actor_id
            )
    ),
    enriched AS (
        SELECT
            mi.campaign_id,
            mi.company_id,
            mi.name,
            mi.campaign_type,
            mi.status,
            mi.planned_at,
            mi.started_at,
            mi.completed_at,
            mi.approved_at,
            mi.cancelled_at,
            mi.created_at,
            mi.participacion_activa,
            mi.is_operable,
            mi.es_auditor,
            CASE
                WHEN mi.status = 'APPROVED'
                    THEN coalesce(mi.approved_at, mi.completed_at, mi.started_at, mi.planned_at, mi.created_at)
                WHEN mi.status = 'CANCELLED'
                    THEN coalesce(mi.cancelled_at, mi.created_at)
                WHEN mi.status IN ('IN_PROGRESS', 'UNDER_REVIEW')
                    THEN coalesce(mi.started_at, mi.planned_at, mi.created_at)
                ELSE coalesce(mi.planned_at, mi.created_at)
            END AS fecha_relevante,
            coalesce((
                SELECT pg_catalog.jsonb_agg(d.x)
                FROM (
                    SELECT DISTINCT
                        pg_catalog.jsonb_build_object(
                            'rol', icp.participant_role,
                            'estado', CASE WHEN icp.revoked_at IS NULL THEN 'ACTIVO' ELSE 'HISTORICO' END
                        ) AS x
                    FROM inventarios.inventory_campaign_participants icp
                    WHERE icp.company_id = mi.company_id
                      AND icp.campaign_id = mi.campaign_id
                      AND icp.user_id = v_actor_id
                ) d
            ), '[]'::jsonb) AS roles
        FROM my_inventories mi
    )
    SELECT
        coalesce(
            pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'campaign_id', e.campaign_id,
                    'nombre', e.name,
                    'campaign_type', e.campaign_type,
                    'status', e.status,
                    'fecha_relevante', e.fecha_relevante,
                    'fechas', pg_catalog.jsonb_build_object(
                        'planned_at', e.planned_at,
                        'started_at', e.started_at,
                        'completed_at', e.completed_at,
                        'approved_at', e.approved_at,
                        'cancelled_at', e.cancelled_at,
                        'created_at', e.created_at
                    ),
                    'roles', e.roles,
                    'participacion_activa', e.participacion_activa,
                    'es_auditor', e.es_auditor,
                    'is_operable', e.is_operable
                )
                ORDER BY e.is_operable DESC, e.fecha_relevante DESC NULLS LAST, e.created_at DESC
            ),
            '[]'::jsonb
        ),
        pg_catalog.count(*)
    INTO v_rows, v_count
    FROM enriched e;

    RETURN pg_catalog.jsonb_build_object(
        'actor', pg_catalog.jsonb_build_object('id', v_actor_id, 'display_name', v_actor_display_name),
        'inventory_count', v_count,
        'inventories', v_rows
    );
END;
$$;

ALTER FUNCTION inventarios.list_my_inventories() OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.list_my_inventories() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventarios.list_my_inventories() FROM anon;

GRANT EXECUTE ON FUNCTION inventarios.list_my_inventories() TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventories() TO service_role;
