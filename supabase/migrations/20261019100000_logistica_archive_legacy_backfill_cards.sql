-- DATA-FIX UNICO: archivo transaccional del backfill historico congelado.
--
-- NO ejecutar con db push sobre produccion en este bloque.
-- Batch: LEGACY_BACKFILL_20261016
-- Auditoria/preflight: 2026-10-19
-- Fuente: 2026-10-16_Productos-por-despachar.xlsx
-- Excel SHA-256: 5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a
-- CSV SHA-256: 76c3621cba547834b245a3208af26e8cab837638ed537a4fb690beecff4e29ef
-- JSON SHA-256: 8a015816352bc9637c9692b1a500e9428438b4d64285c13ec88721455d192cff
-- Universo: 61 candidatos. Excluidos expresamente: 83326, 83327, 83878, 90045.
-- Tambien fuera: 91741 y 92172, exclusiones administrativas activas.
-- La API Bsale se verifica fuera de SQL inmediatamente antes de una ejecucion
-- productiva. Este SQL no hace HTTP ni intenta corregir la frescura del sync.

SET lock_timeout = '5s';

DO $$
DECLARE
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
    v_batch text := 'LEGACY_BACKFILL_20261016';
    v_batch_at timestamptz := clock_timestamp();
    v_expected integer := 61;
    v_count integer;
    v_archived integer;
    v_movements integer;
    v_external_movements integer;
    v_bad_cards integer;
    v_updated integer;
    v_route_events_before integer;
    v_route_events_after integer;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_doc integraciones.bsale_documents%ROWTYPE;
    v_cov record;
BEGIN
    -- Serializacion fuerte contra reconcile, Kanban, board y cualquier INSERT de
    -- movement que valide la FK card_id. Si hay una operacion activa, fallar en
    -- vez de esperar indefinidamente o continuar sin exclusividad.
    PERFORM set_config('lock_timeout', '5s', true);
    LOCK TABLE logistica.sales_order_preparation_cards IN ACCESS EXCLUSIVE MODE;

    -- Identidad congelada exclusivamente por (company_id, bsale_nv_id).
    CREATE TEMP TABLE legacy_backfill_targets (
        company_id uuid NOT NULL,
        bsale_nv_id bigint NOT NULL,
        PRIMARY KEY (company_id, bsale_nv_id)
    ) ON COMMIT DROP;

    INSERT INTO legacy_backfill_targets (company_id, bsale_nv_id) VALUES
      (v_company_id, 83836), (v_company_id, 83932), (v_company_id, 83960),
      (v_company_id, 84113), (v_company_id, 84231), (v_company_id, 84455),
      (v_company_id, 84459), (v_company_id, 84649), (v_company_id, 84940),
      (v_company_id, 84958), (v_company_id, 85250), (v_company_id, 85434),
      (v_company_id, 85478), (v_company_id, 85709), (v_company_id, 85764),
      (v_company_id, 85882), (v_company_id, 85942), (v_company_id, 85954),
      (v_company_id, 86051), (v_company_id, 86287), (v_company_id, 86611),
      (v_company_id, 86777), (v_company_id, 86887), (v_company_id, 87033),
      (v_company_id, 87164), (v_company_id, 87192), (v_company_id, 87332),
      (v_company_id, 87404), (v_company_id, 87512), (v_company_id, 87513),
      (v_company_id, 87643), (v_company_id, 87922), (v_company_id, 87973),
      (v_company_id, 88041), (v_company_id, 88146), (v_company_id, 88315),
      (v_company_id, 88451), (v_company_id, 88452), (v_company_id, 88553),
      (v_company_id, 88601), (v_company_id, 88677), (v_company_id, 88682),
      (v_company_id, 88792), (v_company_id, 89119), (v_company_id, 89285),
      (v_company_id, 89387), (v_company_id, 89521), (v_company_id, 90006),
      (v_company_id, 90021), (v_company_id, 90427), (v_company_id, 90431),
      (v_company_id, 90453), (v_company_id, 90467), (v_company_id, 90468),
      (v_company_id, 90555), (v_company_id, 90583), (v_company_id, 90699),
      (v_company_id, 90706), (v_company_id, 90901), (v_company_id, 90996),
      (v_company_id, 91220);

    -- Validacion estructural de la lista, antes de cualquier UPDATE.
    SELECT count(*) INTO v_count FROM legacy_backfill_targets;
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado: lista tiene %, esperadas %', v_count, v_expected;
    END IF;
    SELECT count(DISTINCT bsale_nv_id) INTO v_count FROM legacy_backfill_targets;
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado: NV distintas %, esperadas %', v_count, v_expected;
    END IF;
    IF EXISTS (SELECT 1 FROM legacy_backfill_targets WHERE company_id IS NULL OR bsale_nv_id IS NULL)
       OR EXISTS (SELECT 1 FROM legacy_backfill_targets WHERE company_id <> v_company_id)
       OR EXISTS (SELECT 1 FROM legacy_backfill_targets WHERE bsale_nv_id IN (83326, 83327, 83878, 90045, 91741, 92172)) THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado: identidad o exclusiones prohibidas en lista';
    END IF;

    SELECT count(*) INTO v_archived
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id)
    WHERE c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED';
    SELECT count(*) INTO v_movements
    FROM logistica.sales_order_preparation_movements m
    JOIN logistica.sales_order_preparation_cards c ON c.id = m.card_id
    JOIN legacy_backfill_targets t ON t.company_id = c.company_id AND t.bsale_nv_id = c.bsale_nv_id
    WHERE m.automation_key = 'BODEGA_LEGACY_ARCHIVE:20261016:' || c.bsale_nv_id;

    -- Rerun seguro: solo se acepta el estado completamente aplicado.
    IF v_archived = v_expected OR v_movements > 0 THEN
        IF v_archived <> v_expected OR v_movements <> v_expected THEN
            RAISE EXCEPTION 'LEGACY data-fix abortado: batch parcialmente aplicado (archived %, movements %)', v_archived, v_movements;
        END IF;
        RAISE NOTICE 'LEGACY_BACKFILL_20261016 ya aplicado: 61 tarjetas y 61 movements; no se modifica timestamp';
        RETURN;
    END IF;

    IF v_archived <> 0 OR v_movements <> 0 THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado: estado previo inesperado (archived %, movements %)', v_archived, v_movements;
    END IF;

    -- Pre-assert TOTAL: no basta con que no exista movement de este batch.
    SELECT count(*) INTO v_count
    FROM logistica.sales_order_preparation_movements m
    JOIN logistica.sales_order_preparation_cards c ON c.id = m.card_id
    JOIN legacy_backfill_targets t
      ON t.company_id = c.company_id AND t.bsale_nv_id = c.bsale_nv_id;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'LEGACY guard movements total previo: %, esperados 0', v_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id);
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY guard card cardinality: tarjetas %, esperadas %', v_count, v_expected;
    END IF;

    -- Snapshot de invariantes. El FOR UPDATE serializa frente a movimientos del card.
    CREATE TEMP TABLE legacy_backfill_snapshot ON COMMIT DROP AS
    SELECT c.id AS card_id, c.company_id, c.bsale_nv_id, c.status,
           c.bsale_nv_folio, c.created_at, c.route_date,
           (SELECT count(*) FROM logistica.sales_order_preparation_route_events re
            WHERE re.company_id = c.company_id AND re.card_id = c.id) AS route_event_count
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id)
    WHERE false;

    FOR v_card IN
        SELECT c.*
        FROM logistica.sales_order_preparation_cards c
        JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id)
        ORDER BY c.company_id, c.bsale_nv_id
        FOR UPDATE
    LOOP
        INSERT INTO legacy_backfill_snapshot
        SELECT v_card.id, v_card.company_id, v_card.bsale_nv_id, v_card.status,
               v_card.bsale_nv_folio, v_card.created_at, v_card.route_date,
               (SELECT count(*) FROM logistica.sales_order_preparation_route_events re
                WHERE re.company_id = v_card.company_id AND re.card_id = v_card.id);

        IF v_card.closed_at IS NOT NULL THEN
            RAISE EXCEPTION 'LEGACY guard closed_at: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF v_card.closure_reason IS NOT NULL THEN
            RAISE EXCEPTION 'LEGACY guard closure_reason: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF v_card.status <> 'PENDING_ROUTE_PREP' THEN
            RAISE EXCEPTION 'LEGACY guard status: bsale_nv_id=% status=%', v_card.bsale_nv_id, v_card.status;
        ELSIF v_card.locked_by_user_id IS NOT NULL OR v_card.locked_at IS NOT NULL THEN
            RAISE EXCEPTION 'LEGACY guard active lock: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF v_card.assigned_user_id IS NOT NULL THEN
            RAISE EXCEPTION 'LEGACY guard assigned user: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF v_card.route_date IS NOT NULL AND v_card.route_date > (now() AT TIME ZONE 'America/Santiago')::date THEN
            RAISE EXCEPTION 'LEGACY guard future route: bsale_nv_id=% route_date=%', v_card.bsale_nv_id, v_card.route_date;
        ELSIF EXISTS (
            SELECT 1
            FROM logistica.sales_order_preparation_route_events re
            WHERE re.company_id = v_card.company_id
              AND re.card_id = v_card.id
              AND re.to_route_date > (now() AT TIME ZONE 'America/Santiago')::date
        ) THEN
            RAISE EXCEPTION 'LEGACY guard future route event: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;

        SELECT d.* INTO v_doc
        FROM integraciones.bsale_documents d
        WHERE d.company_id = v_card.company_id AND d.bsale_id = v_card.bsale_nv_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'LEGACY guard document missing: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF v_doc.document_type_id IS DISTINCT FROM 23 THEN
            RAISE EXCEPTION 'LEGACY guard document_type_id: bsale_nv_id=% value=%', v_card.bsale_nv_id, v_doc.document_type_id;
        ELSIF v_doc.state IS DISTINCT FROM 0 THEN
            RAISE EXCEPTION 'LEGACY guard document state: bsale_nv_id=% value=%', v_card.bsale_nv_id, v_doc.state;
        END IF;

        SELECT count(*) INTO v_count
        FROM logistica.sales_order_preparation_movements m
        WHERE m.company_id = v_card.company_id AND m.card_id = v_card.id;
        IF v_count <> 0 THEN
            RAISE EXCEPTION 'LEGACY guard movements_count: bsale_nv_id=% count=%', v_card.bsale_nv_id, v_count;
        END IF;

        IF EXISTS (
            SELECT 1 FROM integraciones.bsale_invoice_sales_order_links link
            JOIN integraciones.bsale_documents invoice
              ON invoice.company_id = link.company_id
             AND invoice.bsale_id = link.invoice_bsale_id
             AND invoice.document_type_id = 5
            WHERE link.company_id = v_card.company_id
              AND link.sales_order_bsale_id = v_card.bsale_nv_id
        ) THEN
            RAISE EXCEPTION 'LEGACY guard invoice link: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;

        IF EXISTS (
            SELECT 1 FROM logistica.sales_order_preparation_exclusions e
            WHERE e.company_id = v_card.company_id AND e.bsale_nv_id = v_card.bsale_nv_id AND e.active = true
        ) THEN
            RAISE EXCEPTION 'LEGACY guard active exclusion: bsale_nv_id=%', v_card.bsale_nv_id;
        END IF;

        SELECT count(*) INTO v_count
        FROM logistica.vw_sales_order_preparation_pending cv
        WHERE cv.company_id = v_card.company_id AND cv.nv_bsale_id = v_card.bsale_nv_id;
        IF v_count <> 1 THEN
            RAISE EXCEPTION 'LEGACY guard canonical view cardinality: bsale_nv_id=% count=%', v_card.bsale_nv_id, v_count;
        END IF;
        SELECT cv.* INTO v_cov
        FROM logistica.vw_sales_order_preparation_pending cv
        WHERE cv.company_id = v_card.company_id AND cv.nv_bsale_id = v_card.bsale_nv_id;
        IF v_cov.is_pending IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'LEGACY guard is_pending: bsale_nv_id=%', v_card.bsale_nv_id;
        ELSIF coalesce(v_cov.remaining_qty, 0) <= 0 THEN
            RAISE EXCEPTION 'LEGACY guard remaining_qty: bsale_nv_id=% remaining=%', v_card.bsale_nv_id, v_cov.remaining_qty;
        ELSIF v_cov.coverage_status IS DISTINCT FROM 'SIN_CIERRE' THEN
            RAISE EXCEPTION 'LEGACY guard coverage_status: bsale_nv_id=% coverage=%', v_card.bsale_nv_id, v_cov.coverage_status;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_count FROM legacy_backfill_snapshot;
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado: tarjetas relevantes %, esperadas %', v_count, v_expected;
    END IF;

    UPDATE logistica.sales_order_preparation_cards c
    SET closed_at = v_batch_at,
        closure_reason = 'LEGACY_BACKFILL_ARCHIVED',
        updated_at = v_batch_at
    FROM legacy_backfill_snapshot s
    WHERE c.id = s.card_id
      AND c.company_id = v_company_id
      AND c.closed_at IS NULL
      AND c.closure_reason IS NULL
      AND c.status = 'PENDING_ROUTE_PREP';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_expected THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado post-update: tarjetas afectadas %, esperadas %', v_updated, v_expected;
    END IF;

    INSERT INTO logistica.sales_order_preparation_movements (
        company_id, card_id, from_status, to_status, moved_by, movement_source,
        pin_validated, observation, metadata, automation_key
    )
    SELECT s.company_id, s.card_id, s.status, s.status, NULL, 'SYSTEM', false,
        'Archivo de legado: tarjeta creada por backfill sin presencia en snapshot operacional de Productos por despachar del 2026-10-16.',
        jsonb_build_object(
            'action', 'LEGACY_BACKFILL_ARCHIVE',
            'closure_reason', 'LEGACY_BACKFILL_ARCHIVED',
            'batch', v_batch,
            'snapshot_date', '2026-10-16',
            'snapshot_file', '2026-10-16_Productos-por-despachar.xlsx',
            'snapshot_sha256', '5bb6cc27ab3a759c8ffee8ae1c9b9f4a7e5f92f361e4580618a83292f74bac0a',
            'preflight_date', '2026-10-19',
            'preflight_csv_sha256', '76c3621cba547834b245a3208af26e8cab837638ed537a4fb690beecff4e29ef',
            'preflight_json_sha256', '8a015816352bc9637c9692b1a500e9428438b4d64285c13ec88721455d192cff',
            'evidence', 'absent_in_productos_por_despachar',
            'actor', 'SYSTEM_DATA_FIX'
        ),
        'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id
    FROM legacy_backfill_snapshot s;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY data-fix abortado post-movement: movements insertados %, esperados %', v_count, v_expected;
    END IF;

    -- Assertions finales dentro de la misma transaccion.
    SELECT count(*) INTO v_archived
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id)
    WHERE c.closed_at IS NOT NULL AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED';
    IF v_archived <> v_expected THEN
        RAISE EXCEPTION 'LEGACY assert closure_reason/closed_at: %, esperadas %', v_archived, v_expected;
    END IF;
    SELECT count(*) INTO v_count
    FROM logistica.sales_order_preparation_cards c
    JOIN legacy_backfill_targets t USING (company_id, bsale_nv_id)
    WHERE c.closed_at IS NOT NULL
      AND c.closure_reason = 'LEGACY_BACKFILL_ARCHIVED'
      AND c.status = 'PENDING_ROUTE_PREP';
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY assert closed/status: %, esperadas %', v_count, v_expected;
    END IF;
    SELECT count(*) INTO v_movements
    FROM logistica.sales_order_preparation_movements m
    JOIN legacy_backfill_snapshot s ON s.card_id = m.card_id
    WHERE m.company_id = v_company_id
      AND m.movement_source = 'SYSTEM'
      AND m.moved_by IS NULL
      AND m.automation_key = 'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id;
    IF v_movements <> v_expected THEN
        RAISE EXCEPTION 'LEGACY assert movements: %, esperados %', v_movements, v_expected;
    END IF;
    SELECT count(*) INTO v_count
    FROM logistica.sales_order_preparation_movements m
    JOIN legacy_backfill_snapshot s ON s.card_id = m.card_id;
    IF v_count <> v_expected THEN
        RAISE EXCEPTION 'LEGACY assert movements totales: %, esperados %', v_count, v_expected;
    END IF;
    SELECT count(*) INTO v_bad_cards
    FROM (
        SELECT s.card_id,
               count(m.id) AS movement_count_total,
               count(m.id) FILTER (
                   WHERE m.movement_source = 'SYSTEM'
                     AND m.moved_by IS NULL
                     AND m.from_status = 'PENDING_ROUTE_PREP'
                     AND m.to_status = 'PENDING_ROUTE_PREP'
                     AND m.automation_key = 'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id
               ) AS movement_count_batch
        FROM legacy_backfill_snapshot s
        LEFT JOIN logistica.sales_order_preparation_movements m
          ON m.company_id = s.company_id AND m.card_id = s.card_id
        GROUP BY s.card_id
        HAVING count(m.id) <> 1
            OR count(m.id) FILTER (
                WHERE m.movement_source = 'SYSTEM'
                  AND m.moved_by IS NULL
                  AND m.from_status = 'PENDING_ROUTE_PREP'
                  AND m.to_status = 'PENDING_ROUTE_PREP'
                  AND m.automation_key = 'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id
            ) <> 1
    ) per_card;
    IF v_bad_cards <> 0 THEN
        RAISE EXCEPTION 'LEGACY assert movements por card: tarjetas invalidas %', v_bad_cards;
    END IF;
    SELECT count(*) INTO v_external_movements
    FROM logistica.sales_order_preparation_movements m
    JOIN legacy_backfill_snapshot s ON s.card_id = m.card_id
    WHERE m.movement_source IS DISTINCT FROM 'SYSTEM'
       OR m.moved_by IS NOT NULL
       OR m.from_status IS DISTINCT FROM 'PENDING_ROUTE_PREP'
       OR m.to_status IS DISTINCT FROM 'PENDING_ROUTE_PREP'
       OR m.automation_key IS DISTINCT FROM 'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id;
    IF v_external_movements <> 0 THEN
        RAISE EXCEPTION 'LEGACY assert movements externos: %, esperados 0', v_external_movements;
    END IF;
    SELECT count(*) INTO v_movements
    FROM logistica.sales_order_preparation_movements m
    JOIN legacy_backfill_snapshot s ON s.card_id = m.card_id
    WHERE m.company_id = v_company_id
      AND m.movement_source = 'SYSTEM'
      AND m.moved_by IS NULL
      AND m.metadata->>'action' = 'LEGACY_BACKFILL_ARCHIVE'
      AND m.metadata->>'closure_reason' = 'LEGACY_BACKFILL_ARCHIVED'
      AND m.automation_key = 'BODEGA_LEGACY_ARCHIVE:20261016:' || s.bsale_nv_id;
    IF v_movements <> v_expected THEN
        RAISE EXCEPTION 'LEGACY assert movement metadata: %, esperados %', v_movements, v_expected;
    END IF;

    SELECT coalesce(sum(route_event_count), 0) INTO v_route_events_before
    FROM legacy_backfill_snapshot;
    SELECT count(*) INTO v_route_events_after
    FROM logistica.sales_order_preparation_route_events re
    JOIN legacy_backfill_snapshot s ON s.card_id = re.card_id
    WHERE re.company_id = v_company_id;
    IF v_route_events_after <> v_route_events_before THEN
        RAISE EXCEPTION 'LEGACY assert route_events: antes %, despues %', v_route_events_before, v_route_events_after;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM logistica.sales_order_preparation_cards c
        JOIN legacy_backfill_snapshot s ON s.card_id = c.id
        WHERE c.status <> s.status OR c.bsale_nv_folio <> s.bsale_nv_folio
           OR c.created_at <> s.created_at OR c.id <> s.card_id
    ) THEN
        RAISE EXCEPTION 'LEGACY assert invariantes: card_id/status/folio/created_at modificados';
    END IF;
END;
$$;

RESET lock_timeout;
