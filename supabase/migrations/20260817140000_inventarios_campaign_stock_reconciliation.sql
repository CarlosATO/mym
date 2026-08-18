-- Conciliacion global por Inventario/campaign.
-- Las official_versions siguen siendo fuentes inmutables por jornada.
-- Esta migracion no aplica Logistica ni escribe en Kardex.

CREATE TABLE inventarios.inventory_campaign_reconciliations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'BLOCKED',
    latest_bsale_sync_run_id uuid,
    latest_bsale_synced_at timestamptz,
    last_refreshed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_reconciliation_campaign
        UNIQUE (company_id, campaign_id),
    CONSTRAINT fk_inventarios_campaign_reconciliation_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_campaign_reconciliation_status
        CHECK (status IN ('READY', 'PARTIALLY_APPLIED', 'APPLIED', 'BLOCKED'))
);

CREATE TABLE inventarios.inventory_campaign_reconciliation_sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    reconciliation_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_reconciliations(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    official_version_id uuid,
    snapshot_id uuid,
    warehouse_id uuid,
    bsale_office_id integer,
    source_status text NOT NULL,
    block_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
    excluded_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_reconciliation_source_session
        UNIQUE (company_id, reconciliation_id, session_id),
    CONSTRAINT chk_inventarios_campaign_reconciliation_source_status
        CHECK (source_status IN ('INCLUDED', 'BLOCKED', 'CANCELLED_EXCLUDED')),
    CONSTRAINT chk_inventarios_campaign_reconciliation_source_reasons
        CHECK (block_reasons <@ ARRAY[
            'CAMPAIGN_NOT_APPROVED',
            'SOURCE_SESSION_NOT_APPROVED',
            'MISSING_OFFICIAL_VERSION',
            'MULTIPLE_CURRENT_OFFICIAL_VERSIONS',
            'UNRESOLVED_RECOUNT',
            'UNMAPPED_PRODUCT',
            'UNMAPPED_LOCATION',
            'INACTIVE_LOCATION',
            'NON_AVAILABLE_PHYSICAL_STOCK',
            'LOT_OR_EXPIRY_UNSUPPORTED',
            'UNREPRESENTED_LOGISTICS_STOCK',
            'MISSING_OFFICIAL_LOCATION',
            'LOCATION_OUT_OF_SCOPE',
            'DUPLICATE_LOGISTICS_LOCATION',
            'BSALE_STOCK_UNAVAILABLE',
            'BSALE_STALE',
            'RECONCILIATION_NOT_READY'
        ]::text[])
);

CREATE TABLE inventarios.inventory_campaign_reconciliation_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    reconciliation_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_reconciliations(id) ON DELETE CASCADE,
    bsale_variant_id integer NOT NULL,
    bsale_office_id integer NOT NULL,
    physical_quantity numeric(14,3) NOT NULL DEFAULT 0,
    bsale_quantity numeric(14,3),
    difference_quantity numeric(14,3),
    reconciliation_status text NOT NULL DEFAULT 'BLOCKED',
    logistics_applicability_status text NOT NULL DEFAULT 'BLOCKED',
    logistics_block_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
    bsale_sync_run_id uuid,
    bsale_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_reconciliation_item
        UNIQUE (company_id, reconciliation_id, bsale_variant_id, bsale_office_id),
    CONSTRAINT chk_inventarios_campaign_reconciliation_item_status
        CHECK (reconciliation_status IN ('READY', 'MISMATCH', 'BLOCKED', 'STALE', 'APPLIED')),
    CONSTRAINT chk_inventarios_campaign_reconciliation_item_logistics_status
        CHECK (logistics_applicability_status IN ('READY', 'BLOCKED')),
    CONSTRAINT chk_inventarios_campaign_reconciliation_item_difference
        CHECK (difference_quantity IS NULL OR difference_quantity = physical_quantity - bsale_quantity),
    CONSTRAINT chk_inventarios_campaign_reconciliation_item_reasons
        CHECK (logistics_block_reasons <@ ARRAY[
            'CAMPAIGN_NOT_APPROVED',
            'SOURCE_SESSION_NOT_APPROVED',
            'MISSING_OFFICIAL_VERSION',
            'MULTIPLE_CURRENT_OFFICIAL_VERSIONS',
            'UNRESOLVED_RECOUNT',
            'UNMAPPED_PRODUCT',
            'UNMAPPED_LOCATION',
            'INACTIVE_LOCATION',
            'NON_AVAILABLE_PHYSICAL_STOCK',
            'LOT_OR_EXPIRY_UNSUPPORTED',
            'UNREPRESENTED_LOGISTICS_STOCK',
            'MISSING_OFFICIAL_LOCATION',
            'LOCATION_OUT_OF_SCOPE',
            'DUPLICATE_LOGISTICS_LOCATION',
            'BSALE_STOCK_UNAVAILABLE',
            'BSALE_STALE',
            'RECONCILIATION_NOT_READY'
        ]::text[])
);

CREATE TABLE inventarios.inventory_campaign_reconciliation_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    reconciliation_item_id uuid NOT NULL REFERENCES inventarios.inventory_campaign_reconciliation_items(id) ON DELETE CASCADE,
    session_id uuid NOT NULL,
    official_version_id uuid NOT NULL,
    official_version_item_id uuid NOT NULL,
    official_version_location_item_id uuid NOT NULL,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    snapshot_location_id uuid,
    warehouse_id uuid,
    logistics_location_id uuid,
    physical_quantity numeric(14,3) NOT NULL,
    available_quantity numeric(14,3),
    damaged_quantity numeric(14,3),
    expired_quantity numeric(14,3),
    blocked_quantity numeric(14,3),
    other_unavailable_quantity numeric(14,3),
    line_status text NOT NULL DEFAULT 'BLOCKED',
    block_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_inventarios_campaign_reconciliation_line
        UNIQUE (company_id, reconciliation_item_id, official_version_location_item_id),
    CONSTRAINT chk_inventarios_campaign_reconciliation_line_status
        CHECK (line_status IN ('READY', 'BLOCKED')),
    CONSTRAINT chk_inventarios_campaign_reconciliation_line_reasons
        CHECK (block_reasons <@ ARRAY[
            'UNRESOLVED_RECOUNT',
            'UNMAPPED_PRODUCT',
            'UNMAPPED_LOCATION',
            'INACTIVE_LOCATION',
            'NON_AVAILABLE_PHYSICAL_STOCK',
            'LOT_OR_EXPIRY_UNSUPPORTED',
            'UNREPRESENTED_LOGISTICS_STOCK',
            'MISSING_OFFICIAL_LOCATION',
            'LOCATION_OUT_OF_SCOPE',
            'DUPLICATE_LOGISTICS_LOCATION'
        ]::text[])
);

CREATE INDEX idx_inventarios_campaign_reconciliation_sources
    ON inventarios.inventory_campaign_reconciliation_sources(company_id, reconciliation_id, source_status);
CREATE INDEX idx_inventarios_campaign_reconciliation_items
    ON inventarios.inventory_campaign_reconciliation_items(company_id, reconciliation_id, reconciliation_status);
CREATE INDEX idx_inventarios_campaign_reconciliation_lines
    ON inventarios.inventory_campaign_reconciliation_lines(company_id, reconciliation_item_id);

ALTER TABLE inventarios.inventory_campaign_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_reconciliation_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.inventory_campaign_reconciliation_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_campaign_reconciliations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE inventarios.inventory_campaign_reconciliation_sources FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE inventarios.inventory_campaign_reconciliation_items FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE inventarios.inventory_campaign_reconciliation_lines FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios.refresh_inventory_campaign_stock_reconciliation(
    p_company_id uuid,
    p_campaign_id uuid
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
    v_campaign_status text;
    v_latest_run_id uuid;
    v_latest_synced_at timestamptz;
    v_item record;
    v_recon_reasons text[];
    v_logistics_reasons text[];
    v_bsale_quantity numeric;
    v_bsale_exists boolean;
    v_latest_run_matches boolean;
    v_product_id uuid;
    v_item_status text;
    v_logistics_status text;
    v_applied_count bigint;
    v_pending_count bigint;
    v_ready_count bigint;
    v_blocked_count bigint;
    v_mismatch_count bigint;
    v_stale_count bigint;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_INVALID_REQUEST_PAYLOAD';
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.refresh_inventory_campaign_stock_reconciliation'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_campaign_id::text)
    );

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = p_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_NOT_FOUND';
    END IF;
    IF v_campaign_status <> 'APPROVED' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_NOT_APPROVED';
    END IF;

    SELECT r.id INTO v_latest_run_id
    FROM integraciones.bsale_sync_runs r
    WHERE r.company_id = p_company_id AND r.status = 'COMPLETED'
    ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
    LIMIT 1;
    SELECT coalesce(r.completed_at, r.started_at) INTO v_latest_synced_at
    FROM integraciones.bsale_sync_runs r WHERE r.id = v_latest_run_id;

    INSERT INTO inventarios.inventory_campaign_reconciliations (
        company_id, campaign_id, status, latest_bsale_sync_run_id,
        latest_bsale_synced_at, last_refreshed_at, created_at, updated_at
    ) VALUES (
        p_company_id, p_campaign_id, 'BLOCKED', v_latest_run_id,
        v_latest_synced_at, now(), now(), now()
    )
    ON CONFLICT (company_id, campaign_id) DO UPDATE SET
        latest_bsale_sync_run_id = EXCLUDED.latest_bsale_sync_run_id,
        latest_bsale_synced_at = EXCLUDED.latest_bsale_synced_at,
        last_refreshed_at = now(), updated_at = now();

    SELECT r.id INTO v_reconciliation_id
    FROM inventarios.inventory_campaign_reconciliations r
    WHERE r.company_id = p_company_id AND r.campaign_id = p_campaign_id;

    INSERT INTO inventarios.inventory_campaign_reconciliation_sources (
        company_id, reconciliation_id, session_id, official_version_id, snapshot_id,
        warehouse_id, bsale_office_id, source_status, block_reasons, excluded_at, updated_at
    )
    SELECT
        s.company_id, v_reconciliation_id, s.id,
        CASE WHEN ov.current_count = 1 THEN ov.official_version_id ELSE NULL END,
        CASE WHEN ov.current_count = 1 THEN ov.snapshot_id ELSE NULL END,
        s.warehouse_id, s.bsale_office_id,
        CASE
            WHEN s.status = 'CANCELLED' THEN 'CANCELLED_EXCLUDED'
            WHEN s.status = 'APPROVED' AND ov.current_count = 1 THEN 'INCLUDED'
            ELSE 'BLOCKED'
        END,
        CASE
            WHEN s.status = 'CANCELLED' THEN ARRAY[]::text[]
            WHEN s.status <> 'APPROVED' THEN ARRAY['SOURCE_SESSION_NOT_APPROVED']::text[]
            WHEN ov.current_count = 0 THEN ARRAY['MISSING_OFFICIAL_VERSION']::text[]
            WHEN ov.current_count > 1 THEN ARRAY['MULTIPLE_CURRENT_OFFICIAL_VERSIONS']::text[]
            ELSE ARRAY[]::text[]
        END,
        CASE WHEN s.status = 'CANCELLED' THEN now() ELSE NULL END,
        now()
    FROM inventarios.sessions s
    LEFT JOIN LATERAL (
        SELECT count(*)::integer AS current_count,
               max(ov.id) AS official_version_id,
               max(ov.snapshot_id) AS snapshot_id
        FROM inventarios.official_versions ov
        WHERE ov.company_id = s.company_id
          AND ov.session_id = s.id
          AND ov.superseded_at IS NULL
    ) ov ON true
    WHERE s.company_id = p_company_id AND s.campaign_id = p_campaign_id
    ON CONFLICT (company_id, reconciliation_id, session_id) DO UPDATE SET
        official_version_id = EXCLUDED.official_version_id,
        snapshot_id = EXCLUDED.snapshot_id,
        warehouse_id = EXCLUDED.warehouse_id,
        bsale_office_id = EXCLUDED.bsale_office_id,
        source_status = EXCLUDED.source_status,
        block_reasons = EXCLUDED.block_reasons,
        excluded_at = EXCLUDED.excluded_at,
        updated_at = now();

    -- Rebuild only the non-applied part. Applied items and their lines remain frozen.
    DELETE FROM inventarios.inventory_campaign_reconciliation_items i
    WHERE i.company_id = p_company_id
      AND i.reconciliation_id = v_reconciliation_id
      AND i.reconciliation_status <> 'APPLIED';

    INSERT INTO inventarios.inventory_campaign_reconciliation_items (
        company_id, reconciliation_id, bsale_variant_id, bsale_office_id,
        physical_quantity, bsale_quantity, difference_quantity,
        reconciliation_status, logistics_applicability_status,
        logistics_block_reasons, bsale_sync_run_id, bsale_synced_at
    )
    WITH source_items AS (
        SELECT src.session_id, src.official_version_id, src.bsale_office_id,
               oi.bsale_variant_id,
               CASE WHEN src.source_status = 'INCLUDED' THEN oi.physical_quantity ELSE 0 END AS physical_quantity
        FROM inventarios.inventory_campaign_reconciliation_sources src
        JOIN inventarios.official_version_items oi
          ON oi.company_id = src.company_id
         AND oi.official_version_id = src.official_version_id
        WHERE src.company_id = p_company_id
          AND src.reconciliation_id = v_reconciliation_id
          AND src.source_status IN ('INCLUDED', 'BLOCKED')
          AND src.official_version_id IS NOT NULL
        UNION ALL
        SELECT src.session_id, NULL, src.bsale_office_id,
               sps.bsale_variant_id, 0
        FROM inventarios.inventory_campaign_reconciliation_sources src
        JOIN inventarios.session_product_scopes sps
          ON sps.company_id = src.company_id AND sps.session_id = src.session_id
        WHERE src.company_id = p_company_id
          AND src.reconciliation_id = v_reconciliation_id
          AND src.source_status = 'BLOCKED'
          AND src.official_version_id IS NULL
    ), grouped AS (
        SELECT bsale_variant_id, bsale_office_id, sum(physical_quantity) AS physical_quantity
        FROM source_items
        GROUP BY bsale_variant_id, bsale_office_id
    )
    SELECT p_company_id, v_reconciliation_id, g.bsale_variant_id, g.bsale_office_id,
           g.physical_quantity, stock.bsale_quantity,
           CASE WHEN stock.bsale_quantity IS NULL THEN NULL
                ELSE g.physical_quantity - stock.bsale_quantity END,
           'BLOCKED', 'BLOCKED', ARRAY[]::text[], v_latest_run_id, v_latest_synced_at
    FROM grouped g
    LEFT JOIN LATERAL (
        SELECT sum(sc.quantity) AS bsale_quantity
        FROM integraciones.bsale_stock_current sc
        WHERE sc.company_id = p_company_id
          AND sc.variant_id = g.bsale_variant_id
          AND sc.office_id = g.bsale_office_id
          AND sc.bsale_sync_run_id = v_latest_run_id
    ) stock ON true
    ON CONFLICT (company_id, reconciliation_id, bsale_variant_id, bsale_office_id) DO NOTHING;

    -- Materialize every official location below its campaign item.
    INSERT INTO inventarios.inventory_campaign_reconciliation_lines (
        company_id, reconciliation_item_id, session_id, official_version_id,
        official_version_item_id, official_version_location_item_id, snapshot_id,
        snapshot_product_id, snapshot_location_id, warehouse_id, logistics_location_id,
        physical_quantity, available_quantity, damaged_quantity, expired_quantity,
        blocked_quantity, other_unavailable_quantity, line_status, block_reasons
    )
    SELECT
        src.company_id, item.id, src.session_id, src.official_version_id,
        oi.id, ovli.id, ovli.snapshot_id, ovli.snapshot_product_id,
        ovli.snapshot_location_id, src.warehouse_id, sl.location_id,
        ovli.physical_quantity, ovli.available_quantity, ovli.damaged_quantity,
        ovli.expired_quantity, ovli.blocked_quantity, ovli.other_unavailable_quantity,
        CASE WHEN cardinality(array_remove(ARRAY[
            CASE WHEN sl.location_id IS NULL THEN 'UNMAPPED_LOCATION' END,
            CASE WHEN l.is_active IS FALSE THEN 'INACTIVE_LOCATION' END,
            CASE WHEN oi.location_resolution_status <> 'RESOLVED' THEN 'UNRESOLVED_RECOUNT' END,
            CASE WHEN coalesce(ovli.available_quantity, 0) IS DISTINCT FROM ovli.physical_quantity
                       OR coalesce(ovli.damaged_quantity, 0) > 0
                       OR coalesce(ovli.expired_quantity, 0) > 0
                       OR coalesce(ovli.blocked_quantity, 0) > 0
                       OR coalesce(ovli.other_unavailable_quantity, 0) > 0
                 THEN 'NON_AVAILABLE_PHYSICAL_STOCK' END
        ]::text[], NULL)) = 0 THEN 'READY' ELSE 'BLOCKED' END,
        array_remove(ARRAY[
            CASE WHEN sl.location_id IS NULL THEN 'UNMAPPED_LOCATION' END,
            CASE WHEN l.is_active IS FALSE THEN 'INACTIVE_LOCATION' END,
            CASE WHEN oi.location_resolution_status <> 'RESOLVED' THEN 'UNRESOLVED_RECOUNT' END,
            CASE WHEN coalesce(ovli.available_quantity, 0) IS DISTINCT FROM ovli.physical_quantity
                       OR coalesce(ovli.damaged_quantity, 0) > 0
                       OR coalesce(ovli.expired_quantity, 0) > 0
                       OR coalesce(ovli.blocked_quantity, 0) > 0
                       OR coalesce(ovli.other_unavailable_quantity, 0) > 0
                 THEN 'NON_AVAILABLE_PHYSICAL_STOCK' END
        ]::text[], NULL)
    FROM inventarios.inventory_campaign_reconciliation_sources src
    JOIN inventarios.official_version_items oi
      ON oi.company_id = src.company_id AND oi.official_version_id = src.official_version_id
    JOIN inventarios.official_version_location_items ovli
      ON ovli.company_id = oi.company_id
     AND ovli.official_version_id = oi.official_version_id
     AND ovli.snapshot_product_id = oi.snapshot_product_id
    JOIN inventarios.inventory_campaign_reconciliation_items item
      ON item.company_id = src.company_id
     AND item.reconciliation_id = v_reconciliation_id
     AND item.bsale_variant_id = oi.bsale_variant_id
     AND item.bsale_office_id = src.bsale_office_id
     AND item.reconciliation_status <> 'APPLIED'
    LEFT JOIN inventarios.snapshot_locations sl
      ON sl.company_id = ovli.company_id
     AND sl.snapshot_id = ovli.snapshot_id
     AND sl.id = ovli.snapshot_location_id
    LEFT JOIN logistica.locations l
      ON l.company_id = src.company_id AND l.id = sl.location_id
    WHERE src.company_id = p_company_id
      AND src.reconciliation_id = v_reconciliation_id
      AND src.source_status = 'INCLUDED'
    ON CONFLICT (company_id, reconciliation_item_id, official_version_location_item_id) DO NOTHING;

    FOR v_item IN
        SELECT i.*
        FROM inventarios.inventory_campaign_reconciliation_items i
        WHERE i.company_id = p_company_id
          AND i.reconciliation_id = v_reconciliation_id
          AND i.reconciliation_status <> 'APPLIED'
    LOOP
        v_recon_reasons := ARRAY[]::text[];
        v_logistics_reasons := ARRAY[]::text[];

        SELECT coalesce(sum(sc.quantity), 0), count(*) > 0
        INTO v_bsale_quantity, v_bsale_exists
        FROM integraciones.bsale_stock_current sc
        WHERE sc.company_id = p_company_id
          AND sc.variant_id = v_item.bsale_variant_id
          AND sc.office_id = v_item.bsale_office_id
          AND sc.bsale_sync_run_id = v_latest_run_id;

        IF v_latest_run_id IS NULL OR NOT v_bsale_exists THEN
            v_recon_reasons := array_append(v_recon_reasons, 'BSALE_STOCK_UNAVAILABLE');
        ELSE
            UPDATE inventarios.inventory_campaign_reconciliation_items
            SET bsale_quantity = v_bsale_quantity,
                difference_quantity = physical_quantity - v_bsale_quantity,
                bsale_sync_run_id = v_latest_run_id,
                bsale_synced_at = v_latest_synced_at
            WHERE id = v_item.id;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_reconciliation_sources src
            WHERE src.reconciliation_id = v_reconciliation_id
              AND src.source_status = 'BLOCKED'
              AND src.bsale_office_id = v_item.bsale_office_id
              AND (
                  (src.official_version_id IS NOT NULL AND EXISTS (
                      SELECT 1 FROM inventarios.official_version_items oi
                      WHERE oi.company_id = src.company_id
                        AND oi.official_version_id = src.official_version_id
                        AND oi.bsale_variant_id = v_item.bsale_variant_id
                  ))
                  OR (src.official_version_id IS NULL AND EXISTS (
                      SELECT 1 FROM inventarios.session_product_scopes sps
                      WHERE sps.company_id = src.company_id
                        AND sps.session_id = src.session_id
                        AND sps.bsale_variant_id = v_item.bsale_variant_id
                  ))
              )
        ) THEN
            SELECT coalesce(array_agg(DISTINCT reason), ARRAY[]::text[])
            INTO v_recon_reasons
            FROM inventarios.inventory_campaign_reconciliation_sources src,
                 unnest(src.block_reasons) reason
            WHERE src.reconciliation_id = v_reconciliation_id
              AND src.source_status = 'BLOCKED'
              AND src.bsale_office_id = v_item.bsale_office_id;
        END IF;

        SELECT sp.product_id INTO v_product_id
        FROM inventarios.inventory_campaign_reconciliation_lines line
        JOIN inventarios.snapshot_products sp
          ON sp.company_id = line.company_id
         AND sp.snapshot_id = line.snapshot_id
         AND sp.id = line.snapshot_product_id
        WHERE line.reconciliation_item_id = v_item.id
        LIMIT 1;

        IF v_product_id IS NULL AND EXISTS (
            SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines
            WHERE reconciliation_item_id = v_item.id
        ) THEN
            v_logistics_reasons := array_append(v_logistics_reasons, 'UNMAPPED_PRODUCT');
        END IF;

        IF EXISTS (
            SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines
            WHERE reconciliation_item_id = v_item.id AND cardinality(block_reasons) > 0
        ) THEN
            SELECT coalesce(array_agg(DISTINCT reason), ARRAY[]::text[])
            INTO v_logistics_reasons
            FROM inventarios.inventory_campaign_reconciliation_lines line,
                 unnest(line.block_reasons) reason
            WHERE line.reconciliation_item_id = v_item.id;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_reconciliation_lines line
            WHERE line.reconciliation_item_id = v_item.id
              AND line.logistics_location_id IS NOT NULL
            GROUP BY line.logistics_location_id
            HAVING count(*) > 1
        ) THEN
            v_logistics_reasons := array_append(v_logistics_reasons, 'DUPLICATE_LOGISTICS_LOCATION');
        END IF;

        IF EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_reconciliation_sources src
            JOIN inventarios.official_version_items oi
              ON oi.company_id = src.company_id AND oi.official_version_id = src.official_version_id
            WHERE src.reconciliation_id = v_reconciliation_id
              AND src.source_status = 'INCLUDED'
              AND src.bsale_office_id = v_item.bsale_office_id
              AND oi.bsale_variant_id = v_item.bsale_variant_id
              AND oi.location_resolution_status <> 'RESOLVED'
        ) THEN
            v_logistics_reasons := array_append(v_logistics_reasons, 'UNRESOLVED_RECOUNT');
        END IF;

        IF v_product_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM (
                SELECT km.location_id, km.lot_number, km.expiration_date,
                       sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                THEN km.quantity ELSE -km.quantity END) AS balance
                FROM logistica.kardex_movements km
                WHERE km.company_id = p_company_id AND km.product_id = v_product_id
                GROUP BY km.location_id, km.lot_number, km.expiration_date
                HAVING sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                THEN km.quantity ELSE -km.quantity END) > 0
            ) stock
            WHERE stock.lot_number IS NOT NULL OR stock.expiration_date IS NOT NULL
        ) THEN
            v_logistics_reasons := array_append(v_logistics_reasons, 'LOT_OR_EXPIRY_UNSUPPORTED');
        END IF;

        IF v_product_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM (
                SELECT km.location_id,
                       sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                THEN km.quantity ELSE -km.quantity END) AS balance
                FROM logistica.kardex_movements km
                WHERE km.company_id = p_company_id AND km.product_id = v_product_id
                GROUP BY km.location_id
                HAVING sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                                THEN km.quantity ELSE -km.quantity END) > 0
            ) stock
            WHERE NOT EXISTS (
                SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines line
                WHERE line.reconciliation_item_id = v_item.id
                  AND line.logistics_location_id = stock.location_id
            )
        ) THEN
            v_logistics_reasons := array_append(v_logistics_reasons, 'UNREPRESENTED_LOGISTICS_STOCK');
        END IF;

        SELECT array_agg(DISTINCT reason) INTO v_logistics_reasons
        FROM unnest(v_logistics_reasons || CASE WHEN cardinality(v_recon_reasons) > 0 THEN ARRAY['RECONCILIATION_NOT_READY']::text[] ELSE ARRAY[]::text[] END) reason;
        v_logistics_reasons := coalesce(v_logistics_reasons, ARRAY[]::text[]);
        v_recon_reasons := coalesce(v_recon_reasons, ARRAY[]::text[]);

        IF cardinality(v_recon_reasons) > 0 THEN
            v_item_status := 'BLOCKED';
        ELSIF v_latest_run_id IS NULL OR NOT v_bsale_exists THEN
            v_item_status := 'BLOCKED';
        ELSIF v_item.physical_quantity IS DISTINCT FROM v_bsale_quantity THEN
            v_item_status := 'MISMATCH';
        ELSE
            v_item_status := 'READY';
        END IF;
        v_logistics_status := CASE WHEN cardinality(v_logistics_reasons) = 0 AND v_item_status = 'READY' THEN 'READY' ELSE 'BLOCKED' END;

        UPDATE inventarios.inventory_campaign_reconciliation_items
        SET bsale_quantity = CASE WHEN v_latest_run_id IS NULL OR NOT v_bsale_exists THEN NULL ELSE v_bsale_quantity END,
            difference_quantity = CASE WHEN v_latest_run_id IS NULL OR NOT v_bsale_exists THEN NULL ELSE physical_quantity - v_bsale_quantity END,
            reconciliation_status = v_item_status,
            logistics_applicability_status = v_logistics_status,
            logistics_block_reasons = v_logistics_reasons,
            bsale_sync_run_id = v_latest_run_id,
            bsale_synced_at = v_latest_synced_at,
            updated_at = now()
        WHERE id = v_item.id;
    END LOOP;

    SELECT count(*) FILTER (WHERE reconciliation_status = 'APPLIED'),
           count(*) FILTER (WHERE reconciliation_status = 'READY'),
           count(*) FILTER (WHERE reconciliation_status = 'BLOCKED'),
           count(*) FILTER (WHERE reconciliation_status = 'MISMATCH'),
           count(*) FILTER (WHERE reconciliation_status = 'STALE')
    INTO v_applied_count, v_ready_count, v_blocked_count, v_mismatch_count, v_stale_count
    FROM inventarios.inventory_campaign_reconciliation_items
    WHERE reconciliation_id = v_reconciliation_id;

    v_pending_count := v_ready_count + v_blocked_count + v_mismatch_count + v_stale_count;
    UPDATE inventarios.inventory_campaign_reconciliations
    SET status = CASE
        WHEN v_pending_count = 0 AND v_applied_count > 0 THEN 'APPLIED'
        WHEN v_applied_count > 0 THEN 'PARTIALLY_APPLIED'
        WHEN v_ready_count > 0 THEN 'READY'
        ELSE 'BLOCKED'
    END,
        updated_at = now()
    WHERE id = v_reconciliation_id;

    RETURN jsonb_build_object(
        'reconciliation_id', v_reconciliation_id,
        'campaign_id', p_campaign_id,
        'latest_bsale_sync_run_id', v_latest_run_id,
        'applied_count', v_applied_count,
        'ready_count', v_ready_count,
        'blocked_count', v_blocked_count,
        'mismatch_count', v_mismatch_count,
        'stale_count', v_stale_count,
        'refreshed_by', v_actor_id,
        'refreshed_at', now()
    );
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(
    p_company_id uuid,
    p_campaign_id uuid
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
    v_reconciliation_id uuid;
    v_payload jsonb;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    SELECT id INTO v_reconciliation_id
    FROM inventarios.inventory_campaign_reconciliations
    WHERE company_id = p_company_id AND campaign_id = p_campaign_id;
    SELECT jsonb_build_object(
        'reconciliation_id', v_reconciliation_id,
        'campaign_id', p_campaign_id,
        'status', r.status,
        'item_count', count(i.id),
        'ready_count', count(i.id) FILTER (WHERE i.reconciliation_status = 'READY'),
        'mismatch_count', count(i.id) FILTER (WHERE i.reconciliation_status = 'MISMATCH'),
        'blocked_count', count(i.id) FILTER (WHERE i.reconciliation_status = 'BLOCKED'),
        'stale_count', count(i.id) FILTER (WHERE i.reconciliation_status = 'STALE'),
        'applied_count', count(i.id) FILTER (WHERE i.reconciliation_status = 'APPLIED'),
        'logistics_ready_count', count(i.id) FILTER (WHERE i.logistics_applicability_status = 'READY'),
        'logistics_blocked_count', count(i.id) FILTER (WHERE i.logistics_applicability_status = 'BLOCKED'),
        'source_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources s WHERE s.reconciliation_id = v_reconciliation_id),
        'source_blocked_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources s WHERE s.reconciliation_id = v_reconciliation_id AND s.source_status = 'BLOCKED'),
        'source_cancelled_count', (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources s WHERE s.reconciliation_id = v_reconciliation_id AND s.source_status = 'CANCELLED_EXCLUDED'),
        'read_by', v_actor_id,
        'read_at', now()
    ) INTO v_payload
    FROM inventarios.inventory_campaign_reconciliations r
    LEFT JOIN inventarios.inventory_campaign_reconciliation_items i ON i.reconciliation_id = r.id
    WHERE r.id = v_reconciliation_id
    GROUP BY r.id, r.status;
    RETURN coalesce(v_payload, jsonb_build_object('reconciliation_id', NULL, 'campaign_id', p_campaign_id, 'item_count', 0));
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS TABLE (
    id uuid,
    reconciliation_id uuid,
    bsale_variant_id integer,
    bsale_office_id integer,
    physical_quantity numeric,
    bsale_quantity numeric,
    difference_quantity numeric,
    reconciliation_status text,
    logistics_applicability_status text,
    logistics_block_reasons text[],
    source_count bigint,
    line_count bigint,
    latest_bsale_sync_run_id uuid,
    bsale_synced_at timestamptz
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    PERFORM inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    RETURN QUERY
    SELECT i.id, i.reconciliation_id, i.bsale_variant_id, i.bsale_office_id,
           i.physical_quantity, i.bsale_quantity, i.difference_quantity,
           i.reconciliation_status, i.logistics_applicability_status,
           i.logistics_block_reasons,
           (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_sources s
            WHERE s.reconciliation_id = i.reconciliation_id
              AND s.bsale_office_id = i.bsale_office_id
              AND (s.source_status <> 'CANCELLED_EXCLUDED')),
           (SELECT count(*) FROM inventarios.inventory_campaign_reconciliation_lines l WHERE l.reconciliation_item_id = i.id),
           i.bsale_sync_run_id, i.bsale_synced_at
    FROM inventarios.inventory_campaign_reconciliation_items i
    JOIN inventarios.inventory_campaign_reconciliations r ON r.id = i.reconciliation_id
    WHERE i.company_id = p_company_id AND r.campaign_id = p_campaign_id
    ORDER BY i.bsale_variant_id, i.bsale_office_id, i.id;
END;
$function$;

CREATE OR REPLACE FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(
    p_company_id uuid,
    p_campaign_id uuid,
    p_item_id uuid
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
    v_item jsonb;
    v_sources jsonb;
    v_lines jsonb;
BEGIN
    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.sessions.read');
    SELECT to_jsonb(x) INTO v_item
    FROM (
        SELECT i.*
        FROM inventarios.inventory_campaign_reconciliation_items i
        JOIN inventarios.inventory_campaign_reconciliations r ON r.id = i.reconciliation_id
        WHERE i.company_id = p_company_id AND r.campaign_id = p_campaign_id AND i.id = p_item_id
    ) x;
    IF v_item IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_CAMPAIGN_RECONCILIATION_ITEM_NOT_FOUND';
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.session_id), '[]'::jsonb) INTO v_sources
    FROM (
        SELECT s.*
        FROM inventarios.inventory_campaign_reconciliation_sources s
        WHERE s.reconciliation_id = (v_item->>'reconciliation_id')::uuid
          AND s.bsale_office_id = (v_item->>'bsale_office_id')::integer
    ) x;
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.session_id, x.warehouse_id, x.logistics_location_id), '[]'::jsonb) INTO v_lines
    FROM (
        SELECT l.*
        FROM inventarios.inventory_campaign_reconciliation_lines l
        WHERE l.reconciliation_item_id = p_item_id
    ) x;
    RETURN jsonb_build_object('item', v_item, 'sources', v_sources, 'lines', v_lines, 'read_by', v_actor_id, 'read_at', now());
END;
$function$;

ALTER FUNCTION inventarios.refresh_inventory_campaign_stock_reconciliation(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.refresh_inventory_campaign_stock_reconciliation(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventarios.refresh_inventory_campaign_stock_reconciliation(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_summary(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_inventory_campaign_stock_reconciliation_items(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid) TO authenticated, service_role;
