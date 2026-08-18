-- Corrección forward (V4) del approve de códigos — Fix P0 evidence context.
--
-- Problema: approve_inventory_barcode ejecutaba
--   UPDATE evidence_files SET proposal_id = pbp.id ...
-- sobre evidencias Mobile que ya usan count_entry_id, dejando
--   count_entry_id NOT NULL AND proposal_id NOT NULL
-- lo que viola chk_inventarios_evidence_context
--   CHECK (num_nonnulls(incident_id, task_id, count_entry_id, recount_request_id, proposal_id) = 1)
--
-- Decisión contractual: NO se mueve la evidencia entre contextos. La evidencia
-- conserva count_entry_id; la relación proposal→evidence se obtiene vía
--   proposal.count_entry_id = evidence.count_entry_id
-- con proposal_id directo solo para evidencias que hayan nacido así.
--
-- approve ahora modifica únicamente: alias barcode→producto, proposals
-- compatibles, reviewed metadata, idempotencia. NO toca evidence_files,
-- count_entries, physical_quantity ni official_versions.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.approve_inventory_barcode(
    p_company_id uuid,
    p_campaign_id uuid,
    p_scanned_code text,
    p_bsale_variant_id integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
    v_is_super boolean := false;
    v_is_campaign_admin boolean := false;
    v_barcode text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_existing_alias uuid;
    v_other_product jsonb;
    v_alias_id uuid;
    v_proposals_updated bigint := 0;
    v_response jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL OR p_scanned_code IS NULL
       OR p_bsale_variant_id IS NULL OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_barcode := pg_catalog.btrim(p_scanned_code);
    IF v_barcode = '' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El código de barras no es válido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_company_access(p_company_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.barcode_decision'),
        pg_catalog.hashtext(p_company_id::text || ':' || v_barcode));

    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.approve','company_id',p_company_id,
        'campaign_id',p_campaign_id,'scanned_code',v_barcode,'bsale_variant_id',p_bsale_variant_id);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.barcode.approve',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    SELECT r.name INTO v_role_name
    FROM portal.users u JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    v_is_super := coalesce(v_role_name = 'SUPER_USUARIO', false);

    SELECT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now() AND icp.revoked_at IS NULL
    ) INTO v_is_campaign_admin;
    IF NOT (v_is_super OR v_is_campaign_admin) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
            DETAIL=pg_catalog.jsonb_build_object('message','No tienes permisos para autorizar códigos.','retryable',false)::text;
    END IF;

    -- Bloqueador duro: barcode asociado a otro producto
    v_other_product := inventarios._barcode_official_other_product(p_company_id, v_barcode, p_bsale_variant_id);
    IF (v_other_product ->> 'found')::boolean = true THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_BARCODE_ALREADY_ASSOCIATED',
            DETAIL=pg_catalog.jsonb_build_object(
                'message','El código de barras ya está asociado a otro producto.',
                'barcode',v_barcode,
                'current_sku',v_other_product ->> 'sku',
                'current_product_name',v_other_product ->> 'product_name',
                'retryable',false)::text;
    END IF;

    -- Alias existente del MISMO producto: idempotente
    SELECT pba.id INTO v_existing_alias
    FROM inventarios.product_barcode_aliases pba
    WHERE pba.company_id = p_company_id AND pba.barcode = v_barcode AND pba.is_active = true
      AND pba.bsale_variant_id = p_bsale_variant_id
    LIMIT 1;

    IF v_existing_alias IS NULL THEN
        INSERT INTO inventarios.product_barcode_aliases (
            company_id, barcode, bsale_variant_id, product_id, source, is_active,
            created_at, created_by, reviewed_at, reviewed_by
        )
        VALUES (
            p_company_id, v_barcode, p_bsale_variant_id,
            (
                SELECT coalesce(
                    (SELECT csp2.product_id FROM inventarios.inventory_campaign_snapshot_products csp2
                     WHERE csp2.company_id = p_company_id
                       AND csp2.bsale_variant_id = p_bsale_variant_id
                       AND csp2.campaign_snapshot_id = (
                           SELECT cs2.id FROM inventarios.inventory_campaign_snapshots cs2
                           WHERE cs2.company_id = p_company_id
                           ORDER BY cs2.created_at DESC LIMIT 1)
                     LIMIT 1),
                    (SELECT sp2.product_id FROM inventarios.snapshot_products sp2
                     WHERE sp2.bsale_variant_id = p_bsale_variant_id
                     ORDER BY sp2.sku NULLS LAST LIMIT 1)
                )
            ),
            'ADMIN_REVIEW', true, v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_alias_id;
    ELSE
        UPDATE inventarios.product_barcode_aliases
        SET reviewed_at = v_occurred_at, reviewed_by = v_actor_id
        WHERE id = v_existing_alias;
        v_alias_id := v_existing_alias;
    END IF;

    -- Resolver todas las proposals PENDING_REVIEW compatibles barcode+producto
    UPDATE inventarios.product_barcode_proposals pbp
    SET status = 'APPROVED',
        reviewed_at = v_occurred_at,
        reviewed_by = v_actor_id,
        review_notes = 'Autorizado en revisión de incidencias de códigos.',
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    FROM inventarios.count_entries ce
    JOIN inventarios.sessions s ON s.company_id = ce.company_id AND s.id = ce.session_id
    WHERE pbp.company_id = p_company_id
      AND pbp.count_entry_id = ce.id
      AND ce.bsale_variant_id = p_bsale_variant_id
      AND s.campaign_id = p_campaign_id
      AND pbp.status = 'PENDING_REVIEW'
      AND pbp.scanned_code = v_barcode;
    GET DIAGNOSTICS v_proposals_updated = ROW_COUNT;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.barcode.approve','entity_id',coalesce(v_alias_id, v_existing_alias),
        'state','APPROVED','version',NULL::integer,'cycle_number',NULL::integer,
        'assignment_id',NULL::uuid,'event_id',NULL::uuid,'replayed',false,
        'occurred_at',v_occurred_at,
        'data',pg_catalog.jsonb_build_object(
            'barcode',v_barcode,
            'bsale_variant_id',p_bsale_variant_id,
            'alias_id',v_alias_id,
            'association_created',(v_existing_alias IS NULL),
            'association_already_existed',(v_existing_alias IS NOT NULL),
            'proposals_resolved',v_proposals_updated
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, coalesce(v_alias_id, v_existing_alias), v_response);
END;
$function$;

GRANT EXECUTE ON FUNCTION inventarios.approve_inventory_barcode(uuid, uuid, text, integer, uuid) TO authenticated, service_role;

COMMIT;
