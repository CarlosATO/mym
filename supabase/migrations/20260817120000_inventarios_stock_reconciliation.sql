-- Conciliacion por producto entre resultado oficial de Inventarios y Bsale.
-- Solo crea objetos en inventarios y lee integraciones.bsale_stock_current.

CREATE TABLE inventarios.inventory_stock_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    official_version_id uuid NOT NULL,
    official_version_item_id uuid NOT NULL,
    session_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    bsale_variant_id integer NOT NULL,
    inventory_physical_quantity numeric(14,3) NOT NULL,
    bsale_quantity numeric(14,3),
    difference_quantity numeric(14,3),
    mapping_status text NOT NULL,
    location_resolution_status text NOT NULL,
    reconciliation_status text NOT NULL,
    bsale_sync_run_id uuid,
    bsale_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_inventarios_stock_recon_version
        FOREIGN KEY (company_id, official_version_id)
        REFERENCES inventarios.official_versions(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_stock_recon_item
        FOREIGN KEY (company_id, official_version_item_id)
        REFERENCES inventarios.official_version_items(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_stock_recon_session
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_stock_recon_product
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_stock_recon_item
        UNIQUE (company_id, official_version_id, official_version_item_id),
    CONSTRAINT chk_inventarios_stock_recon_mapping
        CHECK (mapping_status IN ('MAPPED', 'MISSING')),
    CONSTRAINT chk_inventarios_stock_recon_location
        CHECK (location_resolution_status IN ('RESOLVED', 'UNRESOLVED_RECOUNT')),
    CONSTRAINT chk_inventarios_stock_recon_status
        CHECK (reconciliation_status IN ('PENDING', 'READY', 'MISMATCH', 'BLOCKED', 'STALE', 'APPLIED')),
    CONSTRAINT chk_inventarios_stock_recon_difference
        CHECK (difference_quantity IS NULL OR difference_quantity = inventory_physical_quantity - bsale_quantity)
);

CREATE INDEX idx_inventarios_stock_recon_version
    ON inventarios.inventory_stock_reconciliations(company_id, official_version_id);

CREATE INDEX idx_inventarios_stock_recon_status
    ON inventarios.inventory_stock_reconciliations(company_id, reconciliation_status);

ALTER TABLE inventarios.inventory_stock_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_stock_reconciliations FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.refresh_inventory_stock_reconciliation(
    p_company_id uuid,
    p_official_version_id uuid,
    p_bsale_sync_run_id uuid DEFAULT NULL
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
    v_session_status text;
    v_run_id uuid;
    v_run_completed_at timestamptz;
    v_product_count bigint;
    v_ready_count bigint;
    v_mismatch_count bigint;
    v_blocked_count bigint;
    v_pending_count bigint;
BEGIN
    IF p_company_id IS NULL OR p_official_version_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');

    SELECT s.status
    INTO v_session_status
    FROM inventarios.official_versions ov
    JOIN inventarios.sessions s
      ON s.company_id = ov.company_id AND s.id = ov.session_id
    WHERE ov.company_id = p_company_id AND ov.id = p_official_version_id;

    IF v_session_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_OFFICIAL_VERSION_NOT_FOUND';
    END IF;
    IF v_session_status <> 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_OFFICIAL_VERSION_NOT_APPROVED';
    END IF;

    IF p_bsale_sync_run_id IS NULL THEN
        SELECT r.id, coalesce(r.completed_at, r.started_at)
        INTO v_run_id, v_run_completed_at
        FROM integraciones.bsale_sync_runs r
        WHERE r.company_id = p_company_id AND r.status = 'COMPLETED'
        ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
        LIMIT 1;
    ELSE
        SELECT r.id, coalesce(r.completed_at, r.started_at)
        INTO v_run_id, v_run_completed_at
        FROM integraciones.bsale_sync_runs r
        WHERE r.company_id = p_company_id
          AND r.id = p_bsale_sync_run_id
          AND r.status = 'COMPLETED';
        IF v_run_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_BSALE_SYNC_RUN_NOT_COMPLETED';
        END IF;
    END IF;

    INSERT INTO inventarios.inventory_stock_reconciliations (
        company_id, official_version_id, official_version_item_id, session_id,
        snapshot_id, snapshot_product_id, bsale_variant_id,
        inventory_physical_quantity, bsale_quantity, difference_quantity,
        mapping_status, location_resolution_status, reconciliation_status,
        bsale_sync_run_id, bsale_synced_at, created_at, updated_at
    )
    SELECT
        oi.company_id, oi.official_version_id, oi.id, oi.session_id,
        oi.snapshot_id, oi.snapshot_product_id, oi.bsale_variant_id,
        oi.physical_quantity,
        stock.bsale_quantity,
        CASE WHEN stock.bsale_quantity IS NULL THEN NULL
             ELSE oi.physical_quantity - stock.bsale_quantity END,
        CASE WHEN bv.bsale_id IS NULL THEN 'MISSING' ELSE 'MAPPED' END,
        oi.location_resolution_status,
        CASE
            WHEN oi.location_resolution_status <> 'RESOLVED' THEN 'BLOCKED'
            WHEN bv.bsale_id IS NULL OR stock.has_stock IS DISTINCT FROM true THEN 'PENDING'
            WHEN oi.physical_quantity = stock.bsale_quantity THEN 'READY'
            ELSE 'MISMATCH'
        END,
        v_run_id,
        coalesce(stock.bsale_synced_at, v_run_completed_at),
        now(), now()
    FROM inventarios.official_version_items oi
    LEFT JOIN integraciones.bsale_variants bv
      ON bv.company_id = oi.company_id AND bv.bsale_id = oi.bsale_variant_id
    LEFT JOIN (
        SELECT
            sc.company_id,
            sc.variant_id,
            true AS has_stock,
            sum(sc.quantity) AS bsale_quantity,
            max(sc.synced_at) AS bsale_synced_at
        FROM integraciones.bsale_stock_current sc
        WHERE sc.company_id = p_company_id
          AND (v_run_id IS NULL OR sc.bsale_sync_run_id = v_run_id)
        GROUP BY sc.company_id, sc.variant_id
    ) stock
      ON stock.company_id = oi.company_id AND stock.variant_id = oi.bsale_variant_id
    WHERE oi.company_id = p_company_id
      AND oi.official_version_id = p_official_version_id
    ON CONFLICT (company_id, official_version_id, official_version_item_id)
    DO UPDATE SET
        session_id = EXCLUDED.session_id,
        snapshot_id = EXCLUDED.snapshot_id,
        snapshot_product_id = EXCLUDED.snapshot_product_id,
        bsale_variant_id = EXCLUDED.bsale_variant_id,
        inventory_physical_quantity = EXCLUDED.inventory_physical_quantity,
        bsale_quantity = EXCLUDED.bsale_quantity,
        difference_quantity = EXCLUDED.difference_quantity,
        mapping_status = EXCLUDED.mapping_status,
        location_resolution_status = EXCLUDED.location_resolution_status,
        reconciliation_status = EXCLUDED.reconciliation_status,
        bsale_sync_run_id = EXCLUDED.bsale_sync_run_id,
        bsale_synced_at = EXCLUDED.bsale_synced_at,
        updated_at = now();

    SELECT count(*) INTO v_product_count
    FROM inventarios.inventory_stock_reconciliations r
    WHERE r.company_id = p_company_id AND r.official_version_id = p_official_version_id;
    SELECT count(*) FILTER (WHERE r.reconciliation_status = 'READY'),
           count(*) FILTER (WHERE r.reconciliation_status = 'MISMATCH'),
           count(*) FILTER (WHERE r.reconciliation_status = 'BLOCKED'),
           count(*) FILTER (WHERE r.reconciliation_status = 'PENDING')
    INTO v_ready_count, v_mismatch_count, v_blocked_count, v_pending_count
    FROM inventarios.inventory_stock_reconciliations r
    WHERE r.company_id = p_company_id AND r.official_version_id = p_official_version_id;

    RETURN jsonb_build_object(
        'official_version_id', p_official_version_id,
        'bsale_sync_run_id', v_run_id,
        'product_count', v_product_count,
        'ready_count', v_ready_count,
        'mismatch_count', v_mismatch_count,
        'blocked_count', v_blocked_count,
        'pending_count', v_pending_count,
        'refreshed_by', v_actor_id,
        'refreshed_at', now()
    );
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_stock_reconciliation_products(
    p_company_id uuid,
    p_official_version_id uuid
)
RETURNS TABLE (
    id uuid,
    official_version_id uuid,
    official_version_item_id uuid,
    snapshot_product_id uuid,
    bsale_variant_id integer,
    inventory_physical_quantity numeric,
    bsale_quantity numeric,
    difference_quantity numeric,
    mapping_status text,
    location_resolution_status text,
    reconciliation_status text,
    stored_bsale_sync_run_id uuid,
    latest_bsale_sync_run_id uuid,
    bsale_synced_at timestamptz
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    RETURN QUERY
    SELECT r.id,
           r.official_version_id,
           r.official_version_item_id,
           r.snapshot_product_id,
           r.bsale_variant_id,
           r.inventory_physical_quantity,
           r.bsale_quantity,
           r.difference_quantity,
           r.mapping_status,
           r.location_resolution_status,
           CASE
               WHEN r.reconciliation_status <> 'APPLIED'
                AND r.bsale_sync_run_id IS NOT NULL
                AND latest.id IS NOT NULL
                AND r.bsale_sync_run_id IS DISTINCT FROM latest.id
               THEN 'STALE'
               ELSE r.reconciliation_status
           END,
           r.bsale_sync_run_id,
           latest.id,
           r.bsale_synced_at
    FROM inventarios.inventory_stock_reconciliations r
    LEFT JOIN LATERAL (
        SELECT sr.id
        FROM integraciones.bsale_sync_runs sr
        WHERE sr.company_id = r.company_id AND sr.status = 'COMPLETED'
        ORDER BY sr.completed_at DESC NULLS LAST, sr.started_at DESC NULLS LAST, sr.id DESC
        LIMIT 1
    ) latest ON true
    WHERE r.company_id = p_company_id
      AND r.official_version_id = p_official_version_id
    ORDER BY r.bsale_variant_id, r.id;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_stock_reconciliation_summary(
    p_company_id uuid,
    p_official_version_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_product_count bigint;
    v_pending_count bigint;
    v_ready_count bigint;
    v_mismatch_count bigint;
    v_blocked_count bigint;
    v_stale_count bigint;
    v_applied_count bigint;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    SELECT count(*),
           count(*) FILTER (WHERE x.status = 'PENDING'),
           count(*) FILTER (WHERE x.status = 'READY'),
           count(*) FILTER (WHERE x.status = 'MISMATCH'),
           count(*) FILTER (WHERE x.status = 'BLOCKED'),
           count(*) FILTER (WHERE x.status = 'STALE'),
           count(*) FILTER (WHERE x.status = 'APPLIED')
    INTO v_product_count, v_pending_count, v_ready_count, v_mismatch_count,
         v_blocked_count, v_stale_count, v_applied_count
    FROM (
        SELECT p.reconciliation_status AS status
        FROM inventarios.list_inventory_stock_reconciliation_products(
            p_company_id, p_official_version_id
        ) p
    ) x;

    RETURN jsonb_build_object(
        'official_version_id', p_official_version_id,
        'product_count', v_product_count,
        'pending_count', v_pending_count,
        'ready_count', v_ready_count,
        'mismatch_count', v_mismatch_count,
        'blocked_count', v_blocked_count,
        'stale_count', v_stale_count,
        'applied_count', v_applied_count,
        'read_by', v_actor_id,
        'read_at', now()
    );
END;
$function$;

ALTER FUNCTION inventarios.refresh_inventory_stock_reconciliation(uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.refresh_inventory_stock_reconciliation(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION inventarios.refresh_inventory_stock_reconciliation(uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_stock_reconciliation_products(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_stock_reconciliation_summary(uuid, uuid) TO authenticated, service_role;
