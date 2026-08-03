-- Migration: 20260803093000_inventarios_partial_scope_rpcs.sql
-- Description: Fase 4H.2B. RPCs de alcance parcial: definir el conjunto de
--              productos (variantes Bsale) de una jornada DRAFT PARTIAL,
--              consultarlo y buscar variantes para el selector del asistente.
-- Author: Assistant

-- ============================================================
-- 1. RPC: set_inventory_session_product_scope
--    Reemplaza atomicamente el alcance INCLUDED de productos de una jornada
--    DRAFT con scope_mode PARTIAL. Solo variantes activas de la misma empresa.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.set_inventory_session_product_scope(
    p_company_id uuid,
    p_session_id uuid,
    p_bsale_variant_ids integer[],
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid; v_operation jsonb; v_operation_id uuid;
    v_session_status text; v_scope_mode text;
    v_variant_count bigint; v_distinct_count bigint;
    v_occurred_at timestamptz; v_response jsonb; v_payload jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_bsale_variant_ids IS NULL
       OR pg_catalog.array_length(p_bsale_variant_ids, 1) IS NULL
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.configure');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.set_inventory_session_product_scope'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.product_scope.set','company_id',p_company_id,
        'session_id',p_session_id,'bsale_variant_ids',p_bsale_variant_ids);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.session.product_scope.set',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT s.status, s.scope_mode
    INTO v_session_status, v_scope_mode
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF v_session_status <> 'DRAFT' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La jornada no permite esta operacion en su estado actual.','retryable',false)::text;
    END IF;
    IF v_scope_mode <> 'PARTIAL' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El alcance de productos solo aplica a jornadas parciales.','retryable',false,'scope_mode',v_scope_mode)::text;
    END IF;

    SELECT pg_catalog.count(DISTINCT v), pg_catalog.count(*)
    INTO v_distinct_count, v_variant_count
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v;

    IF v_distinct_count <> v_variant_count THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La lista contiene variantes duplicadas.','retryable',false)::text;
    END IF;

    SELECT pg_catalog.count(*) INTO v_variant_count
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = p_company_id AND bv.bsale_id = v
    WHERE bv.state = 0 AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> '';

    IF v_variant_count <> pg_catalog.array_length(p_bsale_variant_ids, 1) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','Algunas variantes no existen o no estan activas en la empresa.','retryable',false)::text;
    END IF;

    v_occurred_at := pg_catalog.now();

    DELETE FROM inventarios.session_product_scopes sps
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id;

    INSERT INTO inventarios.session_product_scopes (company_id, session_id, bsale_variant_id,
        inclusion_type, created_at, created_by)
    SELECT p_company_id, p_session_id, v, 'INCLUDED', v_occurred_at, v_actor_id
    FROM pg_catalog.unnest(p_bsale_variant_ids) AS v
    ORDER BY v;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.session.product_scope.set','entity_id',p_session_id,
        'state','DRAFT','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object('bsale_variant_ids',p_bsale_variant_ids,
            'variant_count',pg_catalog.array_length(p_bsale_variant_ids, 1),
            'replaced',true));
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, p_session_id, v_response);
END;
$$;

-- ============================================================
-- 2. RPC: get_inventory_session_product_scope
--    Devuelve las variantes INCLUDED del alcance parcial de una jornada.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_session_product_scope(
    p_company_id uuid,
    p_session_id uuid
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_scope jsonb;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', sps.bsale_variant_id,
                'sku', bv.code,
                'barcode', bv.bar_code,
                'name', pg_catalog.coalesce(pg_catalog.btrim(bv.description), bv.code),
                'inclusion_type', sps.inclusion_type,
                'created_at', sps.created_at
            )
            ORDER BY bv.code
        )
    END
    INTO v_scope
    FROM inventarios.session_product_scopes sps
    JOIN integraciones.bsale_variants bv
      ON bv.company_id = sps.company_id AND bv.bsale_id = sps.bsale_variant_id
    WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
      AND sps.inclusion_type = 'INCLUDED';

    RETURN pg_catalog.jsonb_build_object(
        'session_id', p_session_id,
        'bsale_variant_ids', (
            SELECT CASE
                WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                ELSE pg_catalog.jsonb_agg(sps.bsale_variant_id ORDER BY sps.bsale_variant_id)
            END
            FROM inventarios.session_product_scopes sps
            WHERE sps.company_id = p_company_id AND sps.session_id = p_session_id
              AND sps.inclusion_type = 'INCLUDED'
        ),
        'products', v_scope
    );
END;
$$;

-- ============================================================
-- 3. RPC: search_inventory_variants
--    Selector paginado de variantes Bsale activas de la empresa para el
--    asistente de alcance parcial. Liviano y determinista.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.search_inventory_variants(
    p_company_id uuid,
    p_search text,
    p_page integer,
    p_page_size integer
)
RETURNS jsonb LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_search text;
    v_page integer; v_page_size integer; v_offset integer;
    v_total bigint; v_rows jsonb;
BEGIN
    IF p_company_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    v_search := pg_catalog.btrim(pg_catalog.coalesce(p_search, ''));
    v_page := pg_catalog.coalesce(p_page, 1);
    v_page_size := pg_catalog.coalesce(p_page_size, 25);
    IF v_page < 1 THEN v_page := 1; END IF;
    IF v_page_size < 1 THEN v_page_size := 25; END IF;
    IF v_page_size > 100 THEN v_page_size := 100; END IF;
    v_offset := (v_page - 1) * v_page_size;

    SELECT pg_catalog.count(*) INTO v_total
    FROM integraciones.bsale_variants bv
    WHERE bv.company_id = p_company_id AND bv.state = 0
      AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
      AND (v_search = '' OR bv.code ILIKE '%' || v_search || '%'
           OR pg_catalog.coalesce(bv.description, '') ILIKE '%' || v_search || '%'
           OR pg_catalog.coalesce(bv.bar_code, '') ILIKE '%' || v_search || '%');

    SELECT CASE
        WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'bsale_variant_id', bv.bsale_id,
                'sku', bv.code,
                'barcode', bv.bar_code,
                'name', pg_catalog.coalesce(pg_catalog.btrim(bv.description), bv.code)
            )
            ORDER BY bv.code
        )
    END
    INTO v_rows
    FROM (
        SELECT bv.bsale_id, bv.code, bv.bar_code, bv.description
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.state = 0
          AND bv.code IS NOT NULL AND pg_catalog.btrim(bv.code) <> ''
          AND (v_search = '' OR bv.code ILIKE '%' || v_search || '%'
               OR pg_catalog.coalesce(bv.description, '') ILIKE '%' || v_search || '%'
               OR pg_catalog.coalesce(bv.bar_code, '') ILIKE '%' || v_search || '%')
        ORDER BY bv.code
        LIMIT v_page_size OFFSET v_offset
    ) bv;

    RETURN pg_catalog.jsonb_build_object(
        'total', v_total,
        'page', v_page,
        'page_size', v_page_size,
        'has_more', v_offset + pg_catalog.jsonb_array_length(CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END) < v_total,
        'variants', CASE WHEN v_rows IS NULL THEN '[]'::jsonb ELSE v_rows END
    );
END;
$$;

-- ============================================================
-- 4. OWNER, REVOKES Y GRANTS
-- ============================================================
ALTER FUNCTION inventarios.set_inventory_session_product_scope(uuid, uuid, integer[], uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_session_product_scope(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.search_inventory_variants(uuid, text, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.set_inventory_session_product_scope(uuid, uuid, integer[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.get_inventory_session_product_scope(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.search_inventory_variants(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.set_inventory_session_product_scope(uuid, uuid, integer[], uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_session_product_scope(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION inventarios.search_inventory_variants(uuid, text, integer, integer) TO authenticated;
