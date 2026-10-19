-- A2 extension: allow the exceptional legacy reopen from IN_PREPARATION too.
-- The previous implementation is retained as a private delegate for the
-- original PENDING_ROUTE_PREP path; this migration adds the narrower path
-- without changing card identity, status, route history, or coverage.

ALTER FUNCTION logistica.reopen_legacy_archived_preparation_card(uuid, bigint, text)
  RENAME TO reopen_legacy_archived_preparation_card_pending_route_prep;

CREATE OR REPLACE FUNCTION logistica.reopen_legacy_archived_preparation_card(
    p_company_id uuid,
    p_bsale_nv_id bigint,
    p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_reason text := btrim(coalesce(p_reason, ''));
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_open_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_legacy_count integer := 0;
    v_nv record;
    v_cov record;
    v_reopened_at timestamptz := now();
    v_previous_closed_at timestamptz;
    v_automation_key text;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Usuario no autenticado.'; END IF;
    IF p_company_id IS NULL OR p_bsale_nv_id IS NULL THEN
        RAISE EXCEPTION 'Parametros obligatorios faltantes (company_id / bsale_nv_id).';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT portal.is_super_usuario(v_actor) THEN
        RAISE EXCEPTION 'No autorizado: se requiere rol SUPER_USUARIO.';
    END IF;
    IF v_reason = '' THEN RAISE EXCEPTION 'El motivo (reason) es obligatorio.'; END IF;

    SELECT count(*) INTO v_legacy_count
    FROM logistica.sales_order_preparation_cards c
    WHERE c.company_id = p_company_id AND c.bsale_nv_id = p_bsale_nv_id
      AND c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED';

    IF v_legacy_count > 1 THEN
        RAISE EXCEPTION 'Inconsistencia: existe mas de una tarjeta legacy cerrada para la NV %.', p_bsale_nv_id;
    END IF;
    IF v_legacy_count = 0 THEN
        SELECT c.* INTO v_open_card
        FROM logistica.sales_order_preparation_cards c
        WHERE c.company_id = p_company_id AND c.bsale_nv_id = p_bsale_nv_id
        ORDER BY c.updated_at DESC NULLS LAST LIMIT 1;
        IF FOUND AND v_open_card.closed_at IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'status', 'already_open',
                'message', 'La tarjeta ya se encuentra abierta.', 'card_id', v_open_card.id,
                'bsale_nv_id', v_open_card.bsale_nv_id, 'nv_folio', v_open_card.bsale_nv_folio,
                'card_status', v_open_card.status);
        END IF;
        RAISE EXCEPTION 'No existe una tarjeta LEGACY_BACKFILL_ARCHIVED cerrada para la NV %.', p_bsale_nv_id;
    END IF;

    SELECT c.* INTO v_card
    FROM logistica.sales_order_preparation_cards c
    WHERE c.company_id = p_company_id AND c.bsale_nv_id = p_bsale_nv_id
      AND c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'La tarjeta legacy cambio de estado; recargue y reintente.'; END IF;

    -- Preserve the original implementation byte-for-byte for its old status.
    IF v_card.status = 'PENDING_ROUTE_PREP' THEN
        RETURN logistica.reopen_legacy_archived_preparation_card_pending_route_prep(
            p_company_id, p_bsale_nv_id, p_reason);
    END IF;
    IF v_card.status <> 'IN_PREPARATION' THEN
        RAISE EXCEPTION 'La tarjeta legacy esta en %; solo se permite reabrir desde PENDING_ROUTE_PREP o IN_PREPARATION.', v_card.status;
    END IF;

    IF v_card.locked_by_user_id IS NOT NULL OR v_card.locked_at IS NOT NULL THEN
        RAISE EXCEPTION 'La tarjeta legacy tiene un lock activo; no puede reabrirse.';
    END IF;
    IF v_card.assigned_user_id IS NOT NULL THEN
        RAISE EXCEPTION 'La tarjeta legacy tiene un usuario asignado; no puede reabrirse.';
    END IF;

    SELECT d.bsale_id, d.number, d.document_type_id, d.state INTO v_nv
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id AND d.bsale_id = p_bsale_nv_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Nota de venta % no encontrada para la empresa.', p_bsale_nv_id; END IF;
    IF v_nv.document_type_id IS DISTINCT FROM 23 THEN
        RAISE EXCEPTION 'El documento % no es una Nota de Venta (document_type_id=%).', p_bsale_nv_id, v_nv.document_type_id;
    END IF;
    IF v_nv.state IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'La tarjeta ya posee evidencia definitiva en Bsale (state=%); no puede ser reabierta como legado.', v_nv.state;
    END IF;
    IF EXISTS (
        SELECT 1 FROM integraciones.bsale_invoice_sales_order_links link
        JOIN integraciones.bsale_documents invoice ON invoice.company_id = link.company_id
          AND invoice.bsale_id = link.invoice_bsale_id AND invoice.document_type_id = 5
        WHERE link.company_id = p_company_id AND link.sales_order_bsale_id = p_bsale_nv_id
    ) THEN RAISE EXCEPTION 'La tarjeta ya posee evidencia definitiva en Bsale (invoice link); no puede ser reabierta como legado.'; END IF;

    SELECT cv.is_pending, cv.remaining_qty, cv.coverage_status INTO v_cov
    FROM logistica.vw_sales_order_preparation_pending cv
    WHERE cv.company_id = p_company_id AND cv.nv_bsale_id = p_bsale_nv_id;
    IF NOT FOUND OR v_cov.coverage_status = 'COMPLETA'
       OR v_cov.is_pending IS DISTINCT FROM true OR coalesce(v_cov.remaining_qty, 0) <= 0 THEN
        RAISE EXCEPTION 'La NV % no esta pendiente de despacho; no puede reabrirse.', p_bsale_nv_id;
    END IF;
    IF EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_exclusions e
        WHERE e.company_id = p_company_id AND e.bsale_nv_id = p_bsale_nv_id AND e.active = true
    ) THEN RAISE EXCEPTION 'La NV % tiene una exclusion administrativa activa; primero debe resolverse la exclusion.', p_bsale_nv_id; END IF;

    v_previous_closed_at := v_card.closed_at;
    v_automation_key := 'BODEGA_LEGACY_REOPEN:' || to_char(v_previous_closed_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS');
    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = NULL, closure_reason = NULL, updated_at = v_reopened_at
    WHERE c.id = v_card.id AND c.company_id = p_company_id
      AND c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED'
      AND c.status = 'IN_PREPARATION'
      AND c.locked_by_user_id IS NULL AND c.locked_at IS NULL AND c.assigned_user_id IS NULL
      AND EXISTS (SELECT 1 FROM integraciones.bsale_documents d WHERE d.company_id = p_company_id AND d.bsale_id = p_bsale_nv_id AND d.document_type_id = 23 AND d.state = 0)
      AND NOT EXISTS (SELECT 1 FROM integraciones.bsale_invoice_sales_order_links link JOIN integraciones.bsale_documents invoice ON invoice.company_id = link.company_id AND invoice.bsale_id = link.invoice_bsale_id AND invoice.document_type_id = 5 WHERE link.company_id = p_company_id AND link.sales_order_bsale_id = p_bsale_nv_id)
      AND NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_exclusions e WHERE e.company_id = p_company_id AND e.bsale_nv_id = p_bsale_nv_id AND e.active = true)
      AND EXISTS (SELECT 1 FROM logistica.vw_sales_order_preparation_pending cv WHERE cv.company_id = p_company_id AND cv.nv_bsale_id = p_bsale_nv_id AND cv.is_pending = true AND cv.remaining_qty > 0 AND cv.coverage_status <> 'COMPLETA')
    RETURNING c.* INTO v_card;
    IF NOT FOUND THEN RAISE EXCEPTION 'La tarjeta cambio de estado o aparecio evidencia nueva durante la reapertura; recargue y reintente.'; END IF;

    INSERT INTO logistica.sales_order_preparation_movements (
        company_id, card_id, from_status, to_status, moved_by, movement_source,
        pin_validated, observation, metadata, automation_key
    ) VALUES (
        p_company_id, v_card.id, v_card.status, v_card.status, v_actor, 'USER', false, v_reason,
        jsonb_build_object('previous_closure_reason', 'LEGACY_BACKFILL_ARCHIVED', 'action', 'REOPEN_LEGACY_ARCHIVED', 'reopened_at', v_reopened_at, 'previous_closed_at', v_previous_closed_at, 'actor_id', v_actor),
        v_automation_key
    ) ON CONFLICT (company_id, card_id, automation_key) WHERE automation_key IS NOT NULL DO NOTHING;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'status', 'already_open', 'message', 'La reapertura ya fue registrada para este ciclo de archivo.', 'card_id', v_card.id, 'bsale_nv_id', v_card.bsale_nv_id, 'nv_folio', v_card.bsale_nv_folio, 'card_status', v_card.status);
    END IF;
    RETURN jsonb_build_object('ok', true, 'status', 'reopened', 'card_id', v_card.id,
        'bsale_nv_id', v_card.bsale_nv_id, 'nv_folio', v_card.bsale_nv_folio,
        'card_status', v_card.status, 'reason', v_reason, 'reopened_at', v_reopened_at,
        'moved_by', v_actor);
END;
$$;

REVOKE ALL ON FUNCTION logistica.reopen_legacy_archived_preparation_card_pending_route_prep(uuid, bigint, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.reopen_legacy_archived_preparation_card(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.reopen_legacy_archived_preparation_card(uuid, bigint, text) TO authenticated, service_role;

COMMENT ON FUNCTION logistica.reopen_legacy_archived_preparation_card(uuid, bigint, text) IS
  'Reabre una tarjeta LEGACY_BACKFILL_ARCHIVED desde PENDING_ROUTE_PREP o IN_PREPARATION, preservando status, identidad y route events, con guards de lock/asignacion y evidencia canonica.';
