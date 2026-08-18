-- =========================================================================================
-- MIGRATION: M1.5G.3 - Prevalidacion read-only de barcode para ejecucion de auditorias
-- =========================================================================================
-- Objetivo:
--   Permitir que Mobile valide un barcode recien escaneado contra el producto auditado
--   ANTES de habilitar el ingreso de cantidad, sin registrar conteos ni modificar el
--   estado de la auditoria.
--
-- Fuente unica de verdad:
--   Se extrae la semantica de resolucion de barcode usada por record_inventory_audit_result
--   (integraciones.bsale_variants.bar_code + inventory_campaign_snapshot_products.barcode
--   + product_barcode_aliases activos) a un helper interno compartido:
--   inventarios.resolve_audit_barcode(company_id, campaign_id, scanned_code).
--   Tanto record_inventory_audit_result como el nuevo validate_inventory_audit_barcode
--   la consumen, evitando dos implementaciones divergentes.
--
-- Read-only:
--   El nuevo RPC NO crea inventory_audit_results, NO crea eventos, NO incrementa
--   revisiones, NO cambia estados, NO inicia auditorias, NO genera propuestas ni aliases.
--   El guard transaccional de record_inventory_audit_result se mantiene intacto:
--   la prevalidacion mejora la UX pero no reemplaza la validacion definitiva al guardar.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

-- ============================================================
-- 1. HELPER INTERNO COMPARTIDO: resolucion de barcode de auditoria
--    Misma fuente de verdad usada por record_inventory_audit_result.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resolve_audit_barcode(
    p_company_id uuid,
    p_campaign_id uuid,
    p_scanned_code text
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_scanned text;
    v_resolved_variant integer;
    v_resolved_count integer;
    v_method text;
BEGIN
    v_scanned := pg_catalog.btrim(coalesce(p_scanned_code, ''));

    -- Misma fuente de verdad del conteo Mobile y de record_inventory_audit_result:
    --   * integraciones.bsale_variants.bar_code  (barcode principal, state=0)
    --   * inventarios.inventory_campaign_snapshot_products.barcode (catalogo congelado)
    --   * inventarios.product_barcode_aliases    (alias autorizado aprobado)
    WITH code_match AS (
        SELECT al.bsale_variant_id AS resolved_variant
        FROM inventarios.product_barcode_aliases al
        WHERE al.company_id = p_company_id AND al.is_active = true AND al.barcode = v_scanned
        UNION
        SELECT bv.bsale_id
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.state = 0 AND bv.bar_code = v_scanned
        UNION
        SELECT csp.bsale_variant_id
        FROM inventarios.inventory_campaign_snapshot_products csp
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.id = csp.campaign_snapshot_id AND cs.company_id = csp.company_id
         AND cs.campaign_id = p_campaign_id
        WHERE csp.company_id = p_company_id AND csp.barcode = v_scanned
    )
    SELECT pg_catalog.count(DISTINCT resolved_variant), pg_catalog.min(resolved_variant)
    INTO v_resolved_count, v_resolved_variant
    FROM code_match;

    -- Metodo de identificacion: alias activo gana sobre barcode principal (misma regla
    -- de record_inventory_audit_result).
    v_method := 'BARCODE';
    IF EXISTS (
        SELECT 1 FROM inventarios.product_barcode_aliases al
        WHERE al.company_id = p_company_id AND al.is_active = true AND al.barcode = v_scanned
    ) THEN
        v_method := 'ALIAS';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'resolved_variant', v_resolved_variant,
        'resolved_count', v_resolved_count,
        'method', v_method
    );
END;
$function$;

ALTER FUNCTION inventarios.resolve_audit_barcode(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.resolve_audit_barcode(uuid, uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION inventarios.resolve_audit_barcode(uuid, uuid, text) IS
    'Helper interno compartido: resuelve un barcode contra la fuente de verdad de auditoria. Read-only.';

-- ============================================================
-- 2. record_inventory_audit_result REESCRITO para usar el helper compartido
--    (misma semantica contractual; el guard transaccional se mantiene intacto).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.record_inventory_audit_result(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_product_id uuid,
    p_audit_location_id uuid,
    p_scanned_code text,
    p_physical_quantity numeric,
    p_captured_at timestamptz,
    p_idempotency_key uuid,
    p_device_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_scanned text;
    v_audit_status text;
    v_assigned_user_id uuid;
    v_campaign_id uuid;
    v_product_status text;
    v_scope_status text;
    v_variant integer;
    v_location_count integer;
    v_location_id uuid;
    v_location_code text;
    v_location_name text;
    v_resolution jsonb;
    v_resolved_variant integer;
    v_resolved_count integer;
    v_method text;
    v_prev_qty numeric;
    v_revision integer;
    v_result_id uuid;
    v_event_id uuid;
    v_total_locs bigint;
    v_counted_locs bigint;
    v_occurred_at timestamptz;
    v_captured_at timestamptz;
BEGIN
    v_scanned := pg_catalog.btrim(coalesce(p_scanned_code, ''));
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_audit_product_id IS NULL
       OR p_audit_location_id IS NULL OR v_scanned = ''
       OR pg_catalog.char_length(v_scanned) > 100
       OR p_physical_quantity IS NULL OR p_physical_quantity < 0
       OR p_physical_quantity > 99999999999.999
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    PERFORM inventarios.require_company_access(p_company_id);
    v_occurred_at := pg_catalog.now();
    v_captured_at := coalesce(p_captured_at, v_occurred_at);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.record_inventory_audit_result'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.audit.result.record','company_id',p_company_id,
        'audit_id',p_audit_id,'audit_product_id',p_audit_product_id,
        'audit_location_id',p_audit_location_id,'scanned_code',v_scanned,
        'physical_quantity',p_physical_quantity,'captured_at',v_captured_at);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.audit.result.record',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    -- Auditoria asignada al actor y en ejecucion.
    SELECT a.status, a.assigned_user_id, a.campaign_id
    INTO v_audit_status, v_assigned_user_id, v_campaign_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;
    IF v_assigned_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está asignada a este usuario.','retryable',false)::text;
    END IF;
    IF v_audit_status = 'ASSIGNED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_STARTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Inicia la auditoría antes de registrar resultados.','retryable',false)::text;
    END IF;
    IF v_audit_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está en ejecución.','retryable',false,'status',v_audit_status)::text;
    END IF;

    -- Producto perteneciente a la auditoria y con ubicaciones concretas (este bloque).
    SELECT ap.status, ap.scope_status, ap.bsale_variant_id
    INTO v_product_status, v_scope_status, v_variant
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id AND ap.id = p_audit_product_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no pertenece a la auditoría.','retryable',false)::text;
    END IF;
    IF v_scope_status <> 'LOCATIONS_RESOLVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_SCOPE_UNSUPPORTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Este producto sin ubicación previa aún no admite registro por ubicación.','retryable',false)::text;
    END IF;

    -- Ubicacion incluida realmente en el alcance del producto auditado.
    SELECT count(*) INTO v_location_count
    FROM inventarios.inventory_audit_locations l
    WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
      AND l.audit_product_id = p_audit_product_id AND l.id = p_audit_location_id;
    IF v_location_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_LOCATION_NOT_IN_SCOPE',
            DETAIL=pg_catalog.jsonb_build_object('message','La ubicación no pertenece al alcance de la auditoría.','retryable',false)::text;
    END IF;

    -- Resolucion del barcode escaneado: MISMA semantica que la prevalidacion
    -- (helper compartido inventarios.resolve_audit_barcode, fuente unica de verdad).
    v_resolution := inventarios.resolve_audit_barcode(p_company_id, v_campaign_id, v_scanned);
    v_resolved_count := (v_resolution ->> 'resolved_count')::int;
    v_resolved_variant := (v_resolution ->> 'resolved_variant')::int;
    v_method := v_resolution ->> 'method';

    IF v_resolved_count = 0 THEN
        -- Barcode no reconocido. El flujo manual/incidencia del conteo normal
        -- (product_barcode_proposals) esta acoplado por FK a count_entries y no puede
        -- reutilizarse sin contaminar el conteo efectivo. Se rechaza la captura y NO se
        -- construye un sistema paralelo (bloqueo documentado).
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_BARCODE_UNRECOGNIZED',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras no está reconocido.','retryable',false,'audit_product_id',p_audit_product_id)::text;
    END IF;
    IF v_resolved_count > 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_BARCODE_AMBIGUOUS',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras corresponde a más de un producto.','retryable',false)::text;
    END IF;
    IF v_resolved_variant IS DISTINCT FROM v_variant THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_WRONG_PRODUCT',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras pertenece a otro producto.','retryable',false,'expected_bsale_variant_id',v_variant,'scanned_bsale_variant_id',v_resolved_variant)::text;
    END IF;

    SELECT l.location_id, l.location_code, l.location_name
    INTO v_location_id, v_location_code, v_location_name
    FROM inventarios.inventory_audit_locations l
    WHERE l.company_id = p_company_id AND l.id = p_audit_location_id;

    -- Revision vigente y nueva revision para el producto+ubicacion.
    SELECT r.physical_quantity, r.revision_number
    INTO v_prev_qty, v_revision
    FROM inventarios.inventory_audit_results r
    WHERE r.company_id = p_company_id
      AND r.audit_product_id = p_audit_product_id
      AND r.audit_location_id = p_audit_location_id
    FOR UPDATE;
    IF NOT FOUND THEN
        v_revision := 0;
        v_prev_qty := NULL;
    END IF;
    v_revision := v_revision + 1;

    -- UPSERT: la ultima captura valida gana (nunca se suman).
    INSERT INTO inventarios.inventory_audit_results (
        company_id, campaign_id, audit_id, audit_product_id, audit_location_id,
        bsale_variant_id, location_id, location_code, location_name,
        scanned_code, identification_method, physical_quantity,
        audited_by, captured_at, recorded_at, revision_number,
        created_at, created_by, updated_at, updated_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, p_audit_location_id,
        v_variant, v_location_id, v_location_code, v_location_name,
        v_scanned, v_method, p_physical_quantity,
        v_actor_id, v_captured_at, v_occurred_at, v_revision,
        v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
    )
    ON CONFLICT (company_id, audit_product_id, audit_location_id)
    DO UPDATE SET
        physical_quantity = EXCLUDED.physical_quantity,
        scanned_code = EXCLUDED.scanned_code,
        identification_method = EXCLUDED.identification_method,
        audited_by = EXCLUDED.audited_by,
        captured_at = EXCLUDED.captured_at,
        recorded_at = EXCLUDED.recorded_at,
        revision_number = EXCLUDED.revision_number,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
    RETURNING id INTO v_result_id;

    -- Historial append-only de la captura (trazabilidad de revisiones).
    INSERT INTO inventarios.inventory_audit_result_events (
        company_id, campaign_id, audit_id, audit_product_id, audit_location_id,
        revision_number, previous_quantity, physical_quantity,
        scanned_code, identification_method, audited_by,
        captured_at, occurred_at, idempotency_key, created_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, p_audit_location_id,
        v_revision, v_prev_qty, p_physical_quantity,
        v_scanned, v_method, v_actor_id,
        v_captured_at, v_occurred_at, p_idempotency_key, v_actor_id
    )
    RETURNING id INTO v_event_id;

    -- Progreso de ubicaciones del producto para feedback inmediato.
    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM inventarios.inventory_audit_results r
               WHERE r.company_id = l.company_id
                 AND r.audit_product_id = l.audit_product_id
                 AND r.audit_location_id = l.id
           ))
    INTO v_total_locs, v_counted_locs
    FROM inventarios.inventory_audit_locations l
    WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
      AND l.audit_product_id = p_audit_product_id;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        v_result_id,
        pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.result.record',
            'entity_id', v_result_id,
            'state','IN_PROGRESS',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', v_event_id,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'audit_id', p_audit_id,
                'audit_product_id', p_audit_product_id,
                'audit_location_id', p_audit_location_id,
                'physical_quantity', p_physical_quantity,
                'scanned_code', v_scanned,
                'identification_method', v_method,
                'captured_at', v_captured_at,
                'revision_number', v_revision,
                'event_id', v_event_id,
                'product_pending_locations', v_total_locs - v_counted_locs,
                'product_counted_locations', v_counted_locs
            )
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.record_inventory_audit_result(uuid, uuid, uuid, uuid, text, numeric, timestamptz, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.record_inventory_audit_result(uuid, uuid, uuid, uuid, text, numeric, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.record_inventory_audit_result(uuid, uuid, uuid, uuid, text, numeric, timestamptz, uuid, text) TO authenticated;

-- ============================================================
-- 3. RPC READ-ONLY: PREVALIDAR BARCODE DE AUDITORIA (para Mobile)
--    Valida el contexto (auditoria de la empresa, auditor asignado, producto de la
--    auditoria, estado ejecutable) y resuelve el barcode con el MISMO helper que
--    record_inventory_audit_result. NO registra nada ni modifica estado.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.validate_inventory_audit_barcode(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_product_id uuid,
    p_scanned_code text
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_scanned text;
    v_audit_status text;
    v_assigned_user_id uuid;
    v_campaign_id uuid;
    v_scope_status text;
    v_variant integer;
    v_sku text;
    v_name text;
    v_barcode text;
    v_resolution jsonb;
    v_resolved_variant integer;
    v_resolved_count integer;
    v_method text;
BEGIN
    v_scanned := pg_catalog.btrim(coalesce(p_scanned_code, ''));
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_audit_product_id IS NULL
       OR v_scanned = '' OR pg_catalog.char_length(v_scanned) > 100 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    PERFORM inventarios.require_company_access(p_company_id);

    -- Auditoria de la empresa, asignada al actor y en estado ejecutable (IN_PROGRESS).
    SELECT a.status, a.assigned_user_id, a.campaign_id
    INTO v_audit_status, v_assigned_user_id, v_campaign_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;
    IF v_assigned_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está asignada a este usuario.','retryable',false)::text;
    END IF;
    IF v_audit_status = 'ASSIGNED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_STARTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Inicia la auditoría antes de validar códigos.','retryable',false)::text;
    END IF;
    IF v_audit_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está en ejecución.','retryable',false,'status',v_audit_status)::text;
    END IF;

    -- Producto perteneciente a la auditoria y con ubicaciones concretas (este bloque).
    SELECT ap.scope_status, ap.bsale_variant_id, ap.sku, ap.name, ap.barcode
    INTO v_scope_status, v_variant, v_sku, v_name, v_barcode
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id AND ap.id = p_audit_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no pertenece a la auditoría.','retryable',false)::text;
    END IF;
    IF v_scope_status <> 'LOCATIONS_RESOLVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_SCOPE_UNSUPPORTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Este producto sin ubicación previa aún no admite registro por ubicación.','retryable',false)::text;
    END IF;

    -- Resolucion del barcode: MISMA semantica contractual que record_inventory_audit_result.
    v_resolution := inventarios.resolve_audit_barcode(p_company_id, v_campaign_id, v_scanned);
    v_resolved_count := (v_resolution ->> 'resolved_count')::int;
    v_resolved_variant := (v_resolution ->> 'resolved_variant')::int;
    v_method := v_resolution ->> 'method';

    IF v_resolved_count = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_BARCODE_UNRECOGNIZED',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras no está reconocido.','retryable',false,'audit_product_id',p_audit_product_id)::text;
    END IF;
    IF v_resolved_count > 1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_BARCODE_AMBIGUOUS',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras corresponde a más de un producto.','retryable',false)::text;
    END IF;
    IF v_resolved_variant IS DISTINCT FROM v_variant THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_WRONG_PRODUCT',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras pertenece a otro producto.','retryable',false,'expected_bsale_variant_id',v_variant,'scanned_bsale_variant_id',v_resolved_variant)::text;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'status', 'MATCHED',
        'identification_method', v_method,
        'scanned_code', v_scanned,
        'audit_id', p_audit_id,
        'company_id', p_company_id,
        'product', pg_catalog.jsonb_build_object(
            'audit_product_id', p_audit_product_id,
            'bsale_variant_id', v_variant,
            'sku', v_sku,
            'name', v_name,
            'barcode', v_barcode
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.validate_inventory_audit_barcode(uuid, uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.validate_inventory_audit_barcode(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.validate_inventory_audit_barcode(uuid, uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION inventarios.validate_inventory_audit_barcode(uuid, uuid, uuid, text) IS
    'Prevalidacion read-only de barcode para auditoria: MATCHED si el codigo pertenece al producto auditado. No registra ni modifica nada.';

COMMIT;
