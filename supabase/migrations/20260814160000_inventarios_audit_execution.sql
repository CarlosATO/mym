-- =========================================================================================
-- MIGRATION: M1.5G - Ejecucion de auditoria (LOCATIONS_RESOLVED)
-- =========================================================================================
-- Objetivo:
--   Permitir que el auditor asignado ejecute una auditoria con productos
--   scope_status = 'LOCATIONS_RESOLVED':
--     ASSIGNED -> IN_PROGRESS (inicio trazado) -> registro por ubicacion -> SUBMITTED.
--   El resultado auditado se persiste SEPARADO del conteo efectivo del Inventario:
--   NINGUN RPC de este bloque escribe en count_entries / official_version_items ni
--   altera get_effective_count_entries / get_effective_task_contributions.
--
-- Resolucion de barcode:
--   Se reutiliza la MISMA fuente de verdad del conteo Mobile normal:
--     * integraciones.bsale_variants.bar_code  (barcode principal, state=0)
--     * inventarios.inventory_campaign_snapshot_products.barcode (catalogo congelado)
--     * inventarios.product_barcode_aliases    (alias autorizado aprobado)
--   El codigo escaneado debe resolver al producto asignado a la auditoria. Si resuelve a
--   otro producto se rechaza (INV_AUDIT_WRONG_PRODUCT). Si no resuelve a nada, se rechaza
--   con INV_AUDIT_BARCODE_UNRECOGNIZED: el flujo de incidencia/manual del conteo normal
--   (product_barcode_proposals) esta acoplado por FK a count_entries, por lo que NO puede
--   reutilizarse sin contaminar el conteo efectivo. Este bloque NO crea un sistema paralelo
--   de propuestas (bloqueo documentado; ver comentarios).
--
-- NO se implementa aun: ejecucion de NO_PREVIOUS_LOCATION, aprobacion/rechazo administrativo,
-- reemplazo del conteo efectivo ni segunda ronda.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

-- ============================================================
-- 1. INVENTORY_AUDITS: trazabilidad de inicio y envio
-- ============================================================
ALTER TABLE inventarios.inventory_audits
    ADD COLUMN started_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT;

ALTER TABLE inventarios.inventory_audits
    ADD COLUMN submitted_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT;

ALTER TABLE inventarios.inventory_audits
    ADD CONSTRAINT chk_inventarios_audits_started_by
    CHECK (started_at IS NULL OR started_by IS NOT NULL);

ALTER TABLE inventarios.inventory_audits
    ADD CONSTRAINT chk_inventarios_audits_submitted_by
    CHECK (submitted_at IS NULL OR (submitted_by IS NOT NULL AND status = 'SUBMITTED'));

-- ============================================================
-- 2. MODELO: RESULTADOS DE AUDITORIA (separados del conteo efectivo)
-- ============================================================

-- 2.1 Resultado vigente por (producto auditado, ubicacion).
--     Ultima captura valida gana: UPSERT sobre esta fila; nunca se suman capturas.
CREATE TABLE inventarios.inventory_audit_results (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    audit_location_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    location_id uuid REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    location_code text,
    location_name text,
    scanned_code text NOT NULL,
    identification_method text NOT NULL,
    physical_quantity numeric(14,3) NOT NULL,
    audited_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    captured_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    revision_number integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_results_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_results_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_results_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_results_location
        FOREIGN KEY (audit_location_id)
        REFERENCES inventarios.inventory_audit_locations(id)
        ON DELETE CASCADE,
    CONSTRAINT uq_inventarios_audit_results_product_location
        UNIQUE (company_id, audit_product_id, audit_location_id),
    CONSTRAINT chk_inventarios_audit_results_method
        CHECK (identification_method IN ('BARCODE','ALIAS')),
    CONSTRAINT chk_inventarios_audit_results_quantity
        CHECK (physical_quantity >= 0)
);

COMMENT ON TABLE inventarios.inventory_audit_results IS
    'Resultado vigente de auditoria por producto+ubicacion. Ultima captura valida gana (no se suman). SEPARADO del conteo efectivo del Inventario.';

CREATE INDEX idx_inventarios_audit_results_audit
    ON inventarios.inventory_audit_results (audit_id);

CREATE INDEX idx_inventarios_audit_results_product
    ON inventarios.inventory_audit_results (audit_product_id);

ALTER TABLE inventarios.inventory_audit_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_results FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_results TO service_role;

-- 2.2 Historial append-only de capturas (trazabilidad de revisiones por producto+ubicacion).
CREATE TABLE inventarios.inventory_audit_result_events (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    audit_location_id uuid NOT NULL,
    revision_number integer NOT NULL,
    previous_quantity numeric(14,3),
    physical_quantity numeric(14,3) NOT NULL,
    scanned_code text,
    identification_method text,
    audited_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    captured_at timestamptz NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    idempotency_key uuid NOT NULL,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_result_events_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_result_events_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_result_events_location
        FOREIGN KEY (audit_location_id)
        REFERENCES inventarios.inventory_audit_locations(id)
        ON DELETE CASCADE,
    CONSTRAINT uq_inventarios_audit_result_events_key
        UNIQUE (company_id, idempotency_key),
    CONSTRAINT chk_inventarios_audit_result_events_quantity
        CHECK (physical_quantity >= 0)
);

COMMENT ON TABLE inventarios.inventory_audit_result_events IS
    'Historial append-only de cada captura de resultado de auditoria (trazabilidad de revisiones). Nunca modifica el conteo efectivo.';

CREATE INDEX idx_inventarios_audit_result_events_product_location
    ON inventarios.inventory_audit_result_events (audit_product_id, audit_location_id, revision_number);

ALTER TABLE inventarios.inventory_audit_result_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_result_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_result_events TO service_role;

-- ============================================================
-- 3. RPC: INICIAR AUDITORIA (ASSIGNED -> IN_PROGRESS)
--    Solo el auditor asignado. Idempotente: si ya esta IN_PROGRESS, no-op seguro.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.start_inventory_audit(
    p_company_id uuid,
    p_audit_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_status text;
    v_assigned_user_id uuid;
    v_occurred_at timestamptz;
    v_already_started boolean := false;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    PERFORM inventarios.require_company_access(p_company_id);
    v_occurred_at := pg_catalog.now();

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.start_inventory_audit'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_audit_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.audit.start','company_id',p_company_id,'audit_id',p_audit_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.audit.start',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT a.status, a.assigned_user_id
    INTO v_status, v_assigned_user_id
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

    IF v_status = 'IN_PROGRESS' THEN
        v_already_started := true;
    ELSIF v_status = 'ASSIGNED' THEN
        UPDATE inventarios.inventory_audits
        SET status = 'IN_PROGRESS',
            started_at = v_occurred_at,
            started_by = v_actor_id
        WHERE company_id = p_company_id AND id = p_audit_id;
        UPDATE inventarios.inventory_audit_products
        SET status = 'IN_PROGRESS'
        WHERE company_id = p_company_id AND audit_id = p_audit_id AND status = 'ASSIGNED';
    ELSE
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está en un estado que permita iniciarla.','retryable',false,'status',v_status)::text;
    END IF;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        p_audit_id,
        pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.start',
            'entity_id', p_audit_id,
            'state','IN_PROGRESS',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'audit_id', p_audit_id,
                'status','IN_PROGRESS',
                'already_started', v_already_started,
                'started_at', v_occurred_at,
                'started_by', v_actor_id
            )
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.start_inventory_audit(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.start_inventory_audit(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.start_inventory_audit(uuid, uuid, uuid) TO authenticated;

-- ============================================================
-- 4. RPC: REGISTRAR RESULTADO DE AUDITORIA (captura por ubicacion)
--    Solo el auditor asignado. Producto LOCATIONS_RESOLVED y ubicacion incluida en su
--    alcance. Valida barcode (principal / alias autorizado) contra el producto asignado.
--    Ultima captura valida gana; se persiste en inventory_audit_results (UPSERT) y se
--    registra el historial en inventory_audit_result_events. NUNCA toca el conteo efectivo.
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

    -- Resolucion del barcode escaneado: misma fuente de verdad del conteo Mobile.
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
         AND cs.campaign_id = v_campaign_id
        WHERE csp.company_id = p_company_id AND csp.barcode = v_scanned
    )
    SELECT pg_catalog.count(DISTINCT resolved_variant), pg_catalog.min(resolved_variant)
    INTO v_resolved_count, v_resolved_variant
    FROM code_match;

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
    v_method := 'BARCODE';
    IF EXISTS (
        SELECT 1 FROM inventarios.product_barcode_aliases al
        WHERE al.company_id = p_company_id AND al.is_active = true AND al.barcode = v_scanned
    ) THEN
        v_method := 'ALIAS';
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
-- 5. RPC: PROGRESO DE AUDITORIA PARA MOBILE (contrato ciego)
--    Solo el auditor asignado. No revela teorico, conteo anterior ni diferencia.
--    Puede exponer la cantidad que el propio auditor acaba de registrar.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.list_my_inventory_audit_progress(
    p_company_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_status text;
    v_assigned_user_id uuid;
    v_audit_number integer;
    v_campaign_id uuid;
    v_campaign_name text;
    v_products jsonb;
    v_pending bigint;
    v_counted bigint;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();

    SELECT a.status, a.assigned_user_id, a.audit_number, a.campaign_id, ic.name
    INTO v_status, v_assigned_user_id, v_audit_number, v_campaign_id, v_campaign_name
    FROM inventarios.inventory_audits a
    JOIN inventarios.inventory_campaigns ic ON ic.company_id = a.company_id AND ic.id = a.campaign_id
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;
    IF v_assigned_user_id IS DISTINCT FROM v_actor_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_NOT_ASSIGNED',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está asignada a este usuario.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', ap.id,
                'bsale_variant_id', ap.bsale_variant_id,
                'sku', ap.sku,
                'name', ap.name,
                'barcode', ap.barcode,
                'scope_status', ap.scope_status,
                'pending_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_locations l2 WHERE l2.company_id = ap.company_id AND l2.audit_id = ap.audit_id AND l2.audit_product_id = ap.id
                                  AND NOT EXISTS (SELECT 1 FROM inventarios.inventory_audit_results r2 WHERE r2.company_id = ap.company_id AND r2.audit_product_id = ap.id AND r2.audit_location_id = l2.id)),
                'counted_count', (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_results r2 WHERE r2.company_id = ap.company_id AND r2.audit_id = ap.audit_id AND r2.audit_product_id = ap.id),
                'locations', (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                ELSE pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_build_object(
                                        'audit_location_id', l.id,
                                        'location_code', l.location_code,
                                        'location_name', l.location_name,
                                        'status', CASE WHEN r.id IS NULL THEN 'PENDING' ELSE 'COUNTED' END,
                                        'physical_quantity', r.physical_quantity,
                                        'captured_at', r.captured_at
                                    ) ORDER BY l.location_code
                                )
                              END
                              FROM inventarios.inventory_audit_locations l
                              LEFT JOIN inventarios.inventory_audit_results r
                                ON r.company_id = l.company_id AND r.audit_product_id = l.audit_product_id AND r.audit_location_id = l.id
                              WHERE l.company_id = ap.company_id AND l.audit_id = ap.audit_id AND l.audit_product_id = ap.id)
            ) ORDER BY ap.bsale_variant_id
        )
    END
    INTO v_products
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id
      AND ap.scope_status = 'LOCATIONS_RESOLVED';

    SELECT pg_catalog.count(*) FILTER (WHERE r.id IS NULL),
           pg_catalog.count(*) FILTER (WHERE r.id IS NOT NULL)
    INTO v_pending, v_counted
    FROM inventarios.inventory_audit_locations l
    LEFT JOIN inventarios.inventory_audit_results r
      ON r.company_id = l.company_id AND r.audit_product_id = l.audit_product_id AND r.audit_location_id = l.id
    WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
      AND EXISTS (SELECT 1 FROM inventarios.inventory_audit_products ap2
                  WHERE ap2.company_id = l.company_id AND ap2.id = l.audit_product_id
                    AND ap2.scope_status = 'LOCATIONS_RESOLVED');

    RETURN pg_catalog.jsonb_build_object(
        'audit_id', p_audit_id,
        'audit_number', v_audit_number,
        'status', v_status,
        'campaign_id', v_campaign_id,
        'campaign_name', v_campaign_name,
        'pending_locations', v_pending,
        'counted_locations', v_counted,
        'products', coalesce(v_products, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventory_audit_progress(uuid, uuid) TO authenticated;

-- ============================================================
-- 6. RPC: ENVIAR AUDITORIA (IN_PROGRESS -> SUBMITTED)
--    Exige todas las ubicaciones requeridas registradas (productos LOCATIONS_RESOLVED).
--    Congela el resultado y registra submitted_at/by. No altera el conteo efectivo.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.submit_inventory_audit(
    p_company_id uuid,
    p_audit_id uuid,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_status text;
    v_assigned_user_id uuid;
    v_missing bigint;
    v_occurred_at timestamptz;
    v_already_submitted boolean := false;
    v_totals jsonb;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_actor();
    PERFORM inventarios.require_company_access(p_company_id);
    v_occurred_at := pg_catalog.now();

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.submit_inventory_audit'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_audit_id::text));
    v_payload := pg_catalog.jsonb_build_object('operation','inventarios.audit.submit','company_id',p_company_id,'audit_id',p_audit_id);
    v_operation := inventarios.begin_idempotent_operation(p_company_id,'inventarios.audit.submit',p_idempotency_key,inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT a.status, a.assigned_user_id
    INTO v_status, v_assigned_user_id
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

    IF v_status = 'SUBMITTED' THEN
        v_already_submitted := true;
    ELSIF v_status = 'IN_PROGRESS' THEN
        -- Completa: toda ubicacion requerida de productos LOCATIONS_RESOLVED debe estar registrada.
        SELECT pg_catalog.count(*)
        INTO v_missing
        FROM inventarios.inventory_audit_locations l
        JOIN inventarios.inventory_audit_products ap
          ON ap.company_id = l.company_id AND ap.id = l.audit_product_id
        WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
          AND ap.scope_status = 'LOCATIONS_RESOLVED'
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.inventory_audit_results r
              WHERE r.company_id = l.company_id
                AND r.audit_product_id = l.audit_product_id
                AND r.audit_location_id = l.id
          );
        IF v_missing > 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_SUBMIT_INCOMPLETE',
                DETAIL=pg_catalog.jsonb_build_object('message','Faltan ubicaciones por registrar para poder enviar la auditoría.','retryable',false,'missing_locations',v_missing)::text;
        END IF;

        UPDATE inventarios.inventory_audits
        SET status = 'SUBMITTED',
            submitted_at = v_occurred_at,
            submitted_by = v_actor_id
        WHERE company_id = p_company_id AND id = p_audit_id;

        UPDATE inventarios.inventory_audit_products
        SET status = 'SUBMITTED'
        WHERE company_id = p_company_id AND audit_id = p_audit_id
          AND status IN ('ASSIGNED','IN_PROGRESS');
    ELSE
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no está en un estado que permita enviarla.','retryable',false,'status',v_status)::text;
    END IF;

    -- Reconstruccion de totales para el ERP (Producto -> ubicaciones -> total).
    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', p.id,
                'bsale_variant_id', p.bsale_variant_id,
                'sku', p.sku,
                'name', p.name,
                'total_audited', coalesce((SELECT pg_catalog.sum(r.physical_quantity) FROM inventarios.inventory_audit_results r WHERE r.company_id = p.company_id AND r.audit_product_id = p.id), 0),
                'locations', (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                ELSE pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_build_object(
                                        'audit_location_id', r.audit_location_id,
                                        'location_code', r.location_code,
                                        'location_name', r.location_name,
                                        'physical_quantity', r.physical_quantity,
                                        'scanned_code', r.scanned_code,
                                        'captured_at', r.captured_at
                                    ) ORDER BY r.location_code
                                )
                              END
                              FROM inventarios.inventory_audit_results r
                              WHERE r.company_id = p.company_id AND r.audit_product_id = p.id)
            ) ORDER BY p.bsale_variant_id
        )
    END
    INTO v_totals
    FROM inventarios.inventory_audit_products p
    WHERE p.company_id = p_company_id AND p.audit_id = p_audit_id;

    RETURN inventarios.complete_idempotent_operation(
        p_company_id,
        v_operation_id,
        p_audit_id,
        pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.submit',
            'entity_id', p_audit_id,
            'state','SUBMITTED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', NULL::uuid,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'audit_id', p_audit_id,
                'status','SUBMITTED',
                'already_submitted', v_already_submitted,
                'submitted_at', v_occurred_at,
                'submitted_by', v_actor_id,
                'products', coalesce(v_totals, '[]'::jsonb)
            )
        )
    );
END;
$function$;

ALTER FUNCTION inventarios.submit_inventory_audit(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.submit_inventory_audit(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.submit_inventory_audit(uuid, uuid, uuid) TO authenticated;

-- ============================================================
-- 7. RPC: RECONSTRUCCION DE RESULTADOS PARA ERP (lectura administrativa)
--    Producto auditado -> cantidades por ubicacion -> total auditado.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_inventory_audit_results(
    p_company_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audit jsonb;
    v_products jsonb;
    v_total numeric;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT pg_catalog.jsonb_build_object(
        'audit_id', a.id,
        'audit_number', a.audit_number,
        'campaign_id', a.campaign_id,
        'status', a.status,
        'submitted_at', a.submitted_at,
        'submitted_by', a.submitted_by
    )
    INTO v_audit
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF v_audit IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_product_id', p.id,
                'bsale_variant_id', p.bsale_variant_id,
                'sku', p.sku,
                'name', p.name,
                'scope_status', p.scope_status,
                'total_audited', coalesce((SELECT pg_catalog.sum(r.physical_quantity) FROM inventarios.inventory_audit_results r WHERE r.company_id = p.company_id AND r.audit_product_id = p.id), 0),
                'locations', (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                ELSE pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_build_object(
                                        'audit_location_id', r.audit_location_id,
                                        'location_code', r.location_code,
                                        'location_name', r.location_name,
                                        'physical_quantity', r.physical_quantity,
                                        'scanned_code', r.scanned_code,
                                        'identification_method', r.identification_method,
                                        'captured_at', r.captured_at,
                                        'revision_number', r.revision_number
                                    ) ORDER BY r.location_code
                                )
                              END
                              FROM inventarios.inventory_audit_results r
                              WHERE r.company_id = p.company_id AND r.audit_product_id = p.id)
            ) ORDER BY p.bsale_variant_id
        )
    END
    INTO v_products
    FROM inventarios.inventory_audit_products p
    WHERE p.company_id = p_company_id AND p.audit_id = p_audit_id;

    SELECT coalesce(pg_catalog.sum(r.physical_quantity), 0)
    INTO v_total
    FROM inventarios.inventory_audit_results r
    WHERE r.company_id = p_company_id AND r.audit_id = p_audit_id;

    RETURN pg_catalog.jsonb_build_object(
        'audit', v_audit,
        'total_audited', v_total,
        'products', coalesce(v_products, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.get_inventory_audit_results(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_inventory_audit_results(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_audit_results(uuid, uuid) TO authenticated;

COMMIT;
