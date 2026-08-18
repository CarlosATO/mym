-- Resultado oficial por ubicacion desde las contribuciones efectivas.
-- Solo afecta el esquema inventarios.

ALTER TABLE inventarios.official_version_items
    ADD COLUMN IF NOT EXISTS location_resolution_status text NOT NULL DEFAULT 'RESOLVED';

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_official_items_location_resolution'
          AND conrelid = 'inventarios.official_version_items'::regclass
    ) THEN
        ALTER TABLE inventarios.official_version_items
            ADD CONSTRAINT chk_official_items_location_resolution
            CHECK (location_resolution_status IN ('RESOLVED', 'UNRESOLVED_RECOUNT'));
    END IF;
END;
$migration$;

UPDATE inventarios.official_version_items oi
SET location_resolution_status = CASE
    WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(oi.contribution_manifest) manifest
        WHERE coalesce(manifest->>'contribution_source', manifest->>'source') = 'RECOUNT'
    ) OR EXISTS (
        SELECT 1
        FROM inventarios.inventory_audit_resolution_replaced_contributions replaced
        JOIN inventarios.count_entries ce
          ON ce.id = replaced.replaced_count_entry_id
        WHERE replaced.company_id = oi.company_id
          AND replaced.replaced_source = 'RECOUNT'
          AND ce.session_id = oi.session_id
          AND ce.snapshot_product_id = oi.snapshot_product_id
    ) THEN 'UNRESOLVED_RECOUNT'
    ELSE 'RESOLVED'
END;

CREATE OR REPLACE FUNCTION inventarios.resolve_official_item_location_status()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.contribution_manifest) manifest
        WHERE coalesce(manifest->>'contribution_source', manifest->>'source') = 'RECOUNT'
    ) OR EXISTS (
        SELECT 1
        FROM inventarios.inventory_audit_resolution_replaced_contributions replaced
        JOIN inventarios.count_entries ce
          ON ce.id = replaced.replaced_count_entry_id
        WHERE replaced.company_id = NEW.company_id
          AND replaced.replaced_source = 'RECOUNT'
          AND ce.session_id = NEW.session_id
          AND ce.snapshot_product_id = NEW.snapshot_product_id
    ) THEN
        NEW.location_resolution_status := 'UNRESOLVED_RECOUNT';
    ELSE
        NEW.location_resolution_status := 'RESOLVED';
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.resolve_official_item_location_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.resolve_official_item_location_status() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_resolve_official_item_location_status
    ON inventarios.official_version_items;

CREATE TRIGGER trg_resolve_official_item_location_status
BEFORE INSERT ON inventarios.official_version_items
FOR EACH ROW
EXECUTE FUNCTION inventarios.resolve_official_item_location_status();

ALTER TABLE inventarios.official_version_location_items
    ADD COLUMN IF NOT EXISTS available_quantity numeric(14,3),
    ADD COLUMN IF NOT EXISTS damaged_quantity numeric(14,3),
    ADD COLUMN IF NOT EXISTS expired_quantity numeric(14,3),
    ADD COLUMN IF NOT EXISTS blocked_quantity numeric(14,3),
    ADD COLUMN IF NOT EXISTS other_unavailable_quantity numeric(14,3);

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_inventarios_ovli_quantities'
          AND conrelid = 'inventarios.official_version_location_items'::regclass
    ) THEN
        ALTER TABLE inventarios.official_version_location_items
            ADD CONSTRAINT chk_inventarios_ovli_quantities
            CHECK (
                available_quantity >= 0 AND damaged_quantity >= 0 AND expired_quantity >= 0
                AND blocked_quantity >= 0 AND other_unavailable_quantity >= 0
                AND physical_quantity >= 0
                AND physical_quantity = available_quantity + damaged_quantity + expired_quantity
                    + blocked_quantity + other_unavailable_quantity
            );
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION inventarios.materialize_official_version_location_items()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    v_manifest_count bigint;
    v_unresolved_count bigint;
BEGIN
    IF NEW.location_resolution_status = 'UNRESOLVED_RECOUNT' THEN
        RETURN NEW;
    END IF;

    SELECT count(*)
    INTO v_manifest_count
    FROM jsonb_array_elements(NEW.contribution_manifest);

    SELECT count(*)
    INTO v_unresolved_count
    FROM jsonb_array_elements(NEW.contribution_manifest) manifest
    LEFT JOIN inventarios.count_entries ce
      ON ce.id = (manifest->>'contribution_count_entry_id')::uuid
    WHERE ce.id IS NULL OR ce.snapshot_location_id IS NULL;

    IF v_manifest_count = 0 OR v_unresolved_count > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INV_OFFICIAL_LOCATION_UNRESOLVED',
            DETAIL = jsonb_build_object(
                'message', 'Una contribucion oficial no tiene una ubicacion inequivoca.',
                'official_version_id', NEW.official_version_id,
                'snapshot_product_id', NEW.snapshot_product_id,
                'unresolved_count', greatest(v_unresolved_count, CASE WHEN v_manifest_count = 0 THEN 1 ELSE 0 END),
                'retryable', false
            )::text;
    END IF;

    INSERT INTO inventarios.official_version_location_items (
        company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
        snapshot_location_id, theoretical_quantity, available_quantity, damaged_quantity,
        expired_quantity, blocked_quantity, other_unavailable_quantity, physical_quantity,
        difference_quantity, unit_cost, difference_value, currency, has_cost,
        valuation_status, created_at, created_by
    )
    SELECT
        NEW.company_id, NEW.official_version_id, NEW.session_id, NEW.snapshot_id,
        NEW.snapshot_product_id, ce.snapshot_location_id, st.theoretical_quantity,
        sum(ce.available_quantity), sum(ce.damaged_quantity), sum(ce.expired_quantity),
        sum(ce.blocked_quantity), sum(ce.other_unavailable_quantity), sum(ce.physical_quantity),
        CASE WHEN st.theoretical_quantity IS NULL THEN NULL
             ELSE sum(ce.physical_quantity) - st.theoretical_quantity END,
        suc.unit_cost,
        CASE WHEN st.theoretical_quantity IS NULL OR suc.unit_cost IS NULL THEN NULL
             ELSE (sum(ce.physical_quantity) - st.theoretical_quantity) * suc.unit_cost END,
        'CLP', (suc.unit_cost IS NOT NULL AND suc.unit_cost > 0),
        CASE WHEN suc.unit_cost IS NOT NULL AND suc.unit_cost > 0
             THEN 'COMPLETE' ELSE 'INCOMPLETE_NO_COST' END,
        NEW.created_at, NEW.created_by
    FROM jsonb_array_elements(NEW.contribution_manifest) manifest
    JOIN inventarios.count_entries ce
      ON ce.id = (manifest->>'contribution_count_entry_id')::uuid
    LEFT JOIN inventarios.snapshot_theoretical_stocks st
      ON st.company_id = NEW.company_id
     AND st.snapshot_id = NEW.snapshot_id
     AND st.snapshot_product_id = NEW.snapshot_product_id
     AND st.scope_level = 'LOCATION'
     AND st.snapshot_location_id = ce.snapshot_location_id
    LEFT JOIN inventarios.snapshot_unit_costs suc
      ON suc.company_id = NEW.company_id
     AND suc.snapshot_id = NEW.snapshot_id
     AND suc.snapshot_product_id = NEW.snapshot_product_id
    GROUP BY ce.snapshot_location_id, st.theoretical_quantity, suc.unit_cost;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios.materialize_official_version_location_items() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.materialize_official_version_location_items() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_materialize_official_version_location_items
    ON inventarios.official_version_items;

CREATE TRIGGER trg_materialize_official_version_location_items
AFTER INSERT ON inventarios.official_version_items
FOR EACH ROW
EXECUTE FUNCTION inventarios.materialize_official_version_location_items();
