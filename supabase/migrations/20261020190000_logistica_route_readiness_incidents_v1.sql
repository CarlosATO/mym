-- ============================================================================
-- Incidencias comerciales y elegibilidad para facturación · Backend V1
--
-- AUDITED sigue siendo el único estado físico de la tarjeta. La elegibilidad
-- comercial se deriva en un read model:
--   INCIDENTS / READY_TO_INVOICE / BLOCKED
--
-- RESOLVED sólo se asigna cuando el espejo Bsale coincide de forma inequívoca.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Estados de incidencia y verificación
-- ============================================================================
ALTER TABLE logistica.sales_order_preparation_incidents
    DROP CONSTRAINT IF EXISTS sales_order_preparation_incidents_status_check;

ALTER TABLE logistica.sales_order_preparation_incidents
    ADD CONSTRAINT sales_order_preparation_incidents_status_check
    CHECK (status IN ('OPEN', 'RESOLVED', 'SUPERSEDED'));

ALTER TABLE logistica.sales_order_preparation_incidents
    DROP CONSTRAINT IF EXISTS sales_order_preparation_incidents_verification_status_check;

ALTER TABLE logistica.sales_order_preparation_incidents
    ADD CONSTRAINT sales_order_preparation_incidents_verification_status_check
    CHECK (
        verification_status IS NULL
        OR verification_status IN ('MATCHED', 'MISMATCHED', 'NOT_FOUND', 'NV_CANCELLED', 'ERROR')
    );

CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_incidents_open_nv
    ON logistica.sales_order_preparation_incidents(company_id, status, bsale_nv_id)
    WHERE status = 'OPEN';

-- ============================================================================
-- 2. Verificación batch contra el espejo Bsale
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.verify_open_preparation_incidents_v1(
    p_company_id uuid,
    p_bsale_nv_ids bigint[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
    v_actor uuid := auth.uid();
    v_resolved integer := 0;
    v_mismatched integer := 0;
    v_not_found integer := 0;
    v_cancelled integer := 0;
    v_verified integer := 0;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COMPANY_ACCESS_DENIED';
        END IF;
        IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.preparation.manage') THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'PREPARATION_MANAGE_DENIED';
        END IF;
    END IF;

    WITH scoped AS (
        SELECT i.*
        FROM logistica.sales_order_preparation_incidents i
        WHERE i.company_id = p_company_id
          AND i.status = 'OPEN'
          AND (p_bsale_nv_ids IS NULL OR i.bsale_nv_id = ANY(p_bsale_nv_ids))
    ),
    nv_docs AS (
        SELECT d.bsale_id, d.state
        FROM integraciones.bsale_documents d
        WHERE d.company_id = p_company_id
          AND d.document_type_id = 23
          AND d.bsale_id IN (SELECT DISTINCT s.bsale_nv_id FROM scoped s)
    ),
    observed AS (
        SELECT
            s.id,
            s.bsale_nv_id,
            s.bsale_detail_id,
            s.bsale_variant_id,
            s.sku,
            s.required_bsale_action,
            s.expected_bsale_quantity,
            nd.bsale_id AS nv_document_id,
            nd.state AS nv_state,
            exact.bsale_id AS exact_detail_id,
            exact.quantity AS exact_quantity,
            COALESCE(fallback.match_count, 0) AS fallback_match_count,
            COALESCE(fallback.match_quantity, 0) AS fallback_quantity,
            CASE
                WHEN nd.bsale_id IS NULL THEN 'NOT_FOUND'
                WHEN nd.state IS DISTINCT FROM 0 THEN 'NV_CANCELLED'
                WHEN s.required_bsale_action = 'REMOVE_LINE' THEN
                    CASE
                        WHEN exact.bsale_id IS NOT NULL AND exact.quantity <= 0 THEN 'MATCHED'
                        WHEN exact.bsale_id IS NOT NULL THEN 'MISMATCHED'
                        WHEN COALESCE(fallback.match_count, 0) = 0 THEN 'MATCHED'
                        WHEN COALESCE(fallback.match_quantity, 0) <= 0 THEN 'MATCHED'
                        ELSE 'MISMATCHED'
                    END
                ELSE
                    CASE
                        WHEN exact.bsale_id IS NOT NULL AND exact.quantity = s.expected_bsale_quantity THEN 'MATCHED'
                        WHEN exact.bsale_id IS NOT NULL THEN 'MISMATCHED'
                        WHEN COALESCE(fallback.match_count, 0) = 1 AND fallback.match_quantity = s.expected_bsale_quantity THEN 'MATCHED'
                        WHEN COALESCE(fallback.match_count, 0) = 0 AND s.expected_bsale_quantity = 0 THEN 'MATCHED'
                        ELSE 'MISMATCHED'
                    END
            END AS verification_status,
            CASE
                WHEN exact.bsale_id IS NOT NULL THEN exact.quantity
                WHEN COALESCE(fallback.match_count, 0) > 0 THEN fallback.match_quantity
                ELSE 0::numeric
            END AS observed_quantity,
            CASE
                WHEN exact.bsale_id IS NOT NULL THEN 'DETAIL_ID'
                WHEN COALESCE(fallback.match_count, 0) = 1 THEN 'VARIANT_OR_SKU'
                WHEN COALESCE(fallback.match_count, 0) > 1 THEN 'AMBIGUOUS'
                ELSE 'NOT_FOUND'
            END AS match_mode
        FROM scoped s
        LEFT JOIN nv_docs nd ON nd.bsale_id = s.bsale_nv_id
        LEFT JOIN LATERAL (
            SELECT det.bsale_id, det.quantity
            FROM integraciones.bsale_document_details det
            WHERE det.company_id = p_company_id
              AND det.bsale_document_id = s.bsale_nv_id
              AND det.bsale_id = s.bsale_detail_id
            LIMIT 1
        ) exact ON true
        LEFT JOIN LATERAL (
            SELECT
                count(*)::integer AS match_count,
                COALESCE(sum(det.quantity), 0)::numeric AS match_quantity
            FROM integraciones.bsale_document_details det
            WHERE exact.bsale_id IS NULL
              AND det.company_id = p_company_id
              AND det.bsale_document_id = s.bsale_nv_id
              AND (
                    (s.bsale_variant_id IS NOT NULL AND det.variant_id = s.bsale_variant_id)
                 OR (s.bsale_variant_id IS NULL AND s.sku IS NOT NULL AND det.variant_code = s.sku)
              )
        ) fallback ON true
    ),
    updated AS (
        UPDATE logistica.sales_order_preparation_incidents i
        SET status = CASE WHEN o.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END,
            verification_status = o.verification_status,
            last_verified_at = now(),
            bsale_observed_quantity = o.observed_quantity,
            bsale_observed_snapshot = jsonb_build_object(
                'nv_id', o.bsale_nv_id,
                'nv_state', o.nv_state,
                'expected_bsale_quantity', o.expected_bsale_quantity,
                'observed_quantity', o.observed_quantity,
                'required_bsale_action', o.required_bsale_action,
                'match_mode', o.match_mode,
                'observed_detail_id', o.exact_detail_id,
                'matching_line_count', o.fallback_match_count,
                'verified_at', now()
            ),
            updated_at = now()
        FROM observed o
        WHERE i.id = o.id
          AND i.company_id = p_company_id
          AND i.status = 'OPEN'
        RETURNING o.verification_status
    )
    SELECT
        count(*)::integer,
        count(*) FILTER (WHERE verification_status = 'MATCHED')::integer,
        count(*) FILTER (WHERE verification_status = 'MISMATCHED')::integer,
        count(*) FILTER (WHERE verification_status = 'NOT_FOUND')::integer,
        count(*) FILTER (WHERE verification_status = 'NV_CANCELLED')::integer
    INTO v_verified, v_resolved, v_mismatched, v_not_found, v_cancelled
    FROM updated;

    RETURN jsonb_build_object(
        'verified', v_verified,
        'resolved', v_resolved,
        'open', v_mismatched + v_not_found + v_cancelled,
        'mismatched', v_mismatched,
        'not_found', v_not_found,
        'nv_cancelled', v_cancelled
    );
END;
$function$;

REVOKE ALL ON FUNCTION logistica.verify_open_preparation_incidents_v1(uuid, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.verify_open_preparation_incidents_v1(uuid, bigint[]) TO service_role;

-- ============================================================================
-- 3. Read model de elegibilidad comercial
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_route_readiness AS
WITH open_counts AS (
    SELECT i.card_id, count(*)::integer AS open_count
    FROM logistica.sales_order_preparation_incidents i
    WHERE i.status = 'OPEN'
    GROUP BY i.card_id
)
SELECT
    c.id AS card_id,
    c.company_id,
    c.bsale_nv_id,
    c.bsale_nv_folio,
    (COALESCE(oc.open_count, 0) > 0) AS has_open_commercial_incidents,
    COALESCE(oc.open_count, 0)::integer AS open_commercial_incident_count,
    CASE
        WHEN d.bsale_id IS NULL OR d.state IS DISTINCT FROM 0 OR c.closed_at IS NOT NULL THEN 'BLOCKED'
        WHEN COALESCE(oc.open_count, 0) > 0 THEN 'INCIDENTS'
        ELSE 'READY_TO_INVOICE'
    END AS route_readiness,
    d.state AS bsale_nv_state,
    (d.bsale_id IS NOT NULL) AS bsale_nv_found
FROM logistica.sales_order_preparation_cards c
LEFT JOIN integraciones.bsale_documents d
  ON d.company_id = c.company_id
 AND d.bsale_id = c.bsale_nv_id
 AND d.document_type_id = 23
LEFT JOIN open_counts oc ON oc.card_id = c.id
WHERE c.status = 'AUDITED';

ALTER VIEW logistica.vw_sales_order_route_readiness SET (security_invoker = true);
GRANT SELECT ON logistica.vw_sales_order_route_readiness TO authenticated, service_role;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_route_readiness_v1(
    p_company_id uuid
)
RETURNS TABLE (
    card_id uuid,
    company_id uuid,
    bsale_nv_id bigint,
    bsale_nv_folio text,
    has_open_commercial_incidents boolean,
    open_commercial_incident_count integer,
    route_readiness text,
    bsale_nv_state integer,
    bsale_nv_found boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, logistica, integraciones
AS $function$
DECLARE
    v_actor uuid := auth.uid();
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'COMPANY_ACCESS_DENIED';
        END IF;
        IF NOT core.has_permission_for_company(v_actor, p_company_id, 'module.logistica.view') THEN
            RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LOGISTICA_VIEW_DENIED';
        END IF;
    END IF;

    RETURN QUERY
    SELECT *
    FROM logistica.vw_sales_order_route_readiness r
    WHERE r.company_id = p_company_id
    ORDER BY r.bsale_nv_folio NULLS LAST, r.card_id;
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_sales_order_route_readiness_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_route_readiness_v1(uuid) TO authenticated, service_role;

COMMIT;
