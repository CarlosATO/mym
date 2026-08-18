-- Aplicacion transaccional de productos READY al Kardex.
-- Las escrituras operacionales usan contratos/tablas existentes de logistica.
-- No se modifica el DDL de otros esquemas.

ALTER TABLE inventarios.inventory_stock_reconciliations
    ADD COLUMN IF NOT EXISTS logistics_application_status text NOT NULL DEFAULT 'NOT_APPLIED';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_inventarios_stock_recon_application_status'
          AND conrelid = 'inventarios.inventory_stock_reconciliations'::regclass
    ) THEN
        ALTER TABLE inventarios.inventory_stock_reconciliations
            ADD CONSTRAINT chk_inventarios_stock_recon_application_status
            CHECK (logistics_application_status IN ('NOT_APPLIED', 'APPLIED'));
    END IF;
END;
$migration$;

CREATE TABLE inventarios.inventory_logistics_applications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    official_version_id uuid NOT NULL,
    reconciliation_id uuid NOT NULL REFERENCES inventarios.inventory_stock_reconciliations(id) ON DELETE RESTRICT,
    snapshot_product_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    idempotency_key uuid NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 1,
    failure_reason text,
    attempted_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_logistics_application_reconciliation
        UNIQUE (company_id, reconciliation_id),
    CONSTRAINT chk_inventarios_logistics_application_status
        CHECK (status IN ('APPLYING', 'APPLIED', 'FAILED')),
    CONSTRAINT chk_inventarios_logistics_application_dates
        CHECK (applied_at IS NULL OR status = 'APPLIED')
);

CREATE TABLE inventarios.inventory_logistics_application_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    application_id uuid NOT NULL REFERENCES inventarios.inventory_logistics_applications(id) ON DELETE CASCADE,
    official_version_location_item_id uuid NOT NULL,
    snapshot_location_id uuid NOT NULL,
    logistics_location_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    previous_balance numeric(14,4) NOT NULL,
    target_balance numeric(14,4) NOT NULL,
    delta numeric(14,4) NOT NULL,
    result text NOT NULL,
    stock_adjustment_id uuid,
    stock_adjustment_item_id uuid,
    kardex_movement_id uuid,
    applied_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    applied_at timestamptz NOT NULL DEFAULT now(),
    failure_reason text,
    CONSTRAINT uq_inventarios_logistics_application_item
        UNIQUE (application_id, official_version_location_item_id),
    CONSTRAINT chk_inventarios_logistics_application_item_result
        CHECK (result IN ('APPLIED', 'NO_OP', 'FAILED')),
    CONSTRAINT chk_inventarios_logistics_application_item_delta
        CHECK (delta = target_balance - previous_balance),
    CONSTRAINT chk_inventarios_logistics_application_item_noop
        CHECK (result <> 'NO_OP' OR delta = 0)
);

CREATE INDEX idx_inventarios_logistics_applications_version
    ON inventarios.inventory_logistics_applications(company_id, official_version_id);
CREATE INDEX idx_inventarios_logistics_application_items_application
    ON inventarios.inventory_logistics_application_items(company_id, application_id);

ALTER TABLE inventarios.inventory_logistics_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_logistics_application_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_logistics_applications FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE inventarios.inventory_logistics_application_items FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.apply_inventory_logistics_v1(
    p_company_id uuid,
    p_official_version_id uuid,
    p_reconciliation_ids uuid[],
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
    v_input uuid;
    v_recon inventarios.inventory_stock_reconciliations%ROWTYPE;
    v_location record;
    v_app jsonb;
    v_reasons text[];
    v_application_id uuid;
    v_line_id uuid;
    v_adjustment_item_id uuid;
    v_movement_id uuid;
    v_positive_adjustment_id uuid;
    v_negative_adjustment_id uuid;
    v_current_balance numeric(14,4);
    v_delta numeric(14,4);
    v_seq integer;
    v_adjustment_number text;
    v_year text;
    v_error text;
    v_result jsonb := '[]'::jsonb;
    v_applied_lines integer;
    v_noop_lines integer;
    v_latest_run uuid;
    v_latest_quantity numeric;
    v_session_status text;
    v_session_warehouse_id uuid;
BEGIN
    IF p_company_id IS NULL OR p_official_version_id IS NULL
       OR p_reconciliation_ids IS NULL OR cardinality(p_reconciliation_ids) = 0
       OR p_idempotency_key IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM pg_advisory_xact_lock(
        hashtext('inventarios.apply_inventory_logistics_v1.batch'),
        hashtext(p_company_id::text || ':' || p_official_version_id::text)
    );

    FOR v_input IN
        SELECT DISTINCT x FROM unnest(p_reconciliation_ids) AS t(x) WHERE x IS NOT NULL ORDER BY x
    LOOP
        v_application_id := NULL;
        v_positive_adjustment_id := NULL;
        v_negative_adjustment_id := NULL;
        BEGIN
            SELECT r.*
            INTO v_recon
            FROM inventarios.inventory_stock_reconciliations r
            WHERE r.company_id = p_company_id
              AND r.official_version_id = p_official_version_id
              AND r.id = v_input
            FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_RECONCILIATION_NOT_FOUND';
            END IF;

            IF v_recon.logistics_application_status = 'APPLIED' THEN
                v_result := v_result || jsonb_build_array(jsonb_build_object(
                    'reconciliation_id', v_recon.id,
                    'status', 'APPLIED',
                    'replayed', true
                ));
                CONTINUE;
            END IF;

            SELECT s.status, s.warehouse_id
            INTO v_session_status, v_session_warehouse_id
            FROM inventarios.sessions s
            WHERE s.company_id = p_company_id AND s.id = v_recon.session_id;
            IF v_session_status <> 'APPROVED' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_OFFICIAL_VERSION_NOT_APPROVED';
            END IF;
            IF v_session_warehouse_id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_UNMAPPED_LOCATION';
            END IF;
            IF v_recon.reconciliation_status <> 'READY'
               OR v_recon.logistics_applicability_status <> 'READY' THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_LOGISTICS_V1_NOT_READY';
            END IF;

            v_app := inventarios.compute_inventory_logistics_v1_applicability(v_recon.id);
            v_reasons := ARRAY(
                SELECT jsonb_array_elements_text(coalesce(v_app->'block_reasons', '[]'::jsonb))
            );
            IF coalesce(v_app->>'status', 'BLOCKED') <> 'READY' OR cardinality(v_reasons) > 0 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001',
                    MESSAGE = 'INV_LOGISTICS_V1_BLOCKED', DETAIL = array_to_string(v_reasons, ',');
            END IF;
            IF coalesce((v_app->>'scope_location_count')::integer, 0) = 0
               OR coalesce((v_app->>'explicit_location_count')::integer, 0) = 0 THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_LOGISTICS_V1_NO_EXPLICIT_LOCATIONS';
            END IF;

            SELECT r.id
            INTO v_latest_run
            FROM integraciones.bsale_sync_runs r
            WHERE r.company_id = p_company_id AND r.status = 'COMPLETED'
            ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
            LIMIT 1;
            SELECT sum(sc.quantity)
            INTO v_latest_quantity
            FROM integraciones.bsale_stock_current sc
            WHERE sc.company_id = p_company_id
              AND sc.variant_id = v_recon.bsale_variant_id
              AND sc.bsale_sync_run_id = v_latest_run;
            IF v_latest_run IS NULL
               OR v_recon.bsale_sync_run_id IS DISTINCT FROM v_latest_run
               OR v_recon.bsale_quantity IS DISTINCT FROM v_latest_quantity THEN
                RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BSALE_STALE';
            END IF;

            INSERT INTO inventarios.inventory_logistics_applications (
                company_id, official_version_id, reconciliation_id, snapshot_product_id,
                bsale_variant_id, idempotency_key, status, attempt_count,
                attempted_by, attempted_at, created_at
            ) VALUES (
                p_company_id, p_official_version_id, v_recon.id, v_recon.snapshot_product_id,
                v_recon.bsale_variant_id, p_idempotency_key, 'APPLYING', 1,
                v_actor_id, now(), now()
            )
            ON CONFLICT (company_id, reconciliation_id)
            DO UPDATE SET
                idempotency_key = EXCLUDED.idempotency_key,
                status = 'APPLYING',
                attempt_count = inventarios.inventory_logistics_applications.attempt_count + 1,
                failure_reason = NULL,
                attempted_by = EXCLUDED.attempted_by,
                attempted_at = now()
            RETURNING id INTO v_application_id;

            FOR v_location IN
                SELECT ovli.id AS official_location_item_id,
                       ovli.snapshot_location_id,
                       ovli.physical_quantity::numeric(14,4) AS target_balance,
                       ovli.available_quantity,
                       ovli.damaged_quantity,
                       ovli.expired_quantity,
                       ovli.blocked_quantity,
                       ovli.other_unavailable_quantity,
                       sl.location_id AS logistics_location_id,
                       l.warehouse_id,
                       l.is_active,
                       sp.product_id
                FROM inventarios.official_version_location_items ovli
                JOIN inventarios.snapshot_locations sl
                  ON sl.company_id = ovli.company_id
                 AND sl.snapshot_id = v_recon.snapshot_id
                 AND sl.id = ovli.snapshot_location_id
                JOIN logistica.locations l
                  ON l.company_id = ovli.company_id AND l.id = sl.location_id
                JOIN inventarios.snapshot_products sp
                  ON sp.company_id = ovli.company_id
                 AND sp.snapshot_id = v_recon.snapshot_id
                 AND sp.id = ovli.snapshot_product_id
                WHERE ovli.company_id = p_company_id
                  AND ovli.official_version_id = p_official_version_id
                  AND ovli.snapshot_product_id = v_recon.snapshot_product_id
                ORDER BY ovli.snapshot_location_id, ovli.id
            LOOP
                IF v_location.is_active IS DISTINCT FROM true
                   OR v_location.warehouse_id IS DISTINCT FROM v_session_warehouse_id
                   OR v_location.product_id IS NULL THEN
                    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_UNMAPPED_LOCATION';
                END IF;
                IF v_location.available_quantity IS NULL
                   OR v_location.available_quantity IS DISTINCT FROM v_location.target_balance
                   OR coalesce(v_location.damaged_quantity, 0) > 0
                   OR coalesce(v_location.expired_quantity, 0) > 0
                   OR coalesce(v_location.blocked_quantity, 0) > 0
                   OR coalesce(v_location.other_unavailable_quantity, 0) > 0 THEN
                    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_NON_AVAILABLE_PHYSICAL_STOCK';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM inventarios.session_zone_locations szl
                    WHERE szl.company_id = p_company_id
                      AND szl.session_id = v_recon.session_id
                      AND szl.snapshot_location_id = v_location.snapshot_location_id
                      AND szl.location_id = v_location.logistics_location_id
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_LOCATION_OUT_OF_SCOPE';
                END IF;

                PERFORM pg_advisory_xact_lock(
                    hashtext('inventarios.apply_inventory_logistics_v1.product'),
                    hashtext(p_company_id::text || ':' || v_recon.snapshot_product_id::text || ':' || v_location.logistics_location_id::text)
                );

                IF EXISTS (
                    SELECT 1
                    FROM (
                        SELECT km.lot_number, km.expiration_date,
                               sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                        THEN km.quantity ELSE -km.quantity END) AS balance
                        FROM logistica.kardex_movements km
                        WHERE km.company_id = p_company_id
                          AND km.product_id = v_location.product_id
                          AND km.location_id = v_location.logistics_location_id
                        GROUP BY km.lot_number, km.expiration_date
                    ) lots
                    WHERE lots.balance > 0
                      AND (lots.lot_number IS NOT NULL OR lots.expiration_date IS NOT NULL)
                ) THEN
                    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_LOT_OR_EXPIRY_UNSUPPORTED';
                END IF;

                SELECT coalesce(sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                         THEN km.quantity ELSE -km.quantity END), 0)::numeric(14,4)
                INTO v_current_balance
                FROM logistica.kardex_movements km
                WHERE km.company_id = p_company_id
                  AND km.product_id = v_location.product_id
                  AND km.warehouse_id = v_location.warehouse_id
                  AND km.location_id = v_location.logistics_location_id;
                v_delta := v_location.target_balance - v_current_balance;

                IF v_delta = 0 THEN
                    INSERT INTO inventarios.inventory_logistics_application_items (
                        company_id, application_id, official_version_location_item_id,
                        snapshot_location_id, logistics_location_id, warehouse_id,
                        previous_balance, target_balance, delta, result,
                        applied_by, applied_at
                    ) VALUES (
                        p_company_id, v_application_id, v_location.official_location_item_id,
                        v_location.snapshot_location_id, v_location.logistics_location_id,
                        v_location.warehouse_id, v_current_balance, v_location.target_balance,
                        0, 'NO_OP', v_actor_id, now()
                    );
                    CONTINUE;
                END IF;

                IF v_delta > 0 AND v_positive_adjustment_id IS NULL THEN
                    PERFORM pg_advisory_xact_lock(
                        hashtext('logistica.stock_adjustment_number'),
                        hashtext(p_company_id::text || ':' || to_char(now(), 'YYYY'))
                    );
                    v_year := to_char(now(), 'YYYY');
                    SELECT coalesce(max(substring(adjustment_number FROM 9)::integer), 0) + 1
                    INTO v_seq
                    FROM logistica.stock_adjustments
                    WHERE company_id = p_company_id AND adjustment_number LIKE 'AJ-' || v_year || '-%';
                    v_adjustment_number := 'AJ-' || v_year || '-' || lpad(v_seq::text, 6, '0');
                    INSERT INTO logistica.stock_adjustments (
                        company_id, adjustment_number, adjustment_type, reason,
                        warehouse_id, notes, status, created_by
                    ) VALUES (
                        p_company_id, v_adjustment_number, 'POSITIVE',
                        'INVENTARIOS_OFFICIAL_APPLY', v_session_warehouse_id,
                        'official_version_id=' || p_official_version_id::text || ';reconciliation_id=' || v_recon.id::text,
                        'COMPLETED', v_actor_id
                    ) RETURNING id INTO v_positive_adjustment_id;
                ELSIF v_delta < 0 AND v_negative_adjustment_id IS NULL THEN
                    PERFORM pg_advisory_xact_lock(
                        hashtext('logistica.stock_adjustment_number'),
                        hashtext(p_company_id::text || ':' || to_char(now(), 'YYYY'))
                    );
                    v_year := to_char(now(), 'YYYY');
                    SELECT coalesce(max(substring(adjustment_number FROM 9)::integer), 0) + 1
                    INTO v_seq
                    FROM logistica.stock_adjustments
                    WHERE company_id = p_company_id AND adjustment_number LIKE 'AJ-' || v_year || '-%';
                    v_adjustment_number := 'AJ-' || v_year || '-' || lpad(v_seq::text, 6, '0');
                    INSERT INTO logistica.stock_adjustments (
                        company_id, adjustment_number, adjustment_type, reason,
                        warehouse_id, notes, status, created_by
                    ) VALUES (
                        p_company_id, v_adjustment_number, 'NEGATIVE',
                        'INVENTARIOS_OFFICIAL_APPLY', v_session_warehouse_id,
                        'official_version_id=' || p_official_version_id::text || ';reconciliation_id=' || v_recon.id::text,
                        'COMPLETED', v_actor_id
                    ) RETURNING id INTO v_negative_adjustment_id;
                END IF;

                INSERT INTO inventarios.inventory_logistics_application_items (
                    company_id, application_id, official_version_location_item_id,
                    snapshot_location_id, logistics_location_id, warehouse_id,
                    previous_balance, target_balance, delta, result,
                    stock_adjustment_id, applied_by, applied_at
                ) VALUES (
                    p_company_id, v_application_id, v_location.official_location_item_id,
                    v_location.snapshot_location_id, v_location.logistics_location_id,
                    v_location.warehouse_id, v_current_balance, v_location.target_balance,
                    v_delta, 'APPLIED',
                    CASE WHEN v_delta > 0 THEN v_positive_adjustment_id ELSE v_negative_adjustment_id END,
                    v_actor_id, now()
                ) RETURNING id INTO v_line_id;

                INSERT INTO logistica.stock_adjustment_items (
                    adjustment_id, company_id, product_id, warehouse_id, location_id,
                    quantity, unit_cost, total_cost, notes, created_by
                ) VALUES (
                    CASE WHEN v_delta > 0 THEN v_positive_adjustment_id ELSE v_negative_adjustment_id END,
                    p_company_id, v_location.product_id, v_location.warehouse_id,
                    v_location.logistics_location_id, abs(v_delta), NULL, NULL,
                    'inventory_logistics_application_item_id=' || v_line_id::text,
                    v_actor_id
                ) RETURNING id INTO v_adjustment_item_id;
                UPDATE inventarios.inventory_logistics_application_items
                SET stock_adjustment_item_id = v_adjustment_item_id
                WHERE id = v_line_id;

                INSERT INTO logistica.kardex_movements (
                    company_id, product_id, warehouse_id, location_id,
                    movement_type, source_type, source_id, source_line_id,
                    quantity, unit_cost, total_cost, notes, created_by
                ) VALUES (
                    p_company_id, v_location.product_id, v_location.warehouse_id,
                    v_location.logistics_location_id, 'ADJUSTMENT', 'ADJUSTMENT',
                    CASE WHEN v_delta > 0 THEN v_positive_adjustment_id ELSE v_negative_adjustment_id END,
                    v_line_id, v_delta, NULL, NULL,
                    'inventory_logistics_application_id=' || v_application_id::text,
                    v_actor_id
                ) RETURNING id INTO v_movement_id;
                UPDATE inventarios.inventory_logistics_application_items
                SET kardex_movement_id = v_movement_id
                WHERE id = v_line_id;
            END LOOP;

            SELECT count(*) FILTER (WHERE result = 'APPLIED'),
                   count(*) FILTER (WHERE result = 'NO_OP')
            INTO v_applied_lines, v_noop_lines
            FROM inventarios.inventory_logistics_application_items
            WHERE application_id = v_application_id;
            UPDATE inventarios.inventory_logistics_applications
            SET status = 'APPLIED', applied_at = now(), failure_reason = NULL
            WHERE id = v_application_id;
            UPDATE inventarios.inventory_stock_reconciliations
            SET logistics_application_status = 'APPLIED', updated_at = now()
            WHERE id = v_recon.id;
            v_result := v_result || jsonb_build_array(jsonb_build_object(
                'reconciliation_id', v_recon.id,
                'status', 'APPLIED',
                'replayed', false,
                'applied_lines', coalesce(v_applied_lines, 0),
                'noop_lines', coalesce(v_noop_lines, 0),
                'positive_adjustment_id', v_positive_adjustment_id,
                'negative_adjustment_id', v_negative_adjustment_id
            ));
        EXCEPTION WHEN OTHERS THEN
            v_error := sqlerrm;
            IF v_recon.id IS NOT NULL THEN
                INSERT INTO inventarios.inventory_logistics_applications (
                    company_id, official_version_id, reconciliation_id,
                    snapshot_product_id, bsale_variant_id, idempotency_key,
                    status, attempt_count, failure_reason, attempted_by, attempted_at
                ) VALUES (
                    p_company_id, p_official_version_id, v_recon.id,
                    v_recon.snapshot_product_id, v_recon.bsale_variant_id,
                    p_idempotency_key, 'FAILED', 1, v_error, v_actor_id, now()
                )
                ON CONFLICT (company_id, reconciliation_id)
                DO UPDATE SET status = 'FAILED', failure_reason = EXCLUDED.failure_reason,
                    idempotency_key = EXCLUDED.idempotency_key,
                    attempt_count = inventarios.inventory_logistics_applications.attempt_count + 1,
                    attempted_by = EXCLUDED.attempted_by, attempted_at = now(), applied_at = NULL;
            END IF;
            v_result := v_result || jsonb_build_array(jsonb_build_object(
                'reconciliation_id', coalesce(v_recon.id, v_input),
                'status', 'FAILED',
                'replayed', false,
                'error', v_error
            ));
        END;
    END LOOP;
    RETURN jsonb_build_object(
        'official_version_id', p_official_version_id,
        'applied_by', v_actor_id,
        'results', v_result
    );
END;
$function$;

ALTER FUNCTION inventarios.apply_inventory_logistics_v1(uuid, uuid, uuid[], uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.apply_inventory_logistics_v1(uuid, uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.apply_inventory_logistics_v1(uuid, uuid, uuid[], uuid) TO authenticated, service_role;
