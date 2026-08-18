-- Corrección forward (V5) — Código anterior/histórico y provenance de alias.
--
-- Objetivo:
--   1. Helper read-only inventory_campaign_product_original_barcode(...) que
--      devuelve el barcode congelado del producto para un campaign, con prioridad
--      sobre fuentes congeladas del Inventario:
--        CAMPAIGN_SNAPSHOT → SESSION_SNAPSHOT → BSALE_AT_REVIEW → NO_BARCODE
--   2. product_barcode_aliases conserva provenance del barcode anterior en el
--      momento de la aprobación: original_barcode_at_review + original_barcode_source.
--   3. approve_inventory_barcode rellena provenance al crear el alias (fuente
--      congelada del Inventario; si no existe, BSALE_AT_REVIEW; nunca se etiqueta
--      como "al inicio" si la fuente real fue Bsale vivo).
--
-- No modifica integraciones (READ ONLY), storage ni otros schemas.
-- Esquema afectado EXCLUSIVAMENTE: inventarios.

BEGIN;

-- Helper: barcode congelado/original de un producto para un campaign.
-- Fuentes congeladas del Inventario primero; fallback Bsale vivo; luego NO_BARCODE.
CREATE OR REPLACE FUNCTION inventarios.inventory_campaign_product_original_barcode(
    p_company_id uuid,
    p_campaign_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE sql
STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
    SELECT pg_catalog.jsonb_build_object(
        'barcode', coalesce(
            NULLIF(pg_catalog.btrim(csp.barcode), ''),
            NULLIF(pg_catalog.btrim(sp.barcode), ''),
            NULLIF(pg_catalog.btrim(bv.bar_code), '')
        ),
        'source', CASE
            WHEN csp.barcode IS NOT NULL AND pg_catalog.btrim(csp.barcode) <> '' THEN 'CAMPAIGN_SNAPSHOT'
            WHEN sp.barcode IS NOT NULL AND pg_catalog.btrim(sp.barcode) <> '' THEN 'SESSION_SNAPSHOT'
            WHEN bv.bar_code IS NOT NULL AND pg_catalog.btrim(bv.bar_code) <> '' THEN 'BSALE_AT_REVIEW'
            ELSE 'NO_BARCODE'
        END
    )
    FROM (SELECT 1 AS x) dummy
    LEFT JOIN LATERAL (
        SELECT csp.barcode
        FROM inventarios.inventory_campaign_snapshot_products csp
        WHERE csp.company_id = p_company_id
          AND csp.bsale_variant_id = p_bsale_variant_id
          AND csp.campaign_snapshot_id = (
              SELECT cs.id FROM inventarios.inventory_campaign_snapshots cs
              WHERE cs.company_id = p_company_id AND cs.campaign_id = p_campaign_id
              ORDER BY cs.created_at DESC LIMIT 1
          )
        LIMIT 1
    ) csp ON true
    LEFT JOIN LATERAL (
        SELECT sp.barcode
        FROM inventarios.snapshot_products sp
        JOIN inventarios.operational_snapshots os
          ON os.company_id = sp.company_id AND os.id = sp.snapshot_id
        JOIN inventarios.sessions s
          ON s.company_id = os.company_id AND s.id = os.session_id
        WHERE sp.bsale_variant_id = p_bsale_variant_id
          AND s.campaign_id = p_campaign_id
        LIMIT 1
    ) sp ON true
    LEFT JOIN LATERAL (
        SELECT bv.bar_code
        FROM integraciones.bsale_variants bv
        WHERE bv.company_id = p_company_id AND bv.bsale_id = p_bsale_variant_id
        LIMIT 1
    ) bv ON true
    LIMIT 1;
$function$;

-- Provenance en aliases: código anterior congelado + fuente.
ALTER TABLE inventarios.product_barcode_aliases
    ADD COLUMN IF NOT EXISTS original_barcode_at_review text,
    ADD COLUMN IF NOT EXISTS original_barcode_source text;

ALTER TABLE inventarios.product_barcode_aliases
    DROP CONSTRAINT IF EXISTS chk_inventarios_barcode_aliases_original_source;

ALTER TABLE inventarios.product_barcode_aliases
    ADD CONSTRAINT chk_inventarios_barcode_aliases_original_source
        CHECK (original_barcode_source IS NULL OR original_barcode_source IN (
            'CAMPAIGN_SNAPSHOT','SESSION_SNAPSHOT','BSALE_AT_REVIEW','NO_BARCODE'));

COMMENT ON COLUMN inventarios.product_barcode_aliases.original_barcode_at_review
    IS 'Barcode anterior/original del producto congelado al momento de aprobar el alias (reporte histórico).';
COMMENT ON COLUMN inventarios.product_barcode_aliases.original_barcode_source
    IS 'Provenance del barcode anterior: CAMPAIGN_SNAPSHOT | SESSION_SNAPSHOT | BSALE_AT_REVIEW | NO_BARCODE.';

-- approve rellena provenance al crear el alias (no altera aliases existentes).
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
    v_orig jsonb;
    v_orig_barcode text;
    v_orig_source text;
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
        -- Provenance del barcode anterior congelado al momento de aprobar.
        v_orig := inventarios.inventory_campaign_product_original_barcode(p_company_id, p_campaign_id, p_bsale_variant_id);
        v_orig_barcode := v_orig ->> 'barcode';
        v_orig_source := v_orig ->> 'source';

        INSERT INTO inventarios.product_barcode_aliases (
            company_id, barcode, bsale_variant_id, product_id, source, is_active,
            original_barcode_at_review, original_barcode_source,
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
            'ADMIN_REVIEW', true,
            NULLIF(v_orig_barcode, ''), CASE WHEN NULLIF(v_orig_barcode, '') IS NULL THEN NULL ELSE v_orig_source END,
            v_occurred_at, v_actor_id, v_occurred_at, v_actor_id
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
            'original_barcode_at_review',v_orig_barcode,
            'original_barcode_source',v_orig_source,
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
