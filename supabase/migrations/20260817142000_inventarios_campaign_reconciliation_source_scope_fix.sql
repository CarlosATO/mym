-- Ajusta el alcance de bloqueos de fuentes: solo afectan la variante/oficina
-- relacionada. No aplica Logistica ni modifica Kardex.

CREATE OR REPLACE FUNCTION inventarios.reconcile_inventory_campaign_item_source_scope()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_source_reasons text[];
    v_reasons text[];
    v_item_status text;
    v_logistics_reasons text[];
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    SELECT coalesce(array_agg(DISTINCT reason), ARRAY[]::text[])
    INTO v_source_reasons
    FROM inventarios.inventory_campaign_reconciliation_sources src,
         unnest(src.block_reasons) reason
    WHERE src.company_id = NEW.company_id
      AND src.reconciliation_id = NEW.reconciliation_id
      AND src.source_status = 'BLOCKED'
      AND src.bsale_office_id = NEW.bsale_office_id
      AND (
          (src.official_version_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM inventarios.official_version_items oi
              WHERE oi.company_id = src.company_id
                AND oi.official_version_id = src.official_version_id
                AND oi.bsale_variant_id = NEW.bsale_variant_id
          ))
          OR (src.official_version_id IS NULL AND EXISTS (
              SELECT 1 FROM inventarios.session_product_scopes sps
              WHERE sps.company_id = src.company_id
                AND sps.session_id = src.session_id
                AND sps.bsale_variant_id = NEW.bsale_variant_id
          ))
      );

    v_reasons := ARRAY(
        SELECT DISTINCT reason
        FROM unnest(coalesce(NEW.logistics_block_reasons, ARRAY[]::text[])) reason
        WHERE reason NOT IN (
            'SOURCE_SESSION_NOT_APPROVED',
            'MISSING_OFFICIAL_VERSION',
            'MULTIPLE_CURRENT_OFFICIAL_VERSIONS',
            'CAMPAIGN_NOT_APPROVED'
        )
    );
    v_reasons := coalesce(v_reasons, ARRAY[]::text[]);

    IF cardinality(v_source_reasons) > 0 THEN
        v_reasons := ARRAY(
            SELECT DISTINCT reason
            FROM unnest(v_reasons || v_source_reasons) reason
        );
    END IF;

    IF NEW.bsale_quantity IS NULL THEN
        v_item_status := 'BLOCKED';
    ELSIF cardinality(v_source_reasons) > 0 THEN
        v_item_status := 'BLOCKED';
    ELSIF NEW.physical_quantity IS DISTINCT FROM NEW.bsale_quantity THEN
        v_item_status := 'MISMATCH';
    ELSE
        v_item_status := 'READY';
    END IF;

    v_logistics_reasons := ARRAY(
        SELECT DISTINCT reason
        FROM unnest(v_reasons) reason
        WHERE reason <> 'RECONCILIATION_NOT_READY'
    );
    v_logistics_reasons := coalesce(v_logistics_reasons, ARRAY[]::text[]);
    IF v_item_status <> 'READY' THEN
        v_logistics_reasons := ARRAY(
            SELECT DISTINCT reason
            FROM unnest(v_logistics_reasons || ARRAY['RECONCILIATION_NOT_READY']::text[]) reason
        );
    END IF;

    UPDATE inventarios.inventory_campaign_reconciliation_items
    SET reconciliation_status = CASE WHEN NEW.reconciliation_status = 'APPLIED' THEN 'APPLIED' ELSE v_item_status END,
        logistics_applicability_status = CASE
            WHEN NEW.reconciliation_status = 'APPLIED' THEN NEW.logistics_applicability_status
            WHEN v_item_status = 'READY' AND cardinality(v_logistics_reasons) = 0 THEN 'READY'
            ELSE 'BLOCKED'
        END,
        logistics_block_reasons = v_logistics_reasons,
        updated_at = now()
    WHERE id = NEW.id
      AND NEW.reconciliation_status <> 'APPLIED';
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.reconcile_inventory_campaign_item_source_scope() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.reconcile_inventory_campaign_item_source_scope() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_reconcile_inventory_campaign_item_source_scope
    ON inventarios.inventory_campaign_reconciliation_items;
CREATE TRIGGER trg_reconcile_inventory_campaign_item_source_scope
AFTER UPDATE OF reconciliation_status, logistics_block_reasons, bsale_quantity, physical_quantity
ON inventarios.inventory_campaign_reconciliation_items
FOR EACH ROW
EXECUTE FUNCTION inventarios.reconcile_inventory_campaign_item_source_scope();
