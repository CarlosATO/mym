-- Aplicacion campaign-level de conciliaciones READY a Kardex.
-- Las tablas nuevas viven en inventarios; los movimientos operacionales usan
-- exclusivamente los contratos existentes de logistica.

CREATE TABLE inventarios.inventory_campaign_logistics_applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    reconciliation_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_reconciliations(id) ON DELETE RESTRICT,
    idempotency_key uuid NOT NULL,
    status text NOT NULL DEFAULT 'APPLYING',
    attempted_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    failure_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_logistics_application_key
        UNIQUE (company_id, reconciliation_id, idempotency_key),
    CONSTRAINT chk_inventarios_campaign_logistics_application_status
        CHECK (status IN ('APPLYING', 'APPLIED', 'PARTIALLY_APPLIED', 'FAILED')),
    CONSTRAINT chk_inventarios_campaign_logistics_application_dates
        CHECK (applied_at IS NULL OR status = 'APPLIED')
);

CREATE TABLE inventarios.inventory_campaign_logistics_application_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    application_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_logistics_applications(id) ON DELETE CASCADE,
    reconciliation_item_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_reconciliation_items(id) ON DELETE RESTRICT,
    reconciliation_line_id uuid REFERENCES inventarios.inventory_campaign_reconciliation_lines(id) ON DELETE RESTRICT,
    session_id uuid,
    official_version_id uuid,
    official_version_location_item_id uuid,
    product_id uuid,
    warehouse_id uuid,
    logistics_location_id uuid,
    previous_balance numeric(14,4),
    target_balance numeric(14,4),
    delta numeric(14,4),
    stock_adjustment_id uuid,
    stock_adjustment_item_id uuid,
    kardex_movement_id uuid,
    result text NOT NULL,
    failure_reason text,
    applied_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    applied_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_logistics_application_line
        UNIQUE (application_id, reconciliation_item_id, reconciliation_line_id),
    CONSTRAINT chk_inventarios_campaign_logistics_application_item_result
        CHECK (result IN ('APPLIED', 'NO_OP', 'FAILED')),
    CONSTRAINT chk_inventarios_campaign_logistics_application_item_delta
        CHECK (delta IS NULL OR delta = target_balance - previous_balance),
    CONSTRAINT chk_inventarios_campaign_logistics_application_item_noop
        CHECK (result <> 'NO_OP' OR delta = 0)
);

CREATE INDEX idx_inventarios_campaign_logistics_applications_campaign
    ON inventarios.inventory_campaign_logistics_applications(company_id, campaign_id, status);
CREATE INDEX idx_inventarios_campaign_logistics_application_items_application
    ON inventarios.inventory_campaign_logistics_application_items(company_id, application_id);
CREATE INDEX idx_inventarios_campaign_logistics_application_items_item
    ON inventarios.inventory_campaign_logistics_application_items(company_id, reconciliation_item_id);

ALTER TABLE inventarios.inventory_campaign_logistics_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_logistics_application_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_campaign_logistics_applications FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE inventarios.inventory_campaign_logistics_application_items FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.apply_inventory_campaign_logistics(
    p_company_id uuid,
    p_campaign_id uuid,
    p_reconciliation_item_ids uuid[],
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_reconciliation_id uuid;
    v_application_id uuid;
    v_existing_application uuid;
    v_input uuid;
    v_item record;
    v_line record;
    v_latest_run uuid;
    v_latest_quantity numeric;
    v_latest_exists boolean;
    v_current_balance numeric(14,4);
    v_delta numeric(14,4);
    v_adjustment_id uuid;
    v_adjustment_item_id uuid;
    v_application_item_id uuid;
    v_movement_id uuid;
    v_seq integer;
    v_year text;
    v_adjustment_number text;
    v_error text;
    v_success_count integer := 0;
    v_failed_count integer := 0;
    v_pending_item_count integer := 0;
    v_applied_item_count integer := 0;
    v_ready_item_count integer := 0;
    v_result jsonb := '[]'::jsonb;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL
       OR p_reconciliation_item_ids IS NULL
       OR cardinality(p_reconciliation_item_ids) = 0
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.apply_inventory_campaign_logistics.campaign'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text)
    );

    IF NOT EXISTS (
        SELECT 1 FROM inventarios.inventory_campaigns c
        WHERE c.company_id = p_company_id AND c.id = p_campaign_id AND c.status = 'APPROVED'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_NOT_APPROVED';
    END IF;
    SELECT r.id INTO v_reconciliation_id
    FROM inventarios.inventory_campaign_reconciliations r
    WHERE r.company_id = p_company_id AND r.campaign_id = p_campaign_id
    FOR UPDATE;
    IF v_reconciliation_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_RECONCILIATION_NOT_FOUND';
    END IF;

    SELECT a.id INTO v_existing_application
    FROM inventarios.inventory_campaign_logistics_applications a
    WHERE a.company_id = p_company_id
      AND a.reconciliation_id = v_reconciliation_id
      AND a.idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_existing_application IS NOT NULL THEN
        SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.reconciliation_item_id), '[]'::jsonb)
        INTO v_result
        FROM inventarios.inventory_campaign_logistics_application_items x
        WHERE x.application_id = v_existing_application;
        SELECT a.status INTO v_error
        FROM inventarios.inventory_campaign_logistics_applications a WHERE a.id = v_existing_application;
        RETURN jsonb_build_object('application_id', v_existing_application, 'campaign_id', p_campaign_id,
                                  'status', v_error, 'replayed', true, 'items', v_result,
                                  'applied_by', v_actor_id, 'read_at', now());
    END IF;

    INSERT INTO inventarios.inventory_campaign_logistics_applications
        (company_id, campaign_id, reconciliation_id, idempotency_key, status, attempted_by, attempted_at)
    VALUES (p_company_id, p_campaign_id, v_reconciliation_id, p_idempotency_key,
            'APPLYING', v_actor_id, now())
    RETURNING id INTO v_application_id;

    FOR v_input IN
        SELECT DISTINCT x FROM unnest(p_reconciliation_item_ids) AS t(x)
        WHERE x IS NOT NULL ORDER BY x
    LOOP
        BEGIN
            PERFORM pg_catalog.pg_advisory_xact_lock(
                pg_catalog.hashtext('inventarios.apply_inventory_campaign_logistics.item'),
                pg_catalog.hashtext(p_company_id::text || ':' || v_input::text)
            );
            SELECT i.* INTO v_item
            FROM inventarios.inventory_campaign_reconciliation_items i
            WHERE i.company_id = p_company_id
              AND i.reconciliation_id = v_reconciliation_id
              AND i.id = v_input
            FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_RECONCILIATION_ITEM_NOT_FOUND'; END IF;
            IF v_item.reconciliation_status = 'APPLIED'
               OR EXISTS (
                   SELECT 1 FROM inventarios.inventory_campaign_logistics_application_items ai
                   WHERE ai.company_id=p_company_id AND ai.reconciliation_item_id=v_item.id
                     AND ai.result IN ('APPLIED','NO_OP')
               ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ITEM_ALREADY_APPLIED';
            END IF;
            IF v_item.reconciliation_status <> 'READY'
               OR v_item.logistics_applicability_status <> 'READY' THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ITEM_NOT_READY';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_reconciliations r
                WHERE r.id=v_reconciliation_id AND r.company_id=p_company_id
                  AND r.campaign_id=p_campaign_id
            ) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_RECONCILIATION_NOT_CURRENT'; END IF;

            SELECT r.id INTO v_latest_run
            FROM integraciones.bsale_sync_runs r
            WHERE r.company_id=p_company_id AND r.status='COMPLETED'
            ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC LIMIT 1;
            SELECT coalesce(sum(sc.quantity),0), count(*) > 0
            INTO v_latest_quantity, v_latest_exists
            FROM integraciones.bsale_stock_current sc
            WHERE sc.company_id=p_company_id AND sc.variant_id=v_item.bsale_variant_id
              AND sc.office_id=v_item.bsale_office_id AND sc.bsale_sync_run_id=v_latest_run;
            IF v_latest_run IS NULL OR NOT v_latest_exists
               OR v_item.bsale_sync_run_id IS DISTINCT FROM v_latest_run
               OR v_item.bsale_quantity IS DISTINCT FROM v_latest_quantity THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_BSALE_STALE';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM inventarios.inventory_campaign_reconciliation_lines l
                WHERE l.reconciliation_item_id=v_item.id
                  AND (l.line_status <> 'READY' OR cardinality(l.block_reasons) > 0
                       OR l.logistics_location_id IS NULL OR l.warehouse_id IS NULL)
            ) OR NOT EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines l
                WHERE l.reconciliation_item_id=v_item.id
            ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_LOCATION_MAPPING_INVALID';
            END IF;
            IF EXISTS (
                SELECT 1
                FROM inventarios.inventory_campaign_reconciliation_lines l
                JOIN inventarios.inventory_campaign_reconciliation_sources s
                  ON s.reconciliation_id=v_reconciliation_id AND s.session_id=l.session_id
                 AND s.official_version_id=l.official_version_id AND s.source_status='INCLUDED'
                JOIN inventarios.sessions se ON se.company_id=p_company_id AND se.id=l.session_id
                JOIN inventarios.official_versions ov ON ov.company_id=p_company_id AND ov.id=l.official_version_id
                WHERE l.reconciliation_item_id=v_item.id
                  AND (se.campaign_id IS DISTINCT FROM p_campaign_id OR se.status <> 'APPROVED'
                       OR ov.superseded_at IS NOT NULL)
            ) OR EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines l
                WHERE l.reconciliation_item_id=v_item.id
                  AND NOT EXISTS (
                      SELECT 1 FROM inventarios.inventory_campaign_reconciliation_sources s
                      JOIN inventarios.sessions se ON se.company_id=p_company_id AND se.id=s.session_id
                      JOIN inventarios.official_versions ov ON ov.company_id=p_company_id AND ov.id=s.official_version_id
                      WHERE s.reconciliation_id=v_reconciliation_id AND s.session_id=l.session_id
                        AND s.official_version_id=l.official_version_id AND s.source_status='INCLUDED'
                        AND se.campaign_id=p_campaign_id AND se.status='APPROVED' AND ov.superseded_at IS NULL
                  )
            ) THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_SOURCE_INVALID';
            END IF;
            IF EXISTS (
                SELECT 1
                FROM inventarios.inventory_campaign_reconciliation_lines l
                JOIN inventarios.snapshot_locations sl ON sl.company_id=p_company_id
                  AND sl.snapshot_id=l.snapshot_id AND sl.id=l.snapshot_location_id
                JOIN logistica.locations loc ON loc.company_id=p_company_id AND loc.id=l.logistics_location_id
                JOIN inventarios.snapshot_products sp ON sp.company_id=p_company_id
                  AND sp.snapshot_id=l.snapshot_id AND sp.id=l.snapshot_product_id
                WHERE l.reconciliation_item_id=v_item.id
                  AND (loc.is_active IS DISTINCT FROM true OR sp.product_id IS NULL
                       OR sl.location_id IS DISTINCT FROM l.logistics_location_id
                       OR sl.warehouse_id IS DISTINCT FROM l.warehouse_id
                       OR loc.warehouse_id IS DISTINCT FROM l.warehouse_id)
            ) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_MAPPING_INVALID'; END IF;
            IF EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_logistics_application_items old_ai
                JOIN inventarios.inventory_logistics_application_items old_line
                  ON old_line.official_version_location_item_id=old_ai.official_version_location_item_id
                JOIN inventarios.inventory_logistics_applications old_a
                  ON old_a.id=old_line.application_id AND old_a.status='APPLIED'
                WHERE old_ai.reconciliation_item_id=v_item.id
            ) OR EXISTS (
                SELECT 1 FROM inventarios.inventory_logistics_application_items old_line
                JOIN inventarios.inventory_logistics_applications old_a
                  ON old_a.id=old_line.application_id AND old_a.status='APPLIED'
                JOIN inventarios.inventory_campaign_reconciliation_lines l
                  ON l.official_version_location_item_id=old_line.official_version_location_item_id
                WHERE l.reconciliation_item_id=v_item.id
            ) THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CAMPAIGN_ITEM_SESSION_ALREADY_APPLIED'; END IF;

            FOR v_line IN
                SELECT l.*, sp.product_id
                FROM inventarios.inventory_campaign_reconciliation_lines l
                JOIN inventarios.snapshot_products sp ON sp.company_id=l.company_id
                  AND sp.snapshot_id=l.snapshot_id AND sp.id=l.snapshot_product_id
                WHERE l.company_id=p_company_id AND l.reconciliation_item_id=v_item.id
                ORDER BY l.warehouse_id, l.logistics_location_id, l.id
            LOOP
                PERFORM pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtext('inventarios.apply_inventory_campaign_logistics.location'),
                    pg_catalog.hashtext(p_company_id::text || ':' || v_line.warehouse_id::text || ':' || v_line.logistics_location_id::text || ':' || v_line.product_id::text)
                );
                SELECT coalesce(sum(CASE WHEN km.movement_type IN ('IN','TRANSFER_IN','ADJUSTMENT') THEN km.quantity ELSE -km.quantity END),0)::numeric(14,4)
                INTO v_current_balance
                FROM logistica.kardex_movements km
                WHERE km.company_id=p_company_id AND km.product_id=v_line.product_id
                  AND km.warehouse_id=v_line.warehouse_id AND km.location_id=v_line.logistics_location_id;
                v_delta := v_line.physical_quantity::numeric(14,4) - v_current_balance;
                IF v_delta = 0 THEN
                    INSERT INTO inventarios.inventory_campaign_logistics_application_items
                        (company_id, application_id, reconciliation_item_id, reconciliation_line_id, session_id,
                         official_version_id, official_version_location_item_id, product_id, warehouse_id,
                         logistics_location_id, previous_balance, target_balance, delta, result, applied_by)
                    VALUES (p_company_id, v_application_id, v_item.id, v_line.id, v_line.session_id,
                            v_line.official_version_id, v_line.official_version_location_item_id, v_line.product_id,
                            v_line.warehouse_id, v_line.logistics_location_id, v_current_balance,
                            v_line.physical_quantity, 0, 'NO_OP', v_actor_id);
                    CONTINUE;
                END IF;
                v_adjustment_id := NULL;
                SELECT ai.stock_adjustment_id INTO v_adjustment_id
                FROM inventarios.inventory_campaign_logistics_application_items ai
                WHERE ai.application_id=v_application_id AND ai.result='APPLIED'
                  AND ai.warehouse_id=v_line.warehouse_id
                  AND ((ai.delta > 0 AND v_delta > 0) OR (ai.delta < 0 AND v_delta < 0))
                  AND ai.stock_adjustment_id IS NOT NULL LIMIT 1;
                IF v_adjustment_id IS NULL THEN
                    PERFORM pg_catalog.pg_advisory_xact_lock(
                        pg_catalog.hashtext('logistica.stock_adjustment_number'),
                        pg_catalog.hashtext(p_company_id::text || ':' || to_char(now(),'YYYY'))
                    );
                    v_year := to_char(now(),'YYYY');
                    SELECT coalesce(max(substring(adjustment_number FROM 9)::integer),0)+1 INTO v_seq
                    FROM logistica.stock_adjustments
                    WHERE company_id=p_company_id AND adjustment_number LIKE 'AJ-' || v_year || '-%';
                    v_adjustment_number := 'AJ-' || v_year || '-' || lpad(v_seq::text,6,'0');
                    INSERT INTO logistica.stock_adjustments
                        (company_id, adjustment_number, adjustment_type, reason, warehouse_id, notes, status, created_by)
                    VALUES (p_company_id, v_adjustment_number, CASE WHEN v_delta > 0 THEN 'POSITIVE' ELSE 'NEGATIVE' END,
                            'INVENTARIOS_CAMPAIGN_APPLY', v_line.warehouse_id,
                            'campaign_id=' || p_campaign_id::text || ';application_id=' || v_application_id::text,
                            'COMPLETED', v_actor_id)
                    RETURNING id INTO v_adjustment_id;
                END IF;
                INSERT INTO inventarios.inventory_campaign_logistics_application_items
                    (company_id, application_id, reconciliation_item_id, reconciliation_line_id, session_id,
                     official_version_id, official_version_location_item_id, product_id, warehouse_id,
                     logistics_location_id, previous_balance, target_balance, delta, result,
                     stock_adjustment_id, applied_by)
                VALUES (p_company_id, v_application_id, v_item.id, v_line.id, v_line.session_id,
                        v_line.official_version_id, v_line.official_version_location_item_id, v_line.product_id,
                        v_line.warehouse_id, v_line.logistics_location_id, v_current_balance,
                        v_line.physical_quantity, v_delta, 'APPLIED', v_adjustment_id, v_actor_id)
                RETURNING id INTO v_application_item_id;
                INSERT INTO logistica.stock_adjustment_items
                    (adjustment_id, company_id, product_id, warehouse_id, location_id, quantity, notes, created_by)
                VALUES (v_adjustment_id, p_company_id, v_line.product_id, v_line.warehouse_id,
                        v_line.logistics_location_id, abs(v_delta),
                        'campaign_application_item_id=' || v_application_item_id::text, v_actor_id)
                RETURNING id INTO v_adjustment_item_id;
                UPDATE inventarios.inventory_campaign_logistics_application_items
                SET stock_adjustment_item_id=v_adjustment_item_id WHERE id=v_application_item_id;
                INSERT INTO logistica.kardex_movements
                    (company_id, product_id, warehouse_id, location_id, movement_type, source_type,
                     source_id, source_line_id, quantity, notes, created_by)
                VALUES (p_company_id, v_line.product_id, v_line.warehouse_id, v_line.logistics_location_id,
                        'ADJUSTMENT', 'ADJUSTMENT', v_adjustment_id, v_application_item_id,
                        v_delta, 'campaign_application_id=' || v_application_id::text, v_actor_id)
                RETURNING id INTO v_movement_id;
                UPDATE inventarios.inventory_campaign_logistics_application_items
                SET kardex_movement_id=v_movement_id WHERE id=v_application_item_id;
            END LOOP;
            UPDATE inventarios.inventory_campaign_reconciliation_items
            SET reconciliation_status='APPLIED', logistics_applicability_status='READY', updated_at=now()
            WHERE id=v_item.id;
            v_success_count := v_success_count + 1;
        EXCEPTION WHEN OTHERS THEN
            v_error := sqlerrm;
            INSERT INTO inventarios.inventory_campaign_logistics_application_items
                (company_id, application_id, reconciliation_item_id, result, failure_reason, applied_by)
            VALUES (p_company_id, v_application_id, v_input, 'FAILED', v_error, v_actor_id);
            v_failed_count := v_failed_count + 1;
        END;
    END LOOP;

    UPDATE inventarios.inventory_campaign_logistics_applications
    SET status=CASE WHEN v_failed_count=0 THEN 'APPLIED'
                    WHEN v_success_count > 0 THEN 'PARTIALLY_APPLIED' ELSE 'FAILED' END,
        applied_at=CASE WHEN v_failed_count=0 THEN now() ELSE NULL END,
        failure_reason=CASE WHEN v_failed_count > 0 THEN 'ONE_OR_MORE_ITEMS_FAILED' ELSE NULL END
    WHERE id=v_application_id;
    SELECT count(*) FILTER (WHERE i.reconciliation_status <> 'APPLIED'),
           count(*) FILTER (WHERE i.reconciliation_status = 'APPLIED'),
           count(*) FILTER (WHERE i.reconciliation_status = 'READY')
    INTO v_pending_item_count, v_applied_item_count, v_ready_item_count
    FROM inventarios.inventory_campaign_reconciliation_items i
    WHERE i.reconciliation_id=v_reconciliation_id;
    UPDATE inventarios.inventory_campaign_reconciliations r
    SET status=CASE
        WHEN v_pending_item_count=0 AND v_applied_item_count>0 THEN 'APPLIED'
        WHEN v_applied_item_count>0 THEN 'PARTIALLY_APPLIED'
        WHEN v_ready_item_count>0 THEN 'READY'
        ELSE 'BLOCKED' END,
        updated_at=now()
    WHERE r.id=v_reconciliation_id;

    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.reconciliation_item_id), '[]'::jsonb)
    INTO v_result FROM inventarios.inventory_campaign_logistics_application_items x
    WHERE x.application_id=v_application_id;
    RETURN jsonb_build_object('application_id',v_application_id,'campaign_id',p_campaign_id,
                              'status',CASE WHEN v_failed_count=0 THEN 'APPLIED' WHEN v_success_count>0 THEN 'PARTIALLY_APPLIED' ELSE 'FAILED' END,
                              'replayed',false,'items',v_result,'applied_by',v_actor_id,'applied_at',now());
END;
$function$;

ALTER FUNCTION inventarios.apply_inventory_campaign_logistics(uuid, uuid, uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.apply_inventory_campaign_logistics(uuid, uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.apply_inventory_campaign_logistics(uuid, uuid, uuid[], uuid) TO authenticated, service_role;
