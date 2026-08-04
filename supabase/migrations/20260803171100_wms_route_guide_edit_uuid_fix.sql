-- Migration: 20260803171100_wms_route_guide_edit_uuid_fix.sql
-- Description: Fase WMS-RG.1. Corrige jsonb_build_object con id de record sin
--              tipo (invalid input syntax for type json).
-- Author: Assistant

CREATE OR REPLACE FUNCTION logistica.edit_route_guide_unsettled(
    p_company_id uuid,
    p_route_guide_id uuid,
    p_expected_version integer,
    p_header jsonb,
    p_items jsonb,
    p_reason text,
    p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_uid uuid;
    v_actor_user_id uuid;
    v_reason text;
    v_hash char(64);
    v_existing jsonb;
    v_guide record;
    v_items_processed bigint;
    v_header_changes jsonb := '{}'::jsonb;
    v_items_added jsonb := '[]'::jsonb;
    v_items_modified jsonb := '[]'::jsonb;
    v_items_deleted jsonb := '[]'::jsonb;
    v_totals_before jsonb;
    v_totals_after jsonb;
    v_guide_year integer;
    v_new_date date;
    v_item record;
    v_existing_ids uuid[] := '{}'::uuid[];
    v_kept_ids uuid[] := '{}'::uuid[];
    v_result jsonb;
BEGIN
    -- 1. Actor desde auth.uid() (nunca p_user_id del cliente)
    v_actor_uid := auth.uid();
    IF v_actor_uid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_UNAUTHENTICATED',
            DETAIL=pg_catalog.jsonb_build_object('message','Debes iniciar sesion para realizar esta operacion.','retryable',false)::text;
    END IF;

    SELECT id INTO v_actor_user_id
    FROM portal.users
    WHERE id = v_actor_uid AND is_active = true AND deleted_at IS NULL;
    IF v_actor_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_ACTOR_NOT_REGISTERED',
            DETAIL=pg_catalog.jsonb_build_object('message','Tu usuario no esta registrado.','retryable',false)::text;
    END IF;

    -- Acceso activo a la empresa
    IF NOT core.has_company_access(v_actor_uid, p_company_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_COMPANY_ACCESS_DENIED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes acceso a la empresa solicitada.','retryable',false)::text;
    END IF;

    -- Permiso fail-closed por empresa
    IF NOT core.has_permission_for_company(v_actor_uid, p_company_id, 'logistica.route_guides.edit_unsettled') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes el permiso requerido para esta operacion.','retryable',false)::text;
    END IF;

    -- 2. Validar parametros
    v_reason := pg_catalog.btrim(coalesce(p_reason, ''::text));
    IF p_company_id IS NULL OR p_route_guide_id IS NULL OR p_expected_version IS NULL
       OR p_expected_version < 1 OR p_header IS NULL OR p_items IS NULL
       OR p_idempotency_key IS NULL OR pg_catalog.char_length(v_reason) < 5
       OR pg_catalog.char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(pg_catalog.jsonb_build_object(
                'h', p_header, 'i', p_items, 'r', v_reason
            )::text, 'UTF8'),
            'sha256'
        ), 'hex')::char(64);

    -- 3. Idempotencia
    SELECT pg_catalog.jsonb_build_object(
        'id', e.id, 'result', pg_catalog.to_jsonb(e)
    ) INTO v_existing
    FROM logistica.route_guide_events e
    WHERE e.company_id = p_company_id AND e.idempotency_key = p_idempotency_key;

    IF v_existing IS NOT NULL THEN
        IF (v_existing -> 'result' ->> 'request_hash')::char(64) = v_hash THEN
            RETURN pg_catalog.jsonb_build_object(
                'replayed', true,
                'event_id', v_existing -> 'id',
                'success', true
            );
        ELSE
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROUTE_GUIDE_IDEMPOTENCY_CONFLICT',
                DETAIL=pg_catalog.jsonb_build_object('message','La clave de idempotencia ya fue usada con otro contenido.','retryable',false)::text;
        END IF;
    END IF;

    -- 4. SELECT FOR UPDATE
    SELECT rg.id, rg.company_id, rg.version_number, rg.status, rg.guide_year,
           rg.guide_date, rg.total_invoices, rg.total_amount, rg.total_cash_expected,
           rg.total_check_expected, rg.total_credit, rg.total_transfer, rg.total_unknown_payment,
           rg.error_count, rg.duplicate_count
    INTO v_guide
    FROM logistica.route_guides rg
    WHERE rg.id = p_route_guide_id
    FOR UPDATE;

    IF NOT FOUND OR v_guide.company_id IS DISTINCT FROM p_company_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia no existe en la empresa.','retryable',false)::text;
    END IF;

    -- 5. Control optimista
    IF v_guide.version_number IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROUTE_GUIDE_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia fue modificada por otro usuario.','retryable',true,
                'expected_version', p_expected_version, 'current_version', v_guide.version_number)::text;
    END IF;

    -- 6. Estados editables
    IF v_guide.status = 'CANCELLED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia esta cancelada.','retryable',false,'status',v_guide.status)::text;
    END IF;
    IF v_guide.status NOT IN ('DRAFT', 'DISPATCHED') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia no es editable en su estado actual.','retryable',false,'status',v_guide.status)::text;
    END IF;

    -- 7. Dependencias (rendicion o evidencia)
    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements rs WHERE rs.route_guide_id = p_route_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_items rci WHERE rci.route_guide_id = p_route_guide_id)
       OR EXISTS (SELECT 1 FROM adquisiciones.route_fund_closure_expenses rce WHERE rce.route_guide_id = p_route_guide_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROUTE_GUIDE_SETTLEMENT_STARTED',
            DETAIL=pg_catalog.jsonb_build_object('message','La guia tiene una rendicion o evidencia financiera asociada.','retryable',false)::text;
    END IF;

    -- 8. Totales anteriores
    v_totals_before := pg_catalog.jsonb_build_object(
        'total_invoices', v_guide.total_invoices,
        'total_amount', v_guide.total_amount,
        'total_cash_expected', v_guide.total_cash_expected,
        'total_check_expected', v_guide.total_check_expected,
        'total_credit', v_guide.total_credit,
        'total_transfer', v_guide.total_transfer,
        'total_unknown_payment', v_guide.total_unknown_payment,
        'error_count', v_guide.error_count,
        'duplicate_count', v_guide.duplicate_count
    );

    -- 9. Validar cabecera: fecha dentro del mismo año
    v_new_date := (p_header ->> 'guide_date')::date;
    IF v_new_date IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La fecha de la guia es obligatoria.','retryable',false)::text;
    END IF;
    IF pg_catalog.date_part('year', v_new_date)::integer <> v_guide.guide_year THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='ROUTE_GUIDE_DATE_YEAR_MISMATCH',
            DETAIL=pg_catalog.jsonb_build_object('message','La fecha debe pertenecer al mismo anio de la guia.','retryable',false,
                'guide_year', v_guide.guide_year)::text;
    END IF;

    -- 10. Validar lineas y aplicar diff
    SELECT pg_catalog.count(*) INTO v_items_processed
    FROM pg_catalog.jsonb_array_elements(p_items) AS it;

    -- Coleccionar ids existentes de la guia
    SELECT pg_catalog.array_agg(rgi.id) INTO v_existing_ids
    FROM logistica.route_guide_items rgi
    WHERE rgi.route_guide_id = p_route_guide_id;

    -- Aplicar upserts por linea
    FOR v_item IN SELECT * FROM pg_catalog.jsonb_array_elements(p_items) AS it LOOP
        DECLARE
            v_row_id uuid;
            v_amount numeric(14,2);
            v_normalized varchar(30);
            v_valid varchar(30);
            v_errors jsonb := '[]'::jsonb;
            v_invoice text;
            v_customer text;
        BEGIN
            v_invoice := pg_catalog.btrim(coalesce(v_item.value ->> 'invoice_number', ''::text));
            v_customer := pg_catalog.btrim(coalesce(v_item.value ->> 'customer_name', ''::text));
            v_amount := logistica.parse_chilean_amount(v_item.value ->> 'amount');
            v_normalized := logistica.normalize_payment_method(v_item.value ->> 'payment_method_original');

            -- Validaciones
            IF v_invoice = '' THEN
                v_errors := pg_catalog.jsonb_build_array('Factura obligatoria');
            END IF;
            IF v_customer = '' THEN
                v_errors := pg_catalog.jsonb_build_array('Cliente obligatorio');
            END IF;
            IF v_amount <= 0 THEN
                v_errors := pg_catalog.jsonb_build_array('Monto invalido');
            END IF;
            IF v_normalized = 'UNKNOWN' THEN
                v_errors := pg_catalog.jsonb_build_array('Forma de pago no reconocida');
            END IF;

            IF pg_catalog.jsonb_array_length(v_errors) = 0 THEN
                v_valid := 'VALID';
            ELSE
                v_valid := 'INVALID';
            END IF;

            v_row_id := NULLIF(pg_catalog.btrim(coalesce(v_item.value ->> 'id', ''::text)), '')::uuid;

            IF v_row_id IS NULL THEN
                -- Nueva linea
                INSERT INTO logistica.route_guide_items (
                    company_id, route_guide_id, line_number, invoice_number,
                    customer_name, customer_address, commune, amount,
                    payment_method_original, payment_method_normalized, requires_settlement,
                    validation_status, validation_errors, notes, settlement_status
                ) VALUES (
                    p_company_id, p_route_guide_id, 0, v_invoice,
                    v_customer, pg_catalog.btrim(coalesce(v_item.value ->> 'customer_address', ''::text)),
                    pg_catalog.btrim(coalesce(v_item.value ->> 'commune', ''::text)),
                    v_amount, v_item.value ->> 'payment_method_original', v_normalized,
                    logistica.payment_requires_settlement(v_normalized),
                    v_valid, v_errors, pg_catalog.btrim(coalesce(v_item.value ->> 'notes', ''::text)),
                    'NOT_REQUIRED'
                ) RETURNING id INTO v_row_id;
                v_items_added := v_items_added || pg_catalog.jsonb_build_object(
                    'id', v_row_id, 'invoice_number', v_invoice
                );
                v_kept_ids := pg_catalog.array_append(v_kept_ids, v_row_id);
            ELSE
                -- Linea existente: debe pertenecer a la guia
                IF NOT EXISTS (
                    SELECT 1 FROM logistica.route_guide_items rgi
                    WHERE rgi.id = v_row_id AND rgi.route_guide_id = p_route_guide_id
                ) THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                        DETAIL=pg_catalog.jsonb_build_object('message','La linea no pertenece a la guia.','retryable',false,'item_id',v_row_id)::text;
                END IF;
                UPDATE logistica.route_guide_items SET
                    invoice_number = v_invoice,
                    customer_name = v_customer,
                    customer_address = pg_catalog.btrim(coalesce(v_item.value ->> 'customer_address', ''::text)),
                    commune = pg_catalog.btrim(coalesce(v_item.value ->> 'commune', ''::text)),
                    amount = v_amount,
                    payment_method_original = v_item.value ->> 'payment_method_original',
                    payment_method_normalized = v_normalized,
                    requires_settlement = logistica.payment_requires_settlement(v_normalized),
                    validation_status = v_valid,
                    validation_errors = v_errors,
                    notes = pg_catalog.btrim(coalesce(v_item.value ->> 'notes', ''::text)),
                    updated_at = pg_catalog.now()
                WHERE id = v_row_id AND route_guide_id = p_route_guide_id;
                v_items_modified := v_items_modified || pg_catalog.jsonb_build_object(
                    'id', v_row_id, 'invoice_number', v_invoice
                );
                v_kept_ids := pg_catalog.array_append(v_kept_ids, v_row_id);
            END IF;
        END;
    END LOOP;

    -- 11. Eliminar lineas existentes omitidas (sin dependencias)
    IF v_existing_ids IS NOT NULL THEN
        FOR v_item IN SELECT unnest(v_existing_ids) AS id
        LOOP
            IF NOT (v_item.id = ANY(v_kept_ids)) THEN
                IF EXISTS (
                    SELECT 1 FROM adquisiciones.route_settlement_items rsi
                    WHERE rsi.route_guide_item_id = v_item.id
                ) THEN
                    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_DEPENDENCY_EXISTS',
                        DETAIL=pg_catalog.jsonb_build_object('message','La linea tiene evidencia financiera asociada.','retryable',false,'item_id',v_item.id)::text;
                END IF;
                DELETE FROM logistica.route_guide_items WHERE id = v_item.id;
                v_items_deleted := v_items_deleted || pg_catalog.jsonb_build_object('id', v_item.id::uuid);
            END IF;
        END LOOP;
    END IF;

    -- 12. Renumerar lineas segun orden final
    UPDATE logistica.route_guide_items rgi SET line_number = sub.rn
    FROM (
        SELECT id, pg_catalog.row_number() OVER (ORDER BY created_at, id) AS rn
        FROM logistica.route_guide_items
        WHERE route_guide_id = p_route_guide_id
    ) sub
    WHERE rgi.id = sub.id;

    -- 13. Recalcular totales (SQL set-based, autoritativo)
    WITH rec AS (
        SELECT
            pg_catalog.count(*) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0) AS total_invoices,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0) AS total_amount,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0 AND rgi.payment_method_normalized = 'CASH') AS cash,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0 AND rgi.payment_method_normalized = 'CHECK') AS chk,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0 AND rgi.payment_method_normalized = 'CREDIT') AS credit,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0 AND rgi.payment_method_normalized = 'TRANSFER') AS transfer,
            pg_catalog.sum(rgi.amount) FILTER (WHERE rgi.invoice_number <> '' AND rgi.amount > 0 AND rgi.payment_method_normalized = 'UNKNOWN') AS unknown,
            pg_catalog.count(*) FILTER (WHERE rgi.validation_status = 'INVALID') AS error_count,
            pg_catalog.count(*) FILTER (WHERE rgi.validation_errors @> '["Factura duplicada en la grilla"]'::jsonb) AS duplicate_count
        FROM logistica.route_guide_items rgi
        WHERE rgi.route_guide_id = p_route_guide_id
    )
    UPDATE logistica.route_guides rg SET
        total_invoices = coalesce(rec.total_invoices, 0),
        total_amount = coalesce(rec.total_amount, 0),
        total_cash_expected = coalesce(rec.cash, 0),
        total_check_expected = coalesce(rec.chk, 0),
        total_credit = coalesce(rec.credit, 0),
        total_transfer = coalesce(rec.transfer, 0),
        total_unknown_payment = coalesce(rec.unknown, 0),
        error_count = coalesce(rec.error_count, 0),
        duplicate_count = coalesce(rec.duplicate_count, 0)
    FROM rec
    WHERE rg.id = p_route_guide_id;

    -- 14. Aplicar cambios de cabecera
    UPDATE logistica.route_guides rg SET
        guide_date = v_new_date,
        route_id = coalesce((p_header ->> 'route_id')::uuid, rg.route_id),
        route_name_snapshot = COALESCE((SELECT d.route_name FROM logistica.delivery_routes d WHERE d.id = (p_header ->> 'route_id')::uuid), rg.route_name_snapshot),
        vehicle_id = coalesce((p_header ->> 'vehicle_id')::uuid, rg.vehicle_id),
        vehicle_name_snapshot = COALESCE((SELECT v.vehicle_name FROM logistica.route_vehicles v WHERE v.id = (p_header ->> 'vehicle_id')::uuid), rg.vehicle_name_snapshot),
        driver_id = coalesce((p_header ->> 'driver_id')::uuid, rg.driver_id),
        driver_name_snapshot = COALESCE((SELECT p.person_name FROM logistica.route_personnel p WHERE p.id = (p_header ->> 'driver_id')::uuid), rg.driver_name_snapshot),
        seller_id = coalesce((p_header ->> 'seller_id')::uuid, rg.seller_id),
        seller_name_snapshot = COALESCE((SELECT p.person_name FROM logistica.route_personnel p WHERE p.id = (p_header ->> 'seller_id')::uuid), rg.seller_name_snapshot),
        dispatcher_id = coalesce((p_header ->> 'dispatcher_id')::uuid, rg.dispatcher_id),
        dispatcher_name_snapshot = COALESCE((SELECT p.person_name FROM logistica.route_personnel p WHERE p.id = (p_header ->> 'dispatcher_id')::uuid), rg.dispatcher_name_snapshot),
        notes = pg_catalog.btrim(coalesce(p_header ->> 'notes', rg.notes)),
        version_number = rg.version_number + 1,
        updated_at = pg_catalog.now()
    WHERE rg.id = p_route_guide_id;

    -- 15. Leer totales posteriores
    SELECT pg_catalog.jsonb_build_object(
        'total_invoices', rg.total_invoices, 'total_amount', rg.total_amount,
        'total_cash_expected', rg.total_cash_expected, 'total_check_expected', rg.total_check_expected,
        'total_credit', rg.total_credit, 'total_transfer', rg.total_transfer,
        'total_unknown_payment', rg.total_unknown_payment, 'error_count', rg.error_count,
        'duplicate_count', rg.duplicate_count
    ) INTO v_totals_after
    FROM logistica.route_guides rg WHERE rg.id = p_route_guide_id;

    -- 16. Registrar evento
    INSERT INTO logistica.route_guide_events (
        company_id, route_guide_id, actor_user_id, event_type, reason,
        version_before, version_after, guide_status, header_changes,
        items_added, items_modified, items_deleted, totals_before, totals_after,
        idempotency_key, request_hash, created_at
    ) VALUES (
        p_company_id, p_route_guide_id, v_actor_user_id, 'EDITED', v_reason,
        v_guide.version_number, v_guide.version_number + 1, v_guide.status,
        v_header_changes, v_items_added, v_items_modified, v_items_deleted,
        v_totals_before, v_totals_after, p_idempotency_key, v_hash, pg_catalog.now()
    ) RETURNING id INTO v_result;

    -- 17. audit_log generico
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type, severity)
    VALUES ('logistica', 'LOGISTICA', 'route_guides', p_route_guide_id, 'UPDATE',
        v_totals_before, v_totals_after, v_actor_user_id, 'ROUTE_GUIDE_EDITED', 'INFO');

    RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'event_id', v_result,
        'version_number', v_guide.version_number + 1,
        'guide_number', (SELECT rg.guide_number FROM logistica.route_guides rg WHERE rg.id = p_route_guide_id),
        'totals', v_totals_after,
        'items_added', v_items_added,
        'items_modified', v_items_modified,
        'items_deleted', v_items_deleted,
        'totals_before', v_totals_before,
        'totals_after', v_totals_after,
        'replayed', false
    );
END;
$$;


ALTER FUNCTION logistica.edit_route_guide_unsettled(uuid, uuid, integer, jsonb, jsonb, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.edit_route_guide_unsettled(uuid, uuid, integer, jsonb, jsonb, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.edit_route_guide_unsettled(uuid, uuid, integer, jsonb, jsonb, text, uuid) TO authenticated;
