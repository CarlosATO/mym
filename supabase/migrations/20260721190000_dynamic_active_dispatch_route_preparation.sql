-- La preparación se resuelve exclusivamente desde el calendario activo.
-- Conserva tarjetas históricas canceladas y solo materializa documentos de la ruta dinámica vigente.

ALTER TABLE logistica.sales_order_preparation_cards
  DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_company_id_bsale_nv_id_key;

-- Materializaciones técnicas pueden no tener un operador humano, pero quedan auditadas en metadata.
ALTER TABLE logistica.sales_order_preparation_route_events
  ALTER COLUMN performed_by DROP NOT NULL;

ALTER TABLE logistica.sales_order_preparation_route_events
  DROP CONSTRAINT IF EXISTS sales_order_preparation_route_events_event_type_check;

ALTER TABLE logistica.sales_order_preparation_route_events
  ADD CONSTRAINT sales_order_preparation_route_events_event_type_check CHECK (
    event_type IN ('MATERIALIZED', 'REPROGRAMMED', 'MATERIALIZED_EXCEPTION', 'CANCELLED_OUTSIDE_ACTIVE_ROUTE')
  );

CREATE UNIQUE INDEX IF NOT EXISTS sales_order_preparation_cards_active_company_nv_key
  ON logistica.sales_order_preparation_cards (company_id, bsale_nv_id)
  WHERE status <> 'CANCELLED';

CREATE OR REPLACE FUNCTION logistica.preview_next_route_candidates(
  p_company_id uuid,
  p_min_generation_date timestamptz DEFAULT '2026-07-14 00:00:00 America/Santiago'::timestamptz
)
RETURNS jsonb AS $$
DECLARE
  v_context record;
  v_cutoff_chile text;
  v_candidates jsonb;
  v_out_of_cutoff jsonb;
  v_authorized_exceptions jsonb;
  v_existing_cards jsonb;
  v_previous_pending jsonb;
BEGIN
  SELECT * INTO v_context
  FROM logistica.get_next_dispatch_route_context(p_company_id);

  IF v_context.route_date IS NULL THEN
    RETURN jsonb_build_object('has_route', false);
  END IF;

  v_cutoff_chile := to_char(v_context.cutoff_at AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI');

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bsale_nv_id', nv.nv_bsale_id,
    'nv_folio', nv.nv_folio,
    'client_name', nv.client_name,
    'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
    'route_city_id', exc.route_city_id,
    'seller_name', nv.seller_name,
    'nv_emission_date', nv.nv_emission_date,
    'nv_generation_date', nv.nv_generation_date,
    'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
    'net_amount', nv.net_amount,
    'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
    'route_date', exc.route_date,
    'cutoff_at', exc.cutoff_at,
    'cutoff_at_chile', to_char(exc.cutoff_at AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI'),
    'reason', exc.reason,
    'observation', exc.observation,
    'authorized_by_name', exc.authorized_by_name,
    'authorized_at', exc.authorized_at,
    'inclusion_status', 'AUTHORIZED_EXCEPTION'
  )), '[]'::jsonb)
  INTO v_authorized_exceptions
  FROM logistica.sales_order_route_exceptions exc
  LEFT JOIN integraciones.vw_bsale_sales_orders_for_preparation nv
    ON nv.nv_bsale_id = exc.bsale_nv_id
   AND nv.company_id = exc.company_id
  WHERE exc.company_id = p_company_id
    AND exc.route_date = v_context.route_date
    AND exc.active = true;

  -- Existing means an active card for this exact active route context, not merely the same date.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bsale_nv_id', nv.nv_bsale_id,
    'nv_folio', nv.nv_folio,
    'client_name', nv.client_name,
    'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
    'route_city_id', c.route_city_id,
    'seller_name', nv.seller_name,
    'nv_emission_date', nv.nv_emission_date,
    'nv_generation_date', nv.nv_generation_date,
    'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
    'net_amount', nv.net_amount,
    'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
    'route_date', c.route_date,
    'cutoff_at', v_context.cutoff_at,
    'cutoff_at_chile', v_cutoff_chile,
    'card_id', c.id,
    'card_status', c.status,
    'card_route_date', c.route_date,
    'original_route_date', c.original_route_date,
    'inclusion_status', 'ALREADY_MATERIALIZED'
  )), '[]'::jsonb)
  INTO v_existing_cards
  FROM integraciones.vw_bsale_sales_orders_for_preparation nv
  JOIN logistica.sales_order_preparation_cards c
    ON c.bsale_nv_id = nv.nv_bsale_id
   AND c.company_id = p_company_id
  WHERE nv.company_id = p_company_id
    AND c.route_date = v_context.route_date
    AND c.status <> 'CANCELLED'
    AND COALESCE(c.route_location_normalized, c.normalized_city) = ANY(v_context.normalized_cities);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bsale_nv_id', nv.nv_bsale_id,
    'nv_folio', nv.nv_folio,
    'client_name', nv.client_name,
    'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
    'route_city_id', c.route_city_id,
    'seller_name', nv.seller_name,
    'nv_emission_date', nv.nv_emission_date,
    'nv_generation_date', nv.nv_generation_date,
    'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
    'net_amount', nv.net_amount,
    'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
    'route_date', c.route_date,
    'cutoff_at', v_context.cutoff_at,
    'cutoff_at_chile', v_cutoff_chile,
    'card_id', c.id,
    'card_status', c.status,
    'card_route_date', c.route_date,
    'original_route_date', c.original_route_date,
    'inclusion_status', 'PREVIOUS_ROUTE_PENDING'
  )), '[]'::jsonb)
  INTO v_previous_pending
  FROM integraciones.vw_bsale_sales_orders_for_preparation nv
  JOIN logistica.sales_order_preparation_cards c
    ON c.bsale_nv_id = nv.nv_bsale_id
   AND c.company_id = p_company_id
  WHERE nv.company_id = p_company_id
    AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
    AND c.route_date < v_context.route_date
    AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT');

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bsale_nv_id', nv.nv_bsale_id,
    'nv_folio', nv.nv_folio,
    'client_name', nv.client_name,
    'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
    'route_city_id', (SELECT id FROM logistica.dispatch_cities WHERE company_id = p_company_id AND name = logistica.normalize_city(p_company_id, nv.route_location_raw) LIMIT 1),
    'seller_name', nv.seller_name,
    'nv_emission_date', nv.nv_emission_date,
    'nv_generation_date', nv.nv_generation_date,
    'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
    'net_amount', nv.net_amount,
    'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
    'route_date', v_context.route_date,
    'cutoff_at', v_context.cutoff_at,
    'cutoff_at_chile', v_cutoff_chile,
    'inclusion_status', 'IN_CUTOFF'
  )), '[]'::jsonb)
  INTO v_candidates
  FROM integraciones.vw_bsale_sales_orders_for_preparation nv
  WHERE nv.company_id = p_company_id
    AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_preparation_cards c
      WHERE c.bsale_nv_id = nv.nv_bsale_id
        AND c.company_id = p_company_id
        AND c.status <> 'CANCELLED'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_route_exceptions exc
      WHERE exc.bsale_nv_id = nv.nv_bsale_id
        AND exc.company_id = p_company_id
        AND exc.route_date = v_context.route_date
        AND exc.active = true
    )
    AND nv.nv_generation_date >= p_min_generation_date
    AND nv.nv_generation_date <= v_context.cutoff_at;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'bsale_nv_id', nv.nv_bsale_id,
    'nv_folio', nv.nv_folio,
    'client_name', nv.client_name,
    'route_location_normalized', logistica.normalize_city(p_company_id, nv.route_location_raw),
    'route_city_id', (SELECT id FROM logistica.dispatch_cities WHERE company_id = p_company_id AND name = logistica.normalize_city(p_company_id, nv.route_location_raw) LIMIT 1),
    'seller_name', nv.seller_name,
    'nv_emission_date', nv.nv_emission_date,
    'nv_generation_date', nv.nv_generation_date,
    'nv_generation_date_chile', to_char(nv.nv_generation_date AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS'),
    'net_amount', nv.net_amount,
    'gross_amount', COALESCE(nv.gross_amount, nv.total_amount),
    'route_date', v_context.route_date,
    'cutoff_at', v_context.cutoff_at,
    'cutoff_at_chile', v_cutoff_chile,
    'inclusion_status', 'OUT_OF_CUTOFF'
  )), '[]'::jsonb)
  INTO v_out_of_cutoff
  FROM integraciones.vw_bsale_sales_orders_for_preparation nv
  WHERE nv.company_id = p_company_id
    AND logistica.normalize_city(p_company_id, nv.route_location_raw) = ANY(v_context.normalized_cities)
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_preparation_cards c
      WHERE c.bsale_nv_id = nv.nv_bsale_id
        AND c.company_id = p_company_id
        AND c.status <> 'CANCELLED'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM logistica.sales_order_route_exceptions exc
      WHERE exc.bsale_nv_id = nv.nv_bsale_id
        AND exc.company_id = p_company_id
        AND exc.route_date = v_context.route_date
        AND exc.active = true
    )
    AND nv.nv_generation_date >= p_min_generation_date
    AND nv.nv_generation_date > v_context.cutoff_at;

  RETURN jsonb_build_object(
    'has_route', true,
    'route_date', v_context.route_date,
    'route_weekday', v_context.route_weekday,
    'cutoff_at', v_context.cutoff_at,
    'cutoff_at_chile', v_cutoff_chile,
    'calendar_id', v_context.calendar_id,
    'calendar_name', v_context.calendar_name,
    'cities', v_context.normalized_cities,
    'counts', jsonb_build_object(
      'in_cutoff', jsonb_array_length(v_candidates),
      'out_cutoff', jsonb_array_length(v_out_of_cutoff),
      'exceptions', jsonb_array_length(v_authorized_exceptions),
      'existing_cards', jsonb_array_length(v_existing_cards),
      'previous_pending', jsonb_array_length(v_previous_pending)
    ),
    'candidates', v_candidates,
    'out_of_cutoff', v_out_of_cutoff,
    'authorized_exceptions', v_authorized_exceptions,
    'existing_cards', v_existing_cards,
    'previous_pending', v_previous_pending
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION logistica.sync_next_route_preparation_cards(
  p_company_id uuid,
  p_user_id uuid,
  p_dry_run boolean DEFAULT true,
  p_confirmation text DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_context record;
  v_preview jsonb;
  v_route_date date;
  v_candidates jsonb;
  v_previous_pending jsonb;
  v_authorized_exceptions jsonb;
  v_candidate record;
  v_prev record;
  v_exc record;
  v_new_card_id uuid;
  v_inserted_count int := 0;
  v_reprogrammed_count int := 0;
  v_materialized_exc_count int := 0;
  v_cancelled_count int := 0;
  v_inserted_arr jsonb := '[]'::jsonb;
  v_reprogrammed_arr jsonb := '[]'::jsonb;
  v_exc_arr jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_context
  FROM logistica.get_next_dispatch_route_context(p_company_id);

  IF v_context.route_date IS NULL THEN
    RETURN jsonb_build_object('dry_run', p_dry_run, 'has_route', false, 'message', 'No hay próxima ruta configurada.');
  END IF;

  v_route_date := v_context.route_date;

  -- Historical cards outside the current calendar route are retained but cancelled only when untouched.
  IF p_dry_run IS NOT TRUE THEN
    WITH cancelled_cards AS (
      UPDATE logistica.sales_order_preparation_cards c
      SET status = 'CANCELLED',
          notes = concat_ws(E'\n', c.notes, format('Cancelada técnicamente: ciudad fuera de la ruta activa del calendario para %s.', v_route_date)),
          updated_at = now()
      WHERE c.company_id = p_company_id
        AND c.route_date = v_route_date
        AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT')
        AND NOT (COALESCE(c.route_location_normalized, c.normalized_city) = ANY(v_context.normalized_cities))
        AND NOT EXISTS (
          SELECT 1
          FROM logistica.sales_order_preparation_movements m
          WHERE m.company_id = c.company_id
            AND m.card_id = c.id
        )
      RETURNING c.id, c.bsale_nv_id, c.route_date
    ), recorded AS (
      INSERT INTO logistica.sales_order_preparation_route_events (
        company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
      )
      SELECT
        p_company_id,
        cc.id,
        cc.bsale_nv_id,
        'CANCELLED_OUTSIDE_ACTIVE_ROUTE',
        cc.route_date,
        cc.route_date,
        p_user_id,
        jsonb_build_object('source', 'ACTIVE_CALENDAR_CONTEXT', 'active_cities', v_context.normalized_cities)
      FROM cancelled_cards cc
      ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING
      RETURNING card_id
    )
    SELECT count(*) INTO v_cancelled_count FROM cancelled_cards;
  END IF;

  v_preview := logistica.preview_next_route_candidates(p_company_id);
  v_candidates := v_preview->'candidates';
  v_previous_pending := v_preview->'previous_pending';
  v_authorized_exceptions := v_preview->'authorized_exceptions';

  FOR v_candidate IN
    SELECT *
    FROM jsonb_to_recordset(v_candidates) AS x(
      bsale_nv_id bigint,
      nv_folio text,
      route_city_id uuid,
      route_location_normalized text
    )
  LOOP
    IF p_dry_run IS NOT TRUE THEN
      v_new_card_id := NULL;
      INSERT INTO logistica.sales_order_preparation_cards (
        company_id, bsale_nv_id, bsale_nv_folio, status,
        route_date, original_route_date, route_city_id,
        route_location_normalized, normalized_city
      ) VALUES (
        p_company_id, v_candidate.bsale_nv_id, v_candidate.nv_folio, 'PENDING_ROUTE_PREP',
        v_route_date, NULL, v_candidate.route_city_id,
        v_candidate.route_location_normalized, v_candidate.route_location_normalized
      )
      ON CONFLICT (company_id, bsale_nv_id) WHERE status <> 'CANCELLED' DO NOTHING
      RETURNING id INTO v_new_card_id;

      IF v_new_card_id IS NOT NULL THEN
        INSERT INTO logistica.sales_order_preparation_route_events (
          company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
        ) VALUES (
          p_company_id, v_new_card_id, v_candidate.bsale_nv_id, 'MATERIALIZED', NULL, v_route_date, p_user_id,
          jsonb_build_object('source', 'ACTIVE_CALENDAR_CONTEXT', 'normalized_city', v_candidate.route_location_normalized)
        )
        ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;
      END IF;
    END IF;

    v_inserted_count := v_inserted_count + 1;
    v_inserted_arr := v_inserted_arr || jsonb_build_object('bsale_nv_id', v_candidate.bsale_nv_id, 'nv_folio', v_candidate.nv_folio);
  END LOOP;

  FOR v_prev IN
    SELECT *
    FROM jsonb_to_recordset(v_previous_pending) AS x(
      card_id uuid,
      bsale_nv_id bigint,
      nv_folio text,
      card_route_date date,
      original_route_date date
    )
  LOOP
    IF p_dry_run IS NOT TRUE THEN
      UPDATE logistica.sales_order_preparation_cards
      SET route_date = v_route_date,
          original_route_date = COALESCE(logistica.sales_order_preparation_cards.original_route_date, v_prev.card_route_date),
          updated_at = now()
      WHERE id = v_prev.card_id
        AND company_id = p_company_id
        AND route_date <> v_route_date
        AND status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT');

      IF FOUND THEN
        INSERT INTO logistica.sales_order_preparation_route_events (
          company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
        ) VALUES (
          p_company_id, v_prev.card_id, v_prev.bsale_nv_id, 'REPROGRAMMED', v_prev.card_route_date, v_route_date, p_user_id,
          jsonb_build_object('source', 'PREVIOUS_PENDING', 'original_route_date', COALESCE(v_prev.original_route_date, v_prev.card_route_date))
        )
        ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;
      END IF;
    END IF;

    v_reprogrammed_count := v_reprogrammed_count + 1;
    v_reprogrammed_arr := v_reprogrammed_arr || jsonb_build_object('card_id', v_prev.card_id, 'bsale_nv_id', v_prev.bsale_nv_id, 'from', v_prev.card_route_date, 'to', v_route_date);
  END LOOP;

  FOR v_exc IN
    SELECT *
    FROM jsonb_to_recordset(v_authorized_exceptions) AS x(
      bsale_nv_id bigint,
      nv_folio text,
      route_city_id uuid,
      route_location_normalized text
    )
  LOOP
    IF p_dry_run IS NOT TRUE THEN
      v_new_card_id := NULL;
      INSERT INTO logistica.sales_order_preparation_cards (
        company_id, bsale_nv_id, bsale_nv_folio, status,
        route_date, original_route_date, route_city_id,
        route_location_normalized, normalized_city
      ) VALUES (
        p_company_id, v_exc.bsale_nv_id, v_exc.nv_folio, 'PENDING_ROUTE_PREP',
        v_route_date, NULL, v_exc.route_city_id,
        v_exc.route_location_normalized, v_exc.route_location_normalized
      )
      ON CONFLICT (company_id, bsale_nv_id) WHERE status <> 'CANCELLED' DO NOTHING
      RETURNING id INTO v_new_card_id;

      IF v_new_card_id IS NOT NULL THEN
        INSERT INTO logistica.sales_order_preparation_route_events (
          company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
        ) VALUES (
          p_company_id, v_new_card_id, v_exc.bsale_nv_id, 'MATERIALIZED_EXCEPTION', NULL, v_route_date, p_user_id,
          jsonb_build_object('source', 'AUTHORIZED_EXCEPTION', 'normalized_city', v_exc.route_location_normalized)
        )
        ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;
      END IF;
    END IF;

    v_materialized_exc_count := v_materialized_exc_count + 1;
    v_exc_arr := v_exc_arr || jsonb_build_object('bsale_nv_id', v_exc.bsale_nv_id, 'nv_folio', v_exc.nv_folio);
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'has_route', true,
    'route_date', v_route_date,
    'cities', v_context.normalized_cities,
    'cancelled_outside_active_route', v_cancelled_count,
    'would_insert_cards', v_inserted_count,
    'would_reprogram_cards', v_reprogrammed_count,
    'would_materialize_exceptions', v_materialized_exc_count,
    'insert_candidates', v_inserted_arr,
    'reprogram_candidates', v_reprogrammed_arr,
    'exception_candidates', v_exc_arr
  );
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Apply the generic resolver to the approved company. The route date and cities are resolved at execution time.
SELECT logistica.sync_next_route_preparation_cards(
  'd1000000-0000-0000-0000-000000000001'::uuid,
  NULL,
  false,
  NULL
);
