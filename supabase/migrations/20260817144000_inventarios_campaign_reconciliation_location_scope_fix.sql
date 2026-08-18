-- Ajusta los guards de ubicacion al alcance de las jornadas del campaign.
-- Las ubicaciones fuera del scope del Inventario no bloquean sus items.

CREATE OR REPLACE FUNCTION inventarios.reconcile_inventory_campaign_item_location_scope()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_reasons text[];
    v_extra_reasons text[] := ARRAY[]::text[];
    v_product_id uuid;
    v_status text;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_reasons := ARRAY(
        SELECT DISTINCT reason
        FROM unnest(coalesce(NEW.logistics_block_reasons, ARRAY[]::text[])) reason
        WHERE reason NOT IN (
            'MISSING_OFFICIAL_LOCATION',
            'LOCATION_OUT_OF_SCOPE',
            'UNREPRESENTED_LOGISTICS_STOCK',
            'RECONCILIATION_NOT_READY'
        )
    );

    IF EXISTS (
        SELECT 1
        FROM inventarios.inventory_campaign_reconciliation_sources src
        JOIN inventarios.official_version_items oi
          ON oi.company_id = src.company_id AND oi.official_version_id = src.official_version_id
        JOIN inventarios.session_zone_locations szl
          ON szl.company_id = src.company_id AND szl.session_id = src.session_id
        WHERE src.reconciliation_id = NEW.reconciliation_id
          AND src.source_status = 'INCLUDED'
          AND src.bsale_office_id = NEW.bsale_office_id
          AND oi.bsale_variant_id = NEW.bsale_variant_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines line
              WHERE line.reconciliation_item_id = NEW.id
                AND line.session_id = src.session_id
                AND line.snapshot_location_id = szl.snapshot_location_id
          )
    ) THEN
        v_extra_reasons := array_append(v_extra_reasons, 'MISSING_OFFICIAL_LOCATION');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM inventarios.inventory_campaign_reconciliation_lines line
        JOIN inventarios.inventory_campaign_reconciliation_sources src
          ON src.reconciliation_id = NEW.reconciliation_id
         AND src.session_id = line.session_id
         AND src.source_status = 'INCLUDED'
        WHERE line.reconciliation_item_id = NEW.id
          AND src.bsale_office_id = NEW.bsale_office_id
          AND NOT EXISTS (
              SELECT 1 FROM inventarios.session_zone_locations szl
              WHERE szl.company_id = line.company_id
                AND szl.session_id = line.session_id
                AND szl.snapshot_location_id = line.snapshot_location_id
          )
    ) THEN
        v_extra_reasons := array_append(v_extra_reasons, 'LOCATION_OUT_OF_SCOPE');
    END IF;

    SELECT sp.product_id INTO v_product_id
    FROM inventarios.inventory_campaign_reconciliation_lines line
    JOIN inventarios.snapshot_products sp
      ON sp.company_id = line.company_id
     AND sp.snapshot_id = line.snapshot_id
     AND sp.id = line.snapshot_product_id
    WHERE line.reconciliation_item_id = NEW.id
    LIMIT 1;

    IF v_product_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM (
            SELECT km.location_id,
                   sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                            THEN km.quantity ELSE -km.quantity END) AS balance
            FROM logistica.kardex_movements km
            WHERE km.company_id = NEW.company_id AND km.product_id = v_product_id
            GROUP BY km.location_id
            HAVING sum(CASE WHEN km.movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT')
                            THEN km.quantity ELSE -km.quantity END) > 0
        ) stock
        WHERE EXISTS (
            SELECT 1
            FROM inventarios.inventory_campaign_reconciliation_sources src
            JOIN inventarios.session_zone_locations szl
              ON szl.company_id = src.company_id AND szl.session_id = src.session_id
            JOIN inventarios.official_version_items oi
              ON oi.company_id = src.company_id AND oi.official_version_id = src.official_version_id
            JOIN inventarios.snapshot_locations sl
              ON sl.company_id = szl.company_id
             AND sl.snapshot_id = szl.snapshot_id
             AND sl.id = szl.snapshot_location_id
            WHERE src.reconciliation_id = NEW.reconciliation_id
              AND src.source_status = 'INCLUDED'
              AND src.bsale_office_id = NEW.bsale_office_id
              AND oi.bsale_variant_id = NEW.bsale_variant_id
              AND sl.location_id = stock.location_id
        )
        AND NOT EXISTS (
            SELECT 1 FROM inventarios.inventory_campaign_reconciliation_lines line
            WHERE line.reconciliation_item_id = NEW.id
              AND line.logistics_location_id = stock.location_id
        )
    ) THEN
        v_extra_reasons := array_append(v_extra_reasons, 'UNREPRESENTED_LOGISTICS_STOCK');
    END IF;

    v_reasons := ARRAY(
        SELECT DISTINCT reason FROM unnest(v_reasons || v_extra_reasons) reason
    );
    v_reasons := coalesce(v_reasons, ARRAY[]::text[]);

    IF NEW.bsale_quantity IS NULL THEN
        v_status := 'BLOCKED';
    ELSIF cardinality(v_reasons) > 0 THEN
        v_status := 'BLOCKED';
    ELSIF NEW.physical_quantity IS DISTINCT FROM NEW.bsale_quantity THEN
        v_status := 'MISMATCH';
    ELSE
        v_status := 'READY';
    END IF;
    IF v_status <> 'READY' THEN
        v_reasons := ARRAY(
            SELECT DISTINCT reason FROM unnest(v_reasons || ARRAY['RECONCILIATION_NOT_READY']::text[]) reason
        );
    END IF;

    UPDATE inventarios.inventory_campaign_reconciliation_items
    SET reconciliation_status = CASE WHEN NEW.reconciliation_status = 'APPLIED' THEN 'APPLIED' ELSE v_status END,
        logistics_applicability_status = CASE
            WHEN NEW.reconciliation_status = 'APPLIED' THEN NEW.logistics_applicability_status
            WHEN v_status = 'READY' AND cardinality(v_reasons) = 0 THEN 'READY'
            ELSE 'BLOCKED'
        END,
        logistics_block_reasons = v_reasons,
        updated_at = now()
    WHERE id = NEW.id
      AND NEW.reconciliation_status <> 'APPLIED';
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.reconcile_inventory_campaign_item_location_scope() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.reconcile_inventory_campaign_item_location_scope() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_reconcile_inventory_campaign_item_location_scope
    ON inventarios.inventory_campaign_reconciliation_items;
CREATE TRIGGER trg_reconcile_inventory_campaign_item_location_scope
AFTER UPDATE OF reconciliation_status, logistics_block_reasons, bsale_quantity, physical_quantity
ON inventarios.inventory_campaign_reconciliation_items
FOR EACH ROW
EXECUTE FUNCTION inventarios.reconcile_inventory_campaign_item_location_scope();
