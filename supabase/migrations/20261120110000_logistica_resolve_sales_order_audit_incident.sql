-- Bloque 3B.1: Resolución transaccional de incidencias físicas OPEN en Auditoría.
-- Permite pasar una incidencia OPEN -> RESOLVED sin devolver innecesariamente la
-- tarjeta a Preparación, conservando cantidades originales, fotografías e historial.
-- No acepta cambios comerciales ni finaliza la Auditoría automáticamente.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.resolve_sales_order_audit_incident(
    p_company_id uuid,
    p_card_id uuid,
    p_audit_id uuid,
    p_incident_id uuid,
    p_resolution_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public, auth, core, portal, integraciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_note text := NULLIF(btrim(p_resolution_note), '');
    v_audit_line_id uuid;
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_incident logistica.sales_order_audit_incidents%ROWTYPE;
    v_line logistica.sales_order_audit_lines%ROWTYPE;
    v_verification logistica.sales_order_audit_commercial_verifications%ROWTYPE;
    v_verification_id uuid := NULL;
    v_verified_bsale_nv_id bigint := NULL;
    v_canonical_current bigint;
    v_snapshot jsonb;
    v_current_version jsonb;
    v_bsale_doc_state integer;
    v_bsale_doc_found boolean := false;
    v_bsale_line_qty numeric := 0;
    v_line_product_key text;
    v_snapshot_diff_count integer := 0;
    v_resolved_at timestamptz := now();
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;
    IF v_note IS NULL THEN
        RAISE EXCEPTION 'La observación de resolución es obligatoria.';
    END IF;

    -- Lectura ligera sin lock para ubicar la línea y adquirir locks en el mismo orden
    -- exacto que confirm_sales_order_audit_line: Línea -> Auditoría -> Tarjeta -> Incidencia.
    -- Así se elimina cualquier riesgo de deadlock AB-BA entre ambas operaciones.
    SELECT i.audit_line_id INTO v_audit_line_id
    FROM logistica.sales_order_audit_incidents i
    WHERE i.id = p_incident_id
      AND i.company_id = p_company_id
      AND i.card_id = p_card_id
      AND i.audit_id = p_audit_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Incidencia de auditoría no encontrada.';
    END IF;

    -- 1. Lock Línea
    SELECT * INTO v_line
    FROM logistica.sales_order_audit_lines
    WHERE id = v_audit_line_id
      AND company_id = p_company_id
      AND audit_id = p_audit_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Línea de auditoría asociada a la incidencia no encontrada.';
    END IF;

    -- 2. Lock Auditoría
    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = p_audit_id
      AND company_id = p_company_id
      AND card_id = p_card_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada para la tarjeta indicada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;

    -- 3. Lock Tarjeta
    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id
      AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría para resolver incidencias.';
    END IF;
    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;
    IF v_audit.prepared_by_user_id_snapshot = v_actor AND NOT portal.is_super_usuario(v_actor) THEN
        RAISE EXCEPTION 'No puedes resolver incidencias de una auditoría de tu propia preparación.';
    END IF;
    IF v_audit.assigned_auditor_user_id IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Sólo el auditor asignado puede resolver incidencias de la Auditoría.';
    END IF;

    -- 4. Lock Incidencia (relectura bajo lock tras serializar con confirm_sales_order_audit_line)
    SELECT * INTO v_incident
    FROM logistica.sales_order_audit_incidents
    WHERE id = p_incident_id
      AND company_id = p_company_id
      AND card_id = p_card_id
      AND audit_id = p_audit_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Incidencia de auditoría no encontrada.';
    END IF;
    IF v_incident.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La incidencia ya no está abierta (estado actual: %).', v_incident.status;
    END IF;
    IF v_line.audit_quantity IS NULL THEN
        RAISE EXCEPTION 'La línea asociada a la incidencia no tiene cantidad auditada válida.';
    END IF;

    -- Evidencia fotográfica obligatoria para productos dañados o incorrectos.
    IF v_incident.incident_type IN ('WRONG_PRODUCT', 'DAMAGED_PRODUCT')
       AND NOT logistica.audit_incident_has_required_evidence(p_company_id, v_incident.id) THEN
        RAISE EXCEPTION 'Falta fotografía obligatoria de evidencia para resolver esta incidencia.';
    END IF;

    -- Cuando existe diferencia entre lo preparado y lo auditado, exigir conciliación
    -- comercial vigente y verificable (alcance 3B.1: reducciones positivas, p. ej. 5 -> 3).
    IF v_line.audit_quantity IS DISTINCT FROM v_line.prepared_quantity_snapshot THEN
        IF v_line.audit_quantity <= 0 THEN
            RAISE EXCEPTION 'La resolución con cantidad auditada 0 o línea eliminada no está habilitada en esta etapa; devuelve la tarjeta a Preparación.';
        END IF;
        IF v_line.audit_quantity > v_line.prepared_quantity_snapshot THEN
            RAISE EXCEPTION 'La resolución de sobrantes con aumento comercial no está habilitada en esta etapa; ajusta la cantidad física o devuelve la tarjeta a Preparación.';
        END IF;

        SELECT * INTO v_verification
        FROM logistica.sales_order_audit_commercial_verifications
        WHERE company_id = p_company_id
          AND card_id = p_card_id
          AND audit_id = p_audit_id
          AND is_current = true
        ORDER BY verified_at DESC
        LIMIT 1
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'No existe una verificación comercial vigente. Ejecuta «Sincronizar» antes de resolver la incidencia.';
        END IF;
        IF v_verification.status <> 'READY_TO_INVOICE' THEN
            RAISE EXCEPTION 'La verificación comercial vigente no está conforme (estado: %).', v_verification.status;
        END IF;
        IF v_verification.verified_at IS NULL
           OR NULLIF(btrim(v_verification.fingerprint), '') IS NULL
           OR v_verification.fingerprint !~ '^[0-9A-Fa-f]{64}$' THEN
            RAISE EXCEPTION 'La verificación comercial vigente no tiene snapshot o fingerprint válido.';
        END IF;
        IF jsonb_typeof(v_verification.snapshot) IS DISTINCT FROM 'object'
           OR jsonb_typeof(v_verification.differences) IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_verification.differences) <> 0 THEN
            RAISE EXCEPTION 'La verificación comercial vigente presenta diferencias o un snapshot inválido.';
        END IF;

        -- No confiar únicamente en is_current = true: validar vigencia temporal respecto a línea e incidencia.
        IF v_verification.verified_at < v_line.updated_at
           OR v_verification.verified_at < v_incident.updated_at THEN
            RAISE EXCEPTION 'La verificación comercial quedó obsoleta tras cambios en la auditoría. Vuelve a ejecutar «Sincronizar».';
        END IF;

        v_snapshot := v_verification.snapshot;
        v_current_version := v_snapshot->'currentVersion';
        IF v_snapshot->'identity'->>'companyId' IS DISTINCT FROM p_company_id::text
           OR v_snapshot->>'cardId' IS DISTINCT FROM p_card_id::text
           OR v_snapshot->>'auditId' IS DISTINCT FROM p_audit_id::text
           OR v_snapshot->>'status' IS DISTINCT FROM 'READY_TO_INVOICE'
           OR v_snapshot->'comparison'->>'status' IS DISTINCT FROM 'READY_TO_INVOICE'
           OR jsonb_typeof(v_snapshot->'comparison'->'differences') IS DISTINCT FROM 'array'
           OR jsonb_array_length(v_snapshot->'comparison'->'differences') <> 0
           OR jsonb_typeof(v_current_version) IS DISTINCT FROM 'object'
           OR v_current_version->>'physicalId' IS DISTINCT FROM v_verification.current_bsale_nv_id::text
           OR v_current_version->'identity'->>'canonicalToken' IS DISTINCT FROM v_verification.canonical_bsale_token
           OR v_current_version->'identity'->>'currentBsaleId' IS DISTINCT FROM v_verification.current_bsale_nv_id::text
           OR jsonb_typeof(v_snapshot->'auditedLines') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'La identidad o el snapshot de la verificación comercial no coincide con la auditoría.';
        END IF;

        IF v_verification.canonical_bsale_token IS NULL
           OR v_verification.current_bsale_nv_id IS NULL
           OR v_verification.canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token
           OR v_verification.current_bsale_nv_id IS DISTINCT FROM v_card.current_bsale_nv_id THEN
            RAISE EXCEPTION 'El documento Bsale verificado ya no coincide con la versión vigente de la tarjeta. Vuelve a ejecutar «Sincronizar».';
        END IF;

        SELECT current_bsale_id INTO v_canonical_current
        FROM integraciones.vw_bsale_sales_order_documents_canonical
        WHERE company_id = p_company_id
          AND canonical_bsale_token = v_card.canonical_bsale_token;

        IF v_canonical_current IS NULL
           OR v_canonical_current IS DISTINCT FROM v_verification.current_bsale_nv_id THEN
            RAISE EXCEPTION 'La verificación comercial quedó desactualizada frente al documento canónico de Bsale. Vuelve a ejecutar «Sincronizar».';
        END IF;

        -- Verificar que las líneas auditadas actuales coinciden exactamente con las del snapshot verificado.
        WITH snap_lines AS (
            SELECT
                (elem->>'bsale_detail_id')::bigint AS bsale_detail_id,
                (elem->>'audit_quantity')::numeric AS audit_quantity
            FROM jsonb_array_elements(v_snapshot->'auditedLines') AS elem
        ),
        curr_lines AS (
            SELECT
                al.bsale_detail_id,
                al.audit_quantity
            FROM logistica.sales_order_audit_lines al
            WHERE al.company_id = p_company_id
              AND al.audit_id = p_audit_id
        ),
        diffs AS (
            (SELECT bsale_detail_id, audit_quantity FROM snap_lines EXCEPT ALL SELECT bsale_detail_id, audit_quantity FROM curr_lines)
            UNION ALL
            (SELECT bsale_detail_id, audit_quantity FROM curr_lines EXCEPT ALL SELECT bsale_detail_id, audit_quantity FROM snap_lines)
        )
        SELECT count(*) INTO v_snapshot_diff_count FROM diffs;

        IF v_snapshot_diff_count > 0 THEN
            RAISE EXCEPTION 'Las cantidades auditadas actuales difieren del snapshot verificado. Vuelve a ejecutar «Sincronizar».';
        END IF;

        -- Verificar coherencia directa contra el espejo local vigente de Bsale (state = 0 y cantidad de la línea).
        SELECT d.state, true INTO v_bsale_doc_state, v_bsale_doc_found
        FROM integraciones.bsale_documents d
        WHERE d.company_id = p_company_id
          AND d.bsale_id = v_canonical_current
          AND d.document_type_id = 23
          AND d.number::text = v_card.bsale_nv_folio
          AND NULLIF(btrim(d.raw_json ->> 'token'), '') = v_card.canonical_bsale_token
        LIMIT 1;

        IF NOT COALESCE(v_bsale_doc_found, false) OR v_bsale_doc_state IS DISTINCT FROM 0 THEN
            RAISE EXCEPTION 'El documento vigente en el espejo Bsale no está activo o no coincide con la tarjeta.';
        END IF;

        v_line_product_key := CASE
            WHEN NULLIF(btrim(v_line.sku), '') IS NOT NULL THEN 'SKU:' || upper(btrim(v_line.sku))
            WHEN v_line.bsale_variant_id IS NOT NULL THEN 'VARIANT:' || v_line.bsale_variant_id::text
            ELSE NULL
        END;

        IF v_line_product_key IS NULL THEN
            RAISE EXCEPTION 'La línea auditada no tiene SKU ni variante identificable para conciliar con Bsale.';
        END IF;

        SELECT COALESCE(sum(det.quantity), 0) INTO v_bsale_line_qty
        FROM integraciones.bsale_document_details det
        WHERE det.company_id = p_company_id
          AND det.bsale_document_id = v_canonical_current
          AND (
              CASE
                  WHEN NULLIF(btrim(det.variant_code), '') IS NOT NULL THEN 'SKU:' || upper(btrim(det.variant_code))
                  WHEN det.variant_id IS NOT NULL THEN 'VARIANT:' || det.variant_id::text
                  ELSE NULL
              END
          ) = v_line_product_key;

        IF v_bsale_line_qty IS DISTINCT FROM v_line.audit_quantity THEN
            RAISE EXCEPTION 'La cantidad en Bsale (%) no coincide con la cantidad auditada (%). Vuelve a ejecutar «Sincronizar».', v_bsale_line_qty, v_line.audit_quantity;
        END IF;

        v_verification_id := v_verification.id;
        v_verified_bsale_nv_id := v_verification.current_bsale_nv_id;
    END IF;

    UPDATE logistica.sales_order_audit_incidents
       SET status = 'RESOLVED',
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'resolved_by', v_actor,
               'resolved_at', v_resolved_at,
               'resolution_note', v_note,
               'commercial_verification_id', v_verification_id,
               'commercial_bsale_nv_id', v_verified_bsale_nv_id,
               'resolved_audit_quantity', v_line.audit_quantity,
               'resolved_prepared_quantity_snapshot', v_line.prepared_quantity_snapshot
           ),
           updated_at = v_resolved_at
     WHERE id = v_incident.id
     RETURNING * INTO v_incident;

    RETURN jsonb_build_object(
        'incident_id', v_incident.id,
        'audit_id', v_audit.id,
        'card_id', v_card.id,
        'status', v_incident.status,
        'incident_type', v_incident.incident_type,
        'resolved_by', v_actor,
        'resolved_at', v_resolved_at,
        'resolution_note', v_note,
        'commercial_verification_id', v_verification_id,
        'commercial_bsale_nv_id', v_verified_bsale_nv_id
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.resolve_sales_order_audit_incident(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.resolve_sales_order_audit_incident(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMIT;
