-- SPECIAL DATA-FIX: four legacy cards excluded from LEGACY_BACKFILL_20261016.
--
-- This file is intentionally not safe to run against production without the
-- approved preflight. It is all-or-nothing, locks the card table, preserves
-- status/identity/route history, and only adds one SYSTEM movement per card.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_batch text := 'LEGACY_SPECIAL_20261019';
    v_batch_at timestamptz := clock_timestamp();
    v_expected integer := 4;
    v_count integer;
    v_archived integer;
    v_batch_movements integer;
    v_updated integer;
    v_total_movements integer;
    v_route_before integer;
    v_route_after integer;
    v_child_count integer;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_doc record;
    v_cov record;
    v_snapshot record;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    LOCK TABLE logistica.sales_order_preparation_cards IN ACCESS EXCLUSIVE MODE;

    CREATE TEMP TABLE legacy_special_targets (
        company_id uuid NOT NULL,
        bsale_nv_id bigint NOT NULL,
        expected_status text NOT NULL,
        expected_movements integer NOT NULL,
        PRIMARY KEY (company_id, bsale_nv_id)
    ) ON COMMIT DROP;
    INSERT INTO legacy_special_targets VALUES
      (v_company_id, 83326, 'PENDING_ROUTE_PREP', 2),
      (v_company_id, 83327, 'PENDING_ROUTE_PREP', 0),
      (v_company_id, 83878, 'IN_PREPARATION', 3),
      (v_company_id, 90045, 'PENDING_ROUTE_PREP', 0);

    SELECT count(*) INTO v_count FROM legacy_special_targets;
    IF v_count <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard target cardinality: %', v_count; END IF;

    SELECT count(*) INTO v_archived
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_special_targets t USING (company_id, bsale_nv_id)
    WHERE c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED';
    SELECT count(*) INTO v_batch_movements
    FROM logistica.sales_order_preparation_movements m
    JOIN logistica.sales_order_preparation_cards c ON c.id = m.card_id
    JOIN legacy_special_targets t
      ON t.company_id = m.company_id
     AND t.bsale_nv_id = c.bsale_nv_id
    WHERE m.automation_key = 'BODEGA_LEGACY_SPECIAL_ARCHIVE:20261019:' || c.bsale_nv_id;

    -- A rerun is accepted only if the complete special batch already exists.
    IF v_archived > 0 OR v_batch_movements > 0 THEN
        IF v_archived <> v_expected OR v_batch_movements <> v_expected THEN
            RAISE EXCEPTION 'SPECIAL guard partial batch: archived %, movements %', v_archived, v_batch_movements;
        END IF;
        SELECT count(*) INTO v_count
        FROM logistica.sales_order_preparation_movements m
        JOIN logistica.sales_order_preparation_cards c ON c.id = m.card_id
        JOIN legacy_special_targets t
          ON t.company_id = m.company_id
         AND t.bsale_nv_id = c.bsale_nv_id
        WHERE m.automation_key = 'BODEGA_LEGACY_SPECIAL_ARCHIVE:20261019:' || c.bsale_nv_id
          AND m.moved_by IS NULL AND m.movement_source = 'SYSTEM'
          AND m.from_status = t.expected_status AND m.to_status = t.expected_status;
        IF v_count <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard invalid rerun movements: %', v_count; END IF;
        RAISE NOTICE 'LEGACY_SPECIAL_20261019 ya aplicado: 4 tarjetas y 4 movements; no se modifica timestamp';
        RETURN;
    END IF;
    IF v_archived <> 0 OR v_batch_movements <> 0 THEN
        RAISE EXCEPTION 'SPECIAL guard unexpected prior state';
    END IF;

    CREATE TEMP TABLE legacy_special_snapshot ON COMMIT DROP AS
    SELECT c.id AS card_id, c.company_id, c.bsale_nv_id, c.status,
           t.expected_movements, 0::integer AS route_event_count
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_special_targets t USING (company_id, bsale_nv_id)
    WHERE false;

    FOR v_card IN
        SELECT c.* FROM logistica.sales_order_preparation_cards c
        JOIN legacy_special_targets t USING (company_id, bsale_nv_id)
        ORDER BY c.company_id, c.bsale_nv_id FOR UPDATE
    LOOP
        SELECT t.expected_status, t.expected_movements INTO v_snapshot
        FROM legacy_special_targets t
        WHERE t.company_id = v_card.company_id AND t.bsale_nv_id = v_card.bsale_nv_id;
        IF v_card.closed_at IS NOT NULL OR v_card.closure_reason IS NOT NULL
           OR v_card.status <> v_snapshot.expected_status THEN
            RAISE EXCEPTION 'SPECIAL guard card state: bsale_nv_id=% status=%', v_card.bsale_nv_id, v_card.status;
        END IF;
        IF v_card.locked_by_user_id IS NOT NULL OR v_card.locked_at IS NOT NULL THEN
            RAISE EXCEPTION 'SPECIAL guard active lock: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
        IF v_card.assigned_user_id IS NOT NULL THEN
            RAISE EXCEPTION 'SPECIAL guard assigned user: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
        SELECT d.document_type_id, d.state INTO v_doc
        FROM integraciones.bsale_documents d
        WHERE d.company_id = v_card.company_id AND d.bsale_id = v_card.bsale_nv_id
        FOR UPDATE;
        IF NOT FOUND OR v_doc.document_type_id IS DISTINCT FROM 23 OR v_doc.state IS DISTINCT FROM 0 THEN
            RAISE EXCEPTION 'SPECIAL guard document evidence: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
        IF EXISTS (
            SELECT 1 FROM integraciones.bsale_invoice_sales_order_links link
            JOIN integraciones.bsale_documents invoice ON invoice.company_id = link.company_id
              AND invoice.bsale_id = link.invoice_bsale_id AND invoice.document_type_id = 5
            WHERE link.company_id = v_card.company_id AND link.sales_order_bsale_id = v_card.bsale_nv_id
        ) THEN RAISE EXCEPTION 'SPECIAL guard invoice link: bsale_nv_id=%', v_card.bsale_nv_id; END IF;
        IF v_card.route_date IS NOT NULL AND v_card.route_date > (now() AT TIME ZONE 'America/Santiago')::date THEN
            RAISE EXCEPTION 'SPECIAL guard future route: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
        IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_route_events re
                   WHERE re.company_id = v_card.company_id AND re.card_id = v_card.id
                     AND re.to_route_date > (now() AT TIME ZONE 'America/Santiago')::date) THEN
            RAISE EXCEPTION 'SPECIAL guard future route event: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;

        SELECT count(*) INTO v_count FROM logistica.sales_order_preparation_movements m
        WHERE m.company_id = v_card.company_id AND m.card_id = v_card.id;
        IF v_count <> v_snapshot.expected_movements THEN
            RAISE EXCEPTION 'SPECIAL guard movements_count: bsale_nv_id=% count=% expected=%', v_card.bsale_nv_id, v_count, v_snapshot.expected_movements;
        END IF;
        SELECT count(*) INTO v_route_before FROM logistica.sales_order_preparation_route_events re
        WHERE re.company_id = v_card.company_id AND re.card_id = v_card.id;
        INSERT INTO legacy_special_snapshot
        VALUES (v_card.id, v_card.company_id, v_card.bsale_nv_id, v_card.status, v_snapshot.expected_movements, v_route_before);

        SELECT cv.* INTO v_cov FROM logistica.vw_sales_order_preparation_pending cv
        WHERE cv.company_id = v_card.company_id AND cv.nv_bsale_id = v_card.bsale_nv_id;
        IF NOT FOUND OR v_cov.is_pending IS DISTINCT FROM true OR coalesce(v_cov.remaining_qty, 0) <= 0 THEN
            RAISE EXCEPTION 'SPECIAL guard pending coverage: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
        IF v_card.bsale_nv_id = 90045 THEN
            IF v_cov.covered_qty <> 36 OR v_cov.remaining_qty <> 2 OR v_cov.coverage_status <> 'PARCIAL' THEN
                RAISE EXCEPTION 'SPECIAL guard 90045 coverage drift: covered=% remaining=% status=%', v_cov.covered_qty, v_cov.remaining_qty, v_cov.coverage_status;
            END IF;
            SELECT count(DISTINCT child_doc.bsale_id) INTO v_child_count
            FROM integraciones.bsale_document_details child
            JOIN integraciones.bsale_documents child_doc ON child_doc.company_id = child.company_id AND child_doc.bsale_id = child.bsale_document_id
            JOIN integraciones.bsale_document_details parent ON parent.company_id = child.company_id AND parent.bsale_id = child.related_detail_bsale_id
            WHERE parent.bsale_document_id = v_card.bsale_nv_id AND child_doc.document_type_id IN (1, 5, 7) AND child_doc.state = 0;
            IF v_child_count <> 1 OR NOT EXISTS (
                SELECT 1 FROM integraciones.bsale_document_details child
                JOIN integraciones.bsale_documents child_doc ON child_doc.company_id = child.company_id AND child_doc.bsale_id = child.bsale_document_id
                WHERE child.related_detail_bsale_id IN (SELECT d.bsale_id FROM integraciones.bsale_document_details d WHERE d.company_id = v_company_id AND d.bsale_document_id = v_card.bsale_nv_id)
                  AND child_doc.document_type_id = 1 AND child_doc.state = 0 AND child_doc.number::text = '51292'
            ) THEN RAISE EXCEPTION 'SPECIAL guard 90045 child coverage drift'; END IF;
        ELSE
            IF v_cov.covered_qty <> 0 OR v_cov.coverage_status <> 'SIN_CIERRE' THEN
                RAISE EXCEPTION 'SPECIAL guard zero coverage drift: bsale_nv_id=% covered=% status=%', v_card.bsale_nv_id, v_cov.covered_qty, v_cov.coverage_status;
            END IF;
            IF EXISTS (
                SELECT 1 FROM integraciones.bsale_document_details child
                JOIN integraciones.bsale_documents child_doc ON child_doc.company_id = child.company_id AND child_doc.bsale_id = child.bsale_document_id
                WHERE child.related_detail_bsale_id IN (SELECT d.bsale_id FROM integraciones.bsale_document_details d WHERE d.company_id = v_company_id AND d.bsale_document_id = v_card.bsale_nv_id)
                  AND child_doc.document_type_id IN (1, 5, 7) AND child_doc.state = 0
            ) THEN RAISE EXCEPTION 'SPECIAL guard unexpected child coverage: bsale_nv_id=%', v_card.bsale_nv_id; END IF;
        END IF;
        IF EXISTS (SELECT 1 FROM logistica.sales_order_preparation_exclusions e WHERE e.company_id = v_card.company_id AND e.bsale_nv_id = v_card.bsale_nv_id AND e.active = true) THEN
            RAISE EXCEPTION 'SPECIAL guard active exclusion: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_count FROM legacy_special_snapshot;
    IF v_count <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard snapshot cardinality: %', v_count; END IF;

    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = v_batch_at, closure_reason = 'LEGACY_BACKFILL_ARCHIVED', updated_at = v_batch_at
    FROM legacy_special_snapshot s
    WHERE c.id = s.card_id AND c.company_id = v_company_id
      AND c.closed_at IS NULL AND c.closure_reason IS NULL AND c.status = s.status;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard updated cards: %', v_updated; END IF;

    INSERT INTO logistica.sales_order_preparation_movements (
        company_id, card_id, from_status, to_status, moved_by, movement_source,
        pin_validated, observation, metadata, automation_key
    )
    SELECT s.company_id, s.card_id, s.status, s.status, NULL, 'SYSTEM', false,
        'Archivo especial de legado: correccion reversible de tarjeta excluida del backfill 2026-10-16.',
        jsonb_build_object('action', 'LEGACY_SPECIAL_ARCHIVE', 'batch', v_batch,
          'snapshot_date', '2026-10-16', 'snapshot_file', '2026-10-16_Productos-por-despachar.xlsx',
          'snapshot_sha256', '5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a',
          'preflight_date', '2026-10-19', 'baseline_movements', s.expected_movements,
          'route_event_count', s.route_event_count),
        'BODEGA_LEGACY_SPECIAL_ARCHIVE:20261019:' || s.bsale_nv_id
    FROM legacy_special_snapshot s;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard inserted movements: %', v_count; END IF;

    SELECT count(*) INTO v_total_movements
    FROM logistica.sales_order_preparation_movements m JOIN legacy_special_snapshot s ON s.card_id = m.card_id;
    IF v_total_movements <> 9 THEN RAISE EXCEPTION 'SPECIAL guard movements total final: %, expected 9', v_total_movements; END IF;
    SELECT count(*) INTO v_archived FROM logistica.sales_order_preparation_cards c JOIN legacy_special_snapshot s ON s.card_id = c.id
    WHERE c.closed_at = v_batch_at AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED';
    IF v_archived <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard archived final: %', v_archived; END IF;
    SELECT count(*) INTO v_batch_movements FROM logistica.sales_order_preparation_movements m
    WHERE m.automation_key LIKE 'BODEGA_LEGACY_SPECIAL_ARCHIVE:20261019:%' AND m.moved_by IS NULL AND m.movement_source = 'SYSTEM';
    IF v_batch_movements <> v_expected THEN RAISE EXCEPTION 'SPECIAL guard batch movements final: %', v_batch_movements; END IF;
    IF EXISTS (SELECT 1 FROM legacy_special_snapshot s JOIN logistica.sales_order_preparation_cards c ON c.id = s.card_id WHERE c.status <> s.status) THEN
        RAISE EXCEPTION 'SPECIAL guard status changed';
    END IF;
    FOR v_snapshot IN SELECT * FROM legacy_special_snapshot LOOP
        SELECT count(*) INTO v_route_after FROM logistica.sales_order_preparation_route_events re WHERE re.company_id = v_snapshot.company_id AND re.card_id = v_snapshot.card_id;
        IF v_route_after <> v_snapshot.route_event_count THEN RAISE EXCEPTION 'SPECIAL guard route events changed: bsale_nv_id=%', v_snapshot.bsale_nv_id; END IF;
    END LOOP;
END;
$$;

RESET lock_timeout;
