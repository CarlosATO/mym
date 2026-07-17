-- ============================================================================
-- Migración: Materialización de Próxima Ruta Hábil (V1)
-- Fecha: 2026-07-17
-- ============================================================================

-- 1. Tabla de Auditoría Liviana de Eventos de Ruta
CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_route_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    card_id uuid,
    bsale_nv_id bigint NOT NULL,
    event_type text NOT NULL CHECK (
        event_type IN (
            'MATERIALIZED',
            'REPROGRAMMED',
            'MATERIALIZED_EXCEPTION'
        )
    ),
    from_route_date date NULL,
    to_route_date date NOT NULL,
    performed_by uuid NOT NULL,
    performed_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_route_events_company_nv_type_route ON logistica.sales_order_preparation_route_events(company_id, bsale_nv_id, event_type, to_route_date);
CREATE INDEX IF NOT EXISTS idx_route_events_company_to_route ON logistica.sales_order_preparation_route_events(company_id, to_route_date);
CREATE INDEX IF NOT EXISTS idx_route_events_company_nv ON logistica.sales_order_preparation_route_events(company_id, bsale_nv_id);
CREATE INDEX IF NOT EXISTS idx_route_events_company_card ON logistica.sales_order_preparation_route_events(company_id, card_id);
CREATE INDEX IF NOT EXISTS idx_route_events_company_type ON logistica.sales_order_preparation_route_events(company_id, event_type);

-- 2. Función Materializadora
CREATE OR REPLACE FUNCTION logistica.sync_next_route_preparation_cards(
    p_company_id uuid,
    p_user_id uuid,
    p_dry_run boolean DEFAULT true
)
RETURNS jsonb AS $$
DECLARE
    v_preview jsonb;
    v_route_date date;
    v_has_route boolean;
    v_candidates jsonb;
    v_previous_pending jsonb;
    v_authorized_exceptions jsonb;
    
    v_candidate record;
    v_prev record;
    v_exc record;
    
    v_inserted_count int := 0;
    v_reprogrammed_count int := 0;
    v_materialized_exc_count int := 0;
    
    v_inserted_arr jsonb := '[]'::jsonb;
    v_reprogrammed_arr jsonb := '[]'::jsonb;
    v_exc_arr jsonb := '[]'::jsonb;

    v_new_card_id uuid;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required';
    END IF;

    IF p_dry_run IS NOT TRUE THEN
        RAISE EXCEPTION 'Real materialization is not authorized yet.';
    END IF;

    -- 1. Obtener vista previa
    v_preview := logistica.preview_next_route_candidates(p_company_id);
    v_has_route := (v_preview->>'has_route')::boolean;
    
    IF NOT v_has_route THEN
        RETURN jsonb_build_object(
            'dry_run', p_dry_run,
            'has_route', false,
            'message', 'No hay próxima ruta configurada.'
        );
    END IF;

    v_route_date := (v_preview->>'route_date')::date;
    v_candidates := v_preview->'candidates';
    v_previous_pending := v_preview->'previous_pending';
    v_authorized_exceptions := v_preview->'authorized_exceptions';

    -- 2. Procesar Candidates (IN_CUTOFF)
    FOR v_candidate IN SELECT * FROM jsonb_to_recordset(v_candidates) AS x(bsale_nv_id bigint, nv_folio text, route_city_id uuid, route_location_normalized text) LOOP
        IF NOT p_dry_run THEN
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
            ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
            RETURNING id INTO v_new_card_id;

            IF v_new_card_id IS NOT NULL THEN
                INSERT INTO logistica.sales_order_preparation_route_events (
                    company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
                ) VALUES (
                    p_company_id, v_new_card_id, v_candidate.bsale_nv_id, 'MATERIALIZED', NULL, v_route_date, p_user_id, jsonb_build_object('source', 'IN_CUTOFF')
                )
                ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;
            END IF;
        END IF;

        v_inserted_count := v_inserted_count + 1;
        v_inserted_arr := v_inserted_arr || jsonb_build_object('bsale_nv_id', v_candidate.bsale_nv_id, 'nv_folio', v_candidate.nv_folio);
    END LOOP;

    -- 3. Procesar Previous Pending
    FOR v_prev IN SELECT * FROM jsonb_to_recordset(v_previous_pending) AS x(card_id uuid, bsale_nv_id bigint, nv_folio text, card_route_date date, original_route_date date) LOOP
        IF NOT p_dry_run THEN
            -- UPDATE solo si difiere route_date, pero sin tocar status/last_moved
            UPDATE logistica.sales_order_preparation_cards
            SET route_date = v_route_date,
                original_route_date = COALESCE(logistica.sales_order_preparation_cards.original_route_date, v_prev.card_route_date)
            WHERE id = v_prev.card_id
              AND company_id = p_company_id
              AND route_date <> v_route_date
              AND status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT');

            IF FOUND THEN
                INSERT INTO logistica.sales_order_preparation_route_events (
                    company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
                ) VALUES (
                    p_company_id, v_prev.card_id, v_prev.bsale_nv_id, 'REPROGRAMMED', v_prev.card_route_date, v_route_date, p_user_id, jsonb_build_object('source', 'PREVIOUS_PENDING', 'original_route_date', COALESCE(v_prev.original_route_date, v_prev.card_route_date))
                )
                ON CONFLICT (company_id, bsale_nv_id, event_type, to_route_date) DO NOTHING;
            END IF;
        END IF;

        v_reprogrammed_count := v_reprogrammed_count + 1;
        v_reprogrammed_arr := v_reprogrammed_arr || jsonb_build_object('card_id', v_prev.card_id, 'bsale_nv_id', v_prev.bsale_nv_id, 'from', v_prev.card_route_date, 'to', v_route_date);
    END LOOP;

    -- 4. Procesar Authorized Exceptions
    FOR v_exc IN SELECT * FROM jsonb_to_recordset(v_authorized_exceptions) AS x(bsale_nv_id bigint, nv_folio text, route_city_id uuid, route_location_normalized text) LOOP
        IF NOT p_dry_run THEN
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
            ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
            RETURNING id INTO v_new_card_id;

            IF v_new_card_id IS NOT NULL THEN
                INSERT INTO logistica.sales_order_preparation_route_events (
                    company_id, card_id, bsale_nv_id, event_type, from_route_date, to_route_date, performed_by, metadata
                ) VALUES (
                    p_company_id, v_new_card_id, v_exc.bsale_nv_id, 'MATERIALIZED_EXCEPTION', NULL, v_route_date, p_user_id, jsonb_build_object('source', 'AUTHORIZED_EXCEPTION')
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
        'cities', v_preview->'cities',
        'would_insert_cards', v_inserted_count,
        'would_reprogram_cards', v_reprogrammed_count,
        'would_materialize_exceptions', v_materialized_exc_count,
        'insert_candidates', v_inserted_arr,
        'reprogram_candidates', v_reprogrammed_arr,
        'exception_candidates', v_exc_arr
    );
END;
$$ LANGUAGE plpgsql VOLATILE;
