-- Aplicabilidad logistica V1 para conciliaciones existentes.
-- Solo modifica inventarios; logistica se consulta como fuente de lectura.

ALTER TABLE inventarios.inventory_stock_reconciliations
    ADD COLUMN IF NOT EXISTS logistics_applicability_status text NOT NULL DEFAULT 'BLOCKED',
    ADD COLUMN IF NOT EXISTS logistics_block_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD COLUMN IF NOT EXISTS logistics_scope_location_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS logistics_explicit_location_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS logistics_positive_stock_location_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS logistics_unrepresented_stock_location_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS logistics_missing_official_location_count integer NOT NULL DEFAULT 0;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_inventarios_stock_recon_logistics_status'
          AND conrelid = 'inventarios.inventory_stock_reconciliations'::regclass
    ) THEN
        ALTER TABLE inventarios.inventory_stock_reconciliations
            ADD CONSTRAINT chk_inventarios_stock_recon_logistics_status
            CHECK (logistics_applicability_status IN ('READY', 'BLOCKED'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_inventarios_stock_recon_logistics_reasons'
          AND conrelid = 'inventarios.inventory_stock_reconciliations'::regclass
    ) THEN
        ALTER TABLE inventarios.inventory_stock_reconciliations
            ADD CONSTRAINT chk_inventarios_stock_recon_logistics_reasons
            CHECK (logistics_block_reasons <@ ARRAY[
                'UNRESOLVED_RECOUNT',
                'UNMAPPED_LOCATION',
                'INACTIVE_LOCATION',
                'UNREPRESENTED_LOGISTICS_STOCK',
                'NON_AVAILABLE_PHYSICAL_STOCK',
                'LOT_OR_EXPIRY_UNSUPPORTED',
                'BSALE_STALE',
                'MISSING_OFFICIAL_LOCATION',
                'UNMAPPED_PRODUCT',
                'MULTIPLE_LOCATION_MAPPING',
                'LOCATION_OUT_OF_SCOPE',
                'RECONCILIATION_NOT_READY'
            ]::text[]);
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION inventarios.compute_inventory_logistics_v1_applicability(
    p_reconciliation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
WITH recon AS (
    SELECT r.*, oi.location_resolution_status AS item_location_resolution_status,
           sp.product_id
    FROM inventarios.inventory_stock_reconciliations r
    JOIN inventarios.official_version_items oi
      ON oi.company_id = r.company_id AND oi.id = r.official_version_item_id
    LEFT JOIN inventarios.snapshot_products sp
      ON sp.company_id = r.company_id
     AND sp.snapshot_id = r.snapshot_id
     AND sp.id = r.snapshot_product_id
    WHERE r.id = p_reconciliation_id
), scope_locations AS (
    SELECT DISTINCT
           szl.location_id AS zone_location_id,
           sl.location_id AS snapshot_location_id,
           l.id AS logistics_location_id,
           l.is_active
    FROM recon r
    JOIN inventarios.session_zone_locations szl
      ON szl.company_id = r.company_id AND szl.session_id = r.session_id
    LEFT JOIN inventarios.snapshot_locations sl
      ON sl.company_id = r.company_id
     AND sl.snapshot_id = r.snapshot_id
     AND sl.id = szl.snapshot_location_id
    LEFT JOIN logistica.locations l
      ON l.company_id = r.company_id AND l.id = sl.location_id
), explicit_locations AS (
    SELECT DISTINCT
           ovli.snapshot_location_id,
           sl.location_id AS logistics_location_id,
           l.is_active
    FROM recon r
    JOIN inventarios.official_version_location_items ovli
      ON ovli.company_id = r.company_id
     AND ovli.official_version_id = r.official_version_id
     AND ovli.snapshot_product_id = r.snapshot_product_id
    LEFT JOIN inventarios.snapshot_locations sl
      ON sl.company_id = r.company_id
     AND sl.snapshot_id = r.snapshot_id
     AND sl.id = ovli.snapshot_location_id
    LEFT JOIN logistica.locations l
      ON l.company_id = r.company_id AND l.id = sl.location_id
), positive_stock AS (
    SELECT km.location_id,
           sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                    THEN km.quantity ELSE -km.quantity END) AS balance,
           bool_or(km.lot_number IS NOT NULL OR km.expiration_date IS NOT NULL) AS has_lot_or_expiry
    FROM recon r
    JOIN logistica.kardex_movements km
      ON km.company_id = r.company_id
     AND km.product_id = r.product_id
    WHERE r.product_id IS NOT NULL
    GROUP BY km.location_id, km.lot_number, km.expiration_date
    HAVING sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                    THEN km.quantity ELSE -km.quantity END) > 0
), positive_stock_by_location AS (
    SELECT ps.location_id,
           sum(ps.balance) AS balance,
           bool_or(ps.has_lot_or_expiry) AS has_lot_or_expiry
    FROM positive_stock ps
    GROUP BY ps.location_id
), metrics AS (
    SELECT
        r.id,
        count(DISTINCT sl.snapshot_location_id) AS scope_count,
        count(DISTINCT sl.snapshot_location_id)
            FILTER (WHERE sl.snapshot_location_id IS NOT NULL AND sl.logistics_location_id IS NOT NULL) AS mapped_scope_count,
        count(DISTINCT el.snapshot_location_id) AS explicit_count,
        count(DISTINCT ps.location_id) AS positive_stock_count,
        count(DISTINCT ps.location_id)
            FILTER (WHERE el.logistics_location_id IS NULL) AS unrepresented_count,
        count(DISTINCT sl.snapshot_location_id)
            FILTER (WHERE el.snapshot_location_id IS NULL) AS missing_official_count,
        count(DISTINCT el.snapshot_location_id)
            FILTER (WHERE el.logistics_location_id IS NULL) AS unmapped_explicit_count,
        count(DISTINCT el.snapshot_location_id)
            FILTER (WHERE el.is_active IS FALSE AND el.logistics_location_id IS NOT NULL) AS inactive_explicit_count,
        count(DISTINCT ps.location_id)
            FILTER (WHERE l.is_active IS FALSE) AS inactive_stock_count,
        count(DISTINCT ps.location_id)
            FILTER (WHERE ps.has_lot_or_expiry) AS lot_expiry_count,
        count(*) FILTER (
            WHERE el.snapshot_location_id IS NOT NULL
              AND (
                  coalesce(ovi.available_quantity, 0) IS DISTINCT FROM ovi.physical_quantity
                  OR coalesce(ovi.damaged_quantity, 0) > 0
                  OR coalesce(ovi.expired_quantity, 0) > 0
                  OR coalesce(ovi.blocked_quantity, 0) > 0
                  OR coalesce(ovi.other_unavailable_quantity, 0) > 0
              )
        ) AS non_available_count,
        count(DISTINCT sl.snapshot_location_id)
            FILTER (WHERE sl.snapshot_location_id IS NULL OR sl.logistics_location_id IS NULL) AS unmapped_scope_count,
        count(DISTINCT el.snapshot_location_id)
            FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM scope_locations sl2
                WHERE sl2.snapshot_location_id = el.snapshot_location_id
            )) AS out_of_scope_explicit_count,
        count(DISTINCT isl.id) AS mapping_count,
        array_remove(ARRAY[
            CASE WHEN r.item_location_resolution_status <> 'RESOLVED' THEN 'UNRESOLVED_RECOUNT' END,
            CASE WHEN r.product_id IS NULL THEN 'UNMAPPED_PRODUCT' END,
            CASE WHEN count(DISTINCT sl.snapshot_location_id)
                          FILTER (WHERE sl.snapshot_location_id IS NULL OR sl.logistics_location_id IS NULL) > 0
                       OR count(DISTINCT el.snapshot_location_id)
                          FILTER (WHERE el.logistics_location_id IS NULL) > 0
                 THEN 'UNMAPPED_LOCATION' END,
            CASE WHEN count(DISTINCT el.snapshot_location_id)
                          FILTER (WHERE el.is_active IS FALSE AND el.logistics_location_id IS NOT NULL) > 0
                       OR count(DISTINCT ps.location_id) FILTER (WHERE l.is_active IS FALSE) > 0
                 THEN 'INACTIVE_LOCATION' END,
            CASE WHEN count(DISTINCT ps.location_id)
                          FILTER (WHERE el.logistics_location_id IS NULL) > 0
                 THEN 'UNREPRESENTED_LOGISTICS_STOCK' END,
            CASE WHEN count(DISTINCT sl.snapshot_location_id)
                          FILTER (WHERE el.snapshot_location_id IS NULL) > 0
                 THEN 'MISSING_OFFICIAL_LOCATION' END,
            CASE WHEN count(*) FILTER (
                          WHERE el.snapshot_location_id IS NOT NULL
                            AND (
                                coalesce(ovi.available_quantity, 0) IS DISTINCT FROM ovi.physical_quantity
                                OR coalesce(ovi.damaged_quantity, 0) > 0
                                OR coalesce(ovi.expired_quantity, 0) > 0
                                OR coalesce(ovi.blocked_quantity, 0) > 0
                                OR coalesce(ovi.other_unavailable_quantity, 0) > 0
                            )
                      ) > 0
                 THEN 'NON_AVAILABLE_PHYSICAL_STOCK' END,
            CASE WHEN count(DISTINCT ps.location_id) FILTER (WHERE ps.has_lot_or_expiry) > 0
                 THEN 'LOT_OR_EXPIRY_UNSUPPORTED' END,
            CASE WHEN r.bsale_sync_run_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM integraciones.bsale_sync_runs latest
                WHERE latest.company_id = r.company_id
                  AND latest.status = 'COMPLETED'
                  AND latest.id IS DISTINCT FROM r.bsale_sync_run_id
                  AND NOT EXISTS (
                      SELECT 1 FROM integraciones.bsale_sync_runs newer
                      WHERE newer.company_id = latest.company_id
                        AND newer.status = 'COMPLETED'
                        AND coalesce(newer.completed_at, newer.started_at) > coalesce(latest.completed_at, latest.started_at)
                  )
            ) THEN 'BSALE_STALE' END,
            CASE WHEN r.reconciliation_status <> 'READY' THEN 'RECONCILIATION_NOT_READY' END,
            CASE WHEN count(DISTINCT el.snapshot_location_id)
                          FILTER (WHERE NOT EXISTS (
                              SELECT 1 FROM scope_locations sl3
                              WHERE sl3.snapshot_location_id = el.snapshot_location_id
                          )) > 0
                 THEN 'LOCATION_OUT_OF_SCOPE' END
        ], NULL) AS reasons
    FROM recon r
    LEFT JOIN scope_locations sl ON true
    LEFT JOIN explicit_locations el ON true
    LEFT JOIN positive_stock_by_location ps
      ON ps.location_id = coalesce(el.logistics_location_id, sl.logistics_location_id)
    LEFT JOIN logistica.locations l
      ON l.company_id = r.company_id AND l.id = ps.location_id
    LEFT JOIN inventarios.official_version_location_items ovi
      ON ovi.company_id = r.company_id
     AND ovi.official_version_id = r.official_version_id
     AND ovi.snapshot_product_id = r.snapshot_product_id
     AND ovi.snapshot_location_id = el.snapshot_location_id
    LEFT JOIN inventarios.inventory_site_locations isl
      ON isl.company_id = r.company_id
     AND isl.source_logistics_location_id = coalesce(el.logistics_location_id, sl.logistics_location_id)
    GROUP BY r.id, r.item_location_resolution_status, r.product_id,
             r.bsale_sync_run_id, r.company_id, r.reconciliation_status
)
SELECT jsonb_build_object(
    'status', CASE WHEN cardinality(m.reasons) = 0 THEN 'READY' ELSE 'BLOCKED' END,
    'block_reasons', m.reasons,
    'scope_location_count', m.scope_count,
    'explicit_location_count', m.explicit_count,
    'positive_stock_location_count', m.positive_stock_count,
    'unrepresented_stock_location_count', m.unrepresented_count,
    'missing_official_location_count', m.missing_official_count
)
FROM metrics m;
$function$;

-- Reemplaza la primera implementacion por una version con metricas
-- independientes. El alcance, el resultado oficial y el Kardex no deben
-- cruzarse cartesianamente: cada uno se evalua como conjunto separado.
CREATE OR REPLACE FUNCTION inventarios.compute_inventory_logistics_v1_applicability(
    p_reconciliation_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
WITH recon AS (
    SELECT r.*, oi.location_resolution_status AS item_location_resolution_status,
           sp.product_id
    FROM inventarios.inventory_stock_reconciliations r
    JOIN inventarios.official_version_items oi
      ON oi.company_id = r.company_id AND oi.id = r.official_version_item_id
    LEFT JOIN inventarios.snapshot_products sp
      ON sp.company_id = r.company_id
     AND sp.snapshot_id = r.snapshot_id
     AND sp.id = r.snapshot_product_id
    WHERE r.id = p_reconciliation_id
), scope_locations AS (
    SELECT DISTINCT szl.snapshot_location_id,
           sl.location_id AS logistics_location_id,
           sl.source_logistics_location_id,
           l.is_active
    FROM recon r
    JOIN inventarios.session_zone_locations szl
      ON szl.company_id = r.company_id AND szl.session_id = r.session_id
    LEFT JOIN inventarios.snapshot_locations sl
      ON sl.company_id = r.company_id
     AND sl.snapshot_id = r.snapshot_id
     AND sl.id = szl.snapshot_location_id
    LEFT JOIN logistica.locations l
      ON l.company_id = r.company_id AND l.id = sl.location_id
), explicit_locations AS (
    SELECT DISTINCT ovli.snapshot_location_id,
           sl.location_id AS logistics_location_id,
           sl.source_logistics_location_id,
           l.is_active,
           ovli.available_quantity,
           ovli.damaged_quantity,
           ovli.expired_quantity,
           ovli.blocked_quantity,
           ovli.other_unavailable_quantity,
           ovli.physical_quantity
    FROM recon r
    JOIN inventarios.official_version_location_items ovli
      ON ovli.company_id = r.company_id
     AND ovli.official_version_id = r.official_version_id
     AND ovli.snapshot_product_id = r.snapshot_product_id
    LEFT JOIN inventarios.snapshot_locations sl
      ON sl.company_id = r.company_id
     AND sl.snapshot_id = r.snapshot_id
     AND sl.id = ovli.snapshot_location_id
    LEFT JOIN logistica.locations l
      ON l.company_id = r.company_id AND l.id = sl.location_id
), positive_stock AS (
    SELECT km.location_id, km.lot_number, km.expiration_date,
           sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                    THEN km.quantity ELSE -km.quantity END) AS balance
    FROM recon r
    JOIN logistica.kardex_movements km
      ON km.company_id = r.company_id AND km.product_id = r.product_id
    WHERE r.product_id IS NOT NULL
    GROUP BY km.location_id, km.lot_number, km.expiration_date
    HAVING sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                    THEN km.quantity ELSE -km.quantity END) > 0
), scoped_stock AS (
    SELECT ps.location_id,
           sum(ps.balance) AS balance,
           bool_or(ps.lot_number IS NOT NULL OR ps.expiration_date IS NOT NULL) AS has_lot_or_expiry,
           l.is_active
    FROM positive_stock ps
    JOIN scope_locations sl ON sl.logistics_location_id = ps.location_id
    LEFT JOIN logistica.locations l ON l.id = ps.location_id
    GROUP BY ps.location_id, l.is_active
), scope_metrics AS (
    SELECT
        count(*) AS scope_count,
        count(*) FILTER (WHERE sl.snapshot_location_id IS NOT NULL
                           AND sl.logistics_location_id IS NOT NULL) AS mapped_scope_count,
        count(*) FILTER (WHERE sl.snapshot_location_id IS NULL
                           OR sl.logistics_location_id IS NULL) AS unmapped_scope_count
    FROM scope_locations sl
), explicit_metrics AS (
    SELECT
        count(*) AS explicit_count,
        count(*) FILTER (WHERE el.snapshot_location_id IS NULL
                           OR el.logistics_location_id IS NULL) AS unmapped_explicit_count,
        count(*) FILTER (WHERE el.is_active IS FALSE
                           AND el.logistics_location_id IS NOT NULL) AS inactive_explicit_count,
        count(*) FILTER (WHERE el.source_logistics_location_id IS NOT NULL
                           AND el.source_logistics_location_id IS DISTINCT FROM el.logistics_location_id) AS mapping_conflict_count,
        count(*) FILTER (WHERE el.logistics_location_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1 FROM scope_locations sl
                               WHERE sl.logistics_location_id = el.logistics_location_id
                           )) AS out_of_scope_count,
        count(*) FILTER (WHERE el.available_quantity IS NULL
                           OR el.physical_quantity IS NULL
                           OR el.available_quantity IS DISTINCT FROM el.physical_quantity
                           OR coalesce(el.damaged_quantity, 0) > 0
                           OR coalesce(el.expired_quantity, 0) > 0
                           OR coalesce(el.blocked_quantity, 0) > 0
                           OR coalesce(el.other_unavailable_quantity, 0) > 0) AS non_available_count,
        count(*) FILTER (WHERE el.snapshot_location_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1 FROM scope_locations sl
                               WHERE sl.snapshot_location_id = el.snapshot_location_id
                           )) AS explicit_without_scope_count
    FROM explicit_locations el
), stock_metrics AS (
    SELECT
        count(*) AS positive_stock_count,
        count(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM explicit_locations el
            WHERE el.logistics_location_id = ss.location_id
        )) AS unrepresented_count,
        count(*) FILTER (WHERE ss.is_active IS FALSE) AS inactive_stock_count,
        count(*) FILTER (WHERE ss.has_lot_or_expiry) AS lot_expiry_count
    FROM scoped_stock ss
), latest_run AS (
    SELECT r.id
    FROM integraciones.bsale_sync_runs r
    JOIN recon x ON x.company_id = r.company_id
    WHERE r.status = 'COMPLETED'
    ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC NULLS LAST, r.id DESC
    LIMIT 1
), values_ AS (
    SELECT x.*,
           sm.scope_count, sm.mapped_scope_count, sm.unmapped_scope_count,
           em.explicit_count, em.unmapped_explicit_count, em.inactive_explicit_count,
           em.mapping_conflict_count, em.out_of_scope_count, em.non_available_count,
           em.explicit_without_scope_count,
           tm.positive_stock_count, tm.unrepresented_count, tm.inactive_stock_count,
           tm.lot_expiry_count,
           (lr.id IS NOT NULL AND x.bsale_sync_run_id IS DISTINCT FROM lr.id) AS bsale_stale,
           array_remove(ARRAY[
               CASE WHEN x.item_location_resolution_status <> 'RESOLVED' THEN 'UNRESOLVED_RECOUNT' END,
               CASE WHEN x.product_id IS NULL THEN 'UNMAPPED_PRODUCT' END,
               CASE WHEN sm.unmapped_scope_count > 0 OR em.unmapped_explicit_count > 0 THEN 'UNMAPPED_LOCATION' END,
               CASE WHEN em.mapping_conflict_count > 0 THEN 'MULTIPLE_LOCATION_MAPPING' END,
               CASE WHEN em.inactive_explicit_count > 0 OR tm.inactive_stock_count > 0 THEN 'INACTIVE_LOCATION' END,
               CASE WHEN tm.unrepresented_count > 0 THEN 'UNREPRESENTED_LOGISTICS_STOCK' END,
               CASE WHEN sm.scope_count > 0 AND em.explicit_count = 0 THEN 'MISSING_OFFICIAL_LOCATION'
                    WHEN EXISTS (
                        SELECT 1 FROM scope_locations sl
                        WHERE sl.snapshot_location_id IS NOT NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM explicit_locations el
                              WHERE el.snapshot_location_id = sl.snapshot_location_id
                          )
                    ) THEN 'MISSING_OFFICIAL_LOCATION' END,
               CASE WHEN em.non_available_count > 0 THEN 'NON_AVAILABLE_PHYSICAL_STOCK' END,
               CASE WHEN tm.lot_expiry_count > 0 THEN 'LOT_OR_EXPIRY_UNSUPPORTED' END,
               CASE WHEN lr.id IS NOT NULL AND x.bsale_sync_run_id IS DISTINCT FROM lr.id THEN 'BSALE_STALE' END,
               CASE WHEN x.reconciliation_status <> 'READY' THEN 'RECONCILIATION_NOT_READY' END,
               CASE WHEN em.out_of_scope_count > 0 OR em.explicit_without_scope_count > 0 THEN 'LOCATION_OUT_OF_SCOPE' END
           ], NULL) AS reasons
    FROM recon x
    CROSS JOIN scope_metrics sm
    CROSS JOIN explicit_metrics em
    CROSS JOIN stock_metrics tm
    LEFT JOIN latest_run lr ON true
)
SELECT jsonb_build_object(
    'status', CASE WHEN cardinality(v.reasons) = 0 THEN 'READY' ELSE 'BLOCKED' END,
    'block_reasons', v.reasons,
    'scope_location_count', v.scope_count,
    'explicit_location_count', v.explicit_count,
    'positive_stock_location_count', v.positive_stock_count,
    'unrepresented_stock_location_count', v.unrepresented_count,
    'missing_official_location_count', CASE
        WHEN v.scope_count = 0 THEN 0
        ELSE greatest(v.scope_count - v.explicit_count, 0)
    END
)
FROM values_ v;
$function$;

CREATE OR REPLACE FUNCTION inventarios.recalculate_inventory_logistics_v1_applicability()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_app jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    v_app := inventarios.compute_inventory_logistics_v1_applicability(NEW.id);
    UPDATE inventarios.inventory_stock_reconciliations r
    SET logistics_applicability_status = v_app->>'status',
        logistics_block_reasons = ARRAY(
            SELECT jsonb_array_elements_text(coalesce(v_app->'block_reasons', '[]'::jsonb))
        ),
        logistics_scope_location_count = (v_app->>'scope_location_count')::integer,
        logistics_explicit_location_count = (v_app->>'explicit_location_count')::integer,
        logistics_positive_stock_location_count = (v_app->>'positive_stock_location_count')::integer,
        logistics_unrepresented_stock_location_count = (v_app->>'unrepresented_stock_location_count')::integer,
        logistics_missing_official_location_count = (v_app->>'missing_official_location_count')::integer
    WHERE r.id = NEW.id;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.compute_inventory_logistics_v1_applicability(uuid) OWNER TO postgres;
ALTER FUNCTION inventarios.recalculate_inventory_logistics_v1_applicability() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.compute_inventory_logistics_v1_applicability(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION inventarios.recalculate_inventory_logistics_v1_applicability() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_recalculate_inventory_logistics_v1_applicability
    ON inventarios.inventory_stock_reconciliations;
CREATE TRIGGER trg_recalculate_inventory_logistics_v1_applicability
AFTER INSERT OR UPDATE OF reconciliation_status, location_resolution_status,
    bsale_sync_run_id, bsale_quantity, official_version_item_id
ON inventarios.inventory_stock_reconciliations
FOR EACH ROW
EXECUTE FUNCTION inventarios.recalculate_inventory_logistics_v1_applicability();

DO $backfill$
DECLARE
    v_row record;
    v_app jsonb;
BEGIN
    FOR v_row IN
        SELECT id FROM inventarios.inventory_stock_reconciliations
    LOOP
        v_app := inventarios.compute_inventory_logistics_v1_applicability(v_row.id);
        UPDATE inventarios.inventory_stock_reconciliations r
        SET logistics_applicability_status = v_app->>'status',
            logistics_block_reasons = ARRAY(
                SELECT jsonb_array_elements_text(coalesce(v_app->'block_reasons', '[]'::jsonb))
            ),
            logistics_scope_location_count = (v_app->>'scope_location_count')::integer,
            logistics_explicit_location_count = (v_app->>'explicit_location_count')::integer,
            logistics_positive_stock_location_count = (v_app->>'positive_stock_location_count')::integer,
            logistics_unrepresented_stock_location_count = (v_app->>'unrepresented_stock_location_count')::integer,
            logistics_missing_official_location_count = (v_app->>'missing_official_location_count')::integer
        WHERE r.id = v_row.id;
    END LOOP;
END;
$backfill$;
