-- ============================================================================
-- MEJ-01B Forward-only: Validación estricta de la acción esperada de cada incidencia
--
-- Refuerza logistica.verify_open_preparation_incidents_v1 para que una incidencia
-- comercial sólo cambie de OPEN a RESOLVED cuando se demuestre que:
-- 1. La consistencia del conjunto completo del pedido está demostrada.
-- 2. La versión canónica vigente de Bsale cumple exactamente la acción solicitada:
--    - SET_QUANTITY: bsale_quantity = expected_bsale_quantity = physically_prepared_quantity.
--    - REMOVE_LINE: línea eliminada o cantidad <= 0 en Bsale y cantidad física preparada = 0.
--    - Identidad comercial inequívoca (no ambigua, no nula).
--
-- No modifica requested_quantity ni prepared_quantity en líneas físicas.
-- No modifica estados de tarjetas ni sesiones de auditoría.
-- ============================================================================

BEGIN;

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
  v_verified integer := 0;
  v_resolved integer := 0;
  v_mismatched integer := 0;
  v_not_found integer := 0;
  v_cancelled integer := 0;
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
    SELECT
      i.id,
      i.card_id,
      i.company_id,
      i.bsale_nv_id AS historical_nv_id,
      i.preparation_line_id,
      i.bsale_detail_id,
      i.required_bsale_action,
      i.expected_bsale_quantity,
      i.requested_quantity AS incident_requested_quantity,
      i.prepared_quantity AS incident_prepared_quantity,
      i.sku AS incident_sku,
      i.bsale_variant_id AS incident_variant_id,
      i.created_at AS incident_created_at,
      COALESCE(c.current_bsale_nv_id, c.bsale_nv_id) AS current_nv_id,
      c.canonical_bsale_token,
      c.bsale_nv_folio
    FROM logistica.sales_order_preparation_incidents i
    JOIN logistica.sales_order_preparation_cards c
      ON c.id = i.card_id
     AND c.company_id = i.company_id
    WHERE i.company_id = p_company_id
      AND i.status = 'OPEN'
      AND (
        p_bsale_nv_ids IS NULL
        OR i.bsale_nv_id = ANY(p_bsale_nv_ids)
        OR c.current_bsale_nv_id = ANY(p_bsale_nv_ids)
      )
  ),
  card_scope AS (
    SELECT
      s.card_id,
      s.company_id,
      s.current_nv_id,
      s.canonical_bsale_token,
      s.bsale_nv_folio,
      max(s.incident_created_at) AS latest_incident_at
    FROM scoped s
    GROUP BY s.card_id, s.company_id, s.current_nv_id, s.canonical_bsale_token, s.bsale_nv_folio
  ),
  current_documents AS (
    SELECT
      cs.card_id,
      cs.company_id,
      cs.current_nv_id,
      cs.canonical_bsale_token,
      cs.bsale_nv_folio,
      cs.latest_incident_at,
      d.bsale_id AS document_id,
      d.number AS document_number,
      NULLIF(btrim(d.raw_json ->> 'token'), '') AS document_canonical_token,
      canon.current_bsale_id AS canonical_version_nv_id,
      canon.folio AS canonical_folio,
      d.state AS document_state,
      d.synced_at AS document_synced_at,
      d.bsale_sync_run_id,
      sr.status AS sync_status,
      sr.completed_at AS sync_completed_at
    FROM card_scope cs
    LEFT JOIN integraciones.bsale_documents d
      ON d.company_id = cs.company_id
     AND d.bsale_id = cs.current_nv_id
     AND d.document_type_id = 23
    LEFT JOIN integraciones.vw_bsale_sales_order_documents_canonical canon
      ON canon.company_id = cs.company_id
     AND canon.canonical_bsale_token = cs.canonical_bsale_token
    LEFT JOIN integraciones.bsale_sync_runs sr
      ON sr.id = d.bsale_sync_run_id
     AND sr.company_id = d.company_id
  ),
  prepared_raw AS (
    SELECT
      cs.card_id,
      pl.id AS preparation_line_id,
      CASE
        WHEN NULLIF(btrim(pl.sku), '') IS NOT NULL
          THEN 'SKU:' || upper(btrim(pl.sku))
        WHEN pl.bsale_variant_id IS NOT NULL
          THEN 'VARIANT:' || pl.bsale_variant_id::text
        ELSE NULL
      END AS product_key,
      pl.prepared_quantity,
      pl.requested_quantity
    FROM card_scope cs
    JOIN logistica.sales_order_preparation_lines pl
      ON pl.company_id = cs.company_id
     AND pl.card_id = cs.card_id
     AND pl.retired_at IS NULL
  ),
  prepared_keys AS (
    SELECT
      p.card_id,
      p.product_key,
      count(*)::integer AS line_count,
      count(*) FILTER (WHERE p.product_key IS NULL)::integer AS null_key_count,
      count(*) FILTER (WHERE p.prepared_quantity IS NULL)::integer AS null_quantity_count,
      sum(coalesce(p.prepared_quantity, 0)) AS prepared_quantity
    FROM prepared_raw p
    GROUP BY p.card_id, p.product_key
  ),
  current_raw AS (
    SELECT
      d.card_id,
      det.bsale_id AS detail_id,
      CASE
        WHEN NULLIF(btrim(det.variant_code), '') IS NOT NULL
          THEN 'SKU:' || upper(btrim(det.variant_code))
        WHEN det.variant_id IS NOT NULL
          THEN 'VARIANT:' || det.variant_id::text
        ELSE NULL
      END AS product_key,
      det.quantity
    FROM current_documents d
    JOIN integraciones.bsale_document_details det
      ON det.company_id = d.company_id
     AND det.bsale_document_id = d.document_id
  ),
  current_keys AS (
    SELECT
      c.card_id,
      c.product_key,
      count(*)::integer AS line_count,
      count(*) FILTER (WHERE c.product_key IS NULL)::integer AS null_key_count,
      count(*) FILTER (WHERE c.quantity IS NULL OR c.quantity < 0)::integer AS invalid_quantity_count,
      sum(coalesce(c.quantity, 0)) AS current_quantity
    FROM current_raw c
    GROUP BY c.card_id, c.product_key
  ),
  key_comparison AS (
    SELECT
      coalesce(p.card_id, c.card_id) AS card_id,
      coalesce(p.product_key, c.product_key) AS product_key,
      coalesce(p.prepared_quantity, 0) AS prepared_quantity,
      coalesce(c.current_quantity, 0) AS current_quantity
    FROM prepared_keys p
    FULL JOIN current_keys c
      ON c.card_id = p.card_id
     AND c.product_key = p.product_key
    WHERE coalesce(p.prepared_quantity, 0) > 0
       OR coalesce(c.current_quantity, 0) > 0
  ),
  card_comparison AS (
    SELECT
      d.card_id,
      d.current_nv_id,
      d.canonical_bsale_token,
      d.bsale_nv_folio,
      d.document_id,
      d.document_number,
      d.document_canonical_token,
      d.canonical_version_nv_id,
      d.document_state,
      d.document_synced_at,
      d.bsale_sync_run_id,
      d.sync_status,
      d.sync_completed_at,
      d.latest_incident_at,
      (
        d.document_id IS NOT NULL
        AND d.document_state = 0
        AND d.bsale_sync_run_id IS NOT NULL
        AND d.sync_status = 'COMPLETED'
        AND d.sync_completed_at IS NOT NULL
        AND d.sync_completed_at >= d.latest_incident_at
        AND d.document_synced_at IS NOT NULL
        AND d.document_synced_at >= d.latest_incident_at
        AND NOT EXISTS (
          SELECT 1
          FROM integraciones.bsale_document_details stale_detail
          WHERE stale_detail.company_id = d.company_id
            AND stale_detail.bsale_document_id = d.document_id
            AND stale_detail.bsale_sync_run_id IS DISTINCT FROM d.bsale_sync_run_id
        )
      ) AS sync_proven,
      (
        NULLIF(btrim(d.canonical_bsale_token), '') IS NOT NULL
        AND d.document_canonical_token IS NOT NULL
        AND d.document_canonical_token = NULLIF(btrim(d.canonical_bsale_token), '')
        AND NULLIF(btrim(d.bsale_nv_folio), '') IS NOT NULL
        AND d.document_number IS NOT NULL
        AND d.document_number::text = btrim(d.bsale_nv_folio)
        AND d.canonical_version_nv_id IS NOT NULL
        AND d.current_nv_id = d.canonical_version_nv_id
      ) AS canonical_identity_matched,
      EXISTS (
        SELECT 1
        FROM prepared_keys p
        WHERE p.card_id = d.card_id
          AND p.line_count > 1
      ) AS duplicate_prepared_key,
      EXISTS (
        SELECT 1
        FROM prepared_keys p
        WHERE p.card_id = d.card_id
          AND (p.product_key IS NULL OR p.null_quantity_count > 0)
      ) AS invalid_prepared_key,
      EXISTS (
        SELECT 1
        FROM current_keys c
        WHERE c.card_id = d.card_id
          AND c.line_count > 1
      ) AS duplicate_current_key,
      EXISTS (
        SELECT 1
        FROM current_keys c
        WHERE c.card_id = d.card_id
          AND (c.product_key IS NULL OR c.invalid_quantity_count > 0)
      ) AS invalid_current_key,
      EXISTS (
        SELECT 1
        FROM key_comparison k
        WHERE k.card_id = d.card_id
          AND k.prepared_quantity IS DISTINCT FROM k.current_quantity
      ) AS quantity_mismatch,
      (
        SELECT count(*)::integer
        FROM current_raw c
        WHERE c.card_id = d.card_id
      ) AS current_line_count,
      (
        SELECT count(*)::integer
        FROM prepared_raw p
        WHERE p.card_id = d.card_id
      ) AS prepared_line_count
    FROM current_documents d
  ),
  card_matched AS (
    SELECT
      cc.*,
      (
        cc.document_id IS NOT NULL
        AND cc.document_state = 0
        AND cc.sync_proven
        AND cc.canonical_identity_matched
        AND NOT cc.duplicate_prepared_key
        AND NOT cc.invalid_prepared_key
        AND NOT cc.duplicate_current_key
        AND NOT cc.invalid_current_key
        AND cc.prepared_line_count > 0
        AND NOT cc.quantity_mismatch
      ) AS full_card_matched
    FROM card_comparison cc
  ),
  incident_lines AS (
    SELECT
      s.*,
      pl.id AS matched_preparation_line_id,
      pl.prepared_quantity AS physical_prepared_quantity,
      pl.requested_quantity AS physical_requested_quantity,
      pl.sku AS physical_sku,
      pl.bsale_variant_id AS physical_variant_id,
      pl.retired_at AS physical_retired_at,
      CASE
        WHEN NULLIF(btrim(pl.sku), '') IS NOT NULL
          THEN 'SKU:' || upper(btrim(pl.sku))
        WHEN pl.bsale_variant_id IS NOT NULL
          THEN 'VARIANT:' || pl.bsale_variant_id::text
        ELSE NULL
      END AS physical_product_key,
      CASE
        WHEN NULLIF(btrim(s.incident_sku), '') IS NOT NULL
          THEN 'SKU:' || upper(btrim(s.incident_sku))
        WHEN s.incident_variant_id IS NOT NULL
          THEN 'VARIANT:' || s.incident_variant_id::text
        ELSE NULL
      END AS incident_declared_product_key,
      (
        pl.id IS NOT NULL
        AND pl.retired_at IS NULL
        AND (
          NULLIF(btrim(pl.sku), '') IS NOT NULL
          OR pl.bsale_variant_id IS NOT NULL
        )
        AND (
          NULLIF(btrim(s.incident_sku), '') IS NULL
          OR (pl.sku IS NOT NULL AND upper(btrim(s.incident_sku)) = upper(btrim(pl.sku)))
        )
        AND (
          s.incident_variant_id IS NULL
          OR (pl.bsale_variant_id IS NOT NULL AND s.incident_variant_id = pl.bsale_variant_id)
        )
      ) AS line_link_valid
    FROM scoped s
    LEFT JOIN logistica.sales_order_preparation_lines pl
      ON pl.id = s.preparation_line_id
     AND pl.company_id = s.company_id
     AND pl.card_id = s.card_id
     AND pl.retired_at IS NULL
  ),
  incident_eval AS (
    SELECT
      il.*,
      cm.document_id,
      cm.document_state,
      cm.bsale_sync_run_id,
      cm.sync_status,
      cm.sync_completed_at,
      cm.sync_proven,
      cm.canonical_identity_matched,
      cm.full_card_matched,
      ck.line_count AS bsale_line_count,
      ck.current_quantity AS bsale_current_quantity,
      CASE
        WHEN il.required_bsale_action = 'REMOVE_LINE' AND coalesce(ck.line_count, 0) = 0 THEN 0::numeric
        ELSE coalesce(ck.current_quantity, 0)
      END AS bsale_observed_quantity,
      (
        il.line_link_valid
        AND il.physical_product_key IS NOT NULL
        AND (
          (
            il.required_bsale_action = 'SET_QUANTITY'
            AND coalesce(ck.line_count, 0) = 1
            AND coalesce(ck.current_quantity, 0) = il.expected_bsale_quantity
            AND il.physical_prepared_quantity IS NOT NULL
            AND coalesce(ck.current_quantity, 0) = il.physical_prepared_quantity
          )
          OR (
            il.required_bsale_action = 'REMOVE_LINE'
            AND (
              coalesce(ck.line_count, 0) = 0
              OR (coalesce(ck.line_count, 0) = 1 AND coalesce(ck.current_quantity, 0) <= 0)
            )
            AND il.physical_prepared_quantity IS NOT NULL
            AND il.physical_prepared_quantity = 0
            AND il.expected_bsale_quantity <= 0
          )
        )
      ) AS incident_action_matched
    FROM incident_lines il
    JOIN card_matched cm ON cm.card_id = il.card_id
    LEFT JOIN current_keys ck ON ck.card_id = il.card_id AND ck.product_key = il.physical_product_key
  ),
  classified AS (
    SELECT
      e.*,
      CASE
        WHEN e.document_id IS NULL THEN 'NOT_FOUND'
        WHEN e.document_state IS DISTINCT FROM 0 THEN 'NV_CANCELLED'
        WHEN NOT e.canonical_identity_matched THEN 'MISMATCHED'
        WHEN NOT e.sync_proven THEN 'MISMATCHED'
        WHEN NOT e.full_card_matched THEN 'MISMATCHED'
        WHEN NOT e.incident_action_matched THEN 'MISMATCHED'
        ELSE 'MATCHED'
      END AS verification_status,
      jsonb_build_object(
        'historical_nv_id', e.historical_nv_id,
        'current_nv_id', e.current_nv_id,
        'document_id', e.document_id,
        'document_state', e.document_state,
        'canonical_identity_matched', e.canonical_identity_matched,
        'sync_proven', e.sync_proven,
        'sync_run_id', e.bsale_sync_run_id,
        'sync_status', e.sync_status,
        'sync_completed_at', e.sync_completed_at,
        'incident_created_at', e.incident_created_at,
        'required_bsale_action', e.required_bsale_action,
        'expected_bsale_quantity', e.expected_bsale_quantity,
        'preparation_line_id', e.preparation_line_id,
        'matched_preparation_line_id', e.matched_preparation_line_id,
        'line_link_valid', e.line_link_valid,
        'incident_product_key', e.physical_product_key,
        'bsale_observed_quantity', e.bsale_observed_quantity,
        'physically_prepared_quantity', e.physical_prepared_quantity,
        'full_card_matched', e.full_card_matched,
        'incident_action_matched', e.incident_action_matched,
        'verification_basis', 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'
      ) AS observed_snapshot
    FROM incident_eval e
  ),
  updated AS (
    UPDATE logistica.sales_order_preparation_incidents i
    SET status = CASE WHEN c.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END,
        verification_status = c.verification_status,
        last_verified_at = now(),
        bsale_observed_quantity = c.bsale_observed_quantity,
        bsale_observed_snapshot = c.observed_snapshot,
        updated_at = now()
    FROM classified c
    WHERE i.id = c.id
      AND i.company_id = p_company_id
      AND i.status = 'OPEN'
    RETURNING c.verification_status
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

REVOKE ALL ON FUNCTION logistica.verify_open_preparation_incidents_v1(uuid, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.verify_open_preparation_incidents_v1(uuid, bigint[])
  TO service_role;

COMMENT ON FUNCTION logistica.verify_open_preparation_incidents_v1(uuid, bigint[]) IS
  'MEJ-01B Forward-only: resolves incidents only when full card consistency is demonstrated, physical line linkage is proven, and Bsale fulfills the specific expected action (SET_QUANTITY or REMOVE_LINE).';

COMMIT;
