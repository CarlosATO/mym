-- Persist Bsale's technical product classification for operational catalog use.
-- Bsale classification 3 is a pack; classification 0 is a physical product.

ALTER TABLE adquisiciones.products
  ADD COLUMN IF NOT EXISTS bsale_product_classification integer;

CREATE OR REPLACE FUNCTION adquisiciones.apply_bsale_product_updates(
    p_updates pg_catalog.jsonb,
    p_company_id pg_catalog.uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones
AS $$
DECLARE
    v_update pg_catalog.jsonb;
    v_id pg_catalog.uuid;
    v_expected_sku pg_catalog.text;
    v_expected_barcode pg_catalog.text;
    v_current_sku pg_catalog.text;
    v_current_barcode pg_catalog.text;
    v_company_id pg_catalog.uuid;
BEGIN
    IF pg_catalog.jsonb_typeof(p_updates) != 'array' THEN RAISE EXCEPTION 'Input p_updates must be a JSON array'; END IF;
    IF pg_catalog.jsonb_array_length(p_updates) > 500 THEN RAISE EXCEPTION 'Batch size exceeds maximum allowed (500)'; END IF;
    IF (SELECT pg_catalog.count(*) FROM (SELECT value->>'id' FROM pg_catalog.jsonb_array_elements(p_updates) GROUP BY value->>'id' HAVING pg_catalog.count(*) > 1) q) > 0 THEN RAISE EXCEPTION 'Duplicate IDs found in update batch'; END IF;

    FOR v_update IN SELECT * FROM pg_catalog.jsonb_array_elements(p_updates)
    LOOP
        v_id := (v_update->>'id')::pg_catalog.uuid;
        v_expected_sku := v_update->>'expected_sku';
        v_expected_barcode := v_update->>'expected_barcode';
        SELECT sku, barcode, company_id INTO v_current_sku, v_current_barcode, v_company_id
        FROM adquisiciones.products WHERE id = v_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND: Product % does not exist', v_id; END IF;
        IF v_company_id != p_company_id THEN RAISE EXCEPTION 'COMPANY_MISMATCH: Product % does not belong to the authorized company', v_id; END IF;
        IF COALESCE(v_current_sku, '') != COALESCE(v_expected_sku, '') THEN RAISE EXCEPTION 'BSALE_PRODUCT_STALE_STATE: Product % expected SKU % but was %', v_id, v_expected_sku, v_current_sku; END IF;
        IF COALESCE(v_current_barcode, '') != COALESCE(v_expected_barcode, '') THEN RAISE EXCEPTION 'BSALE_PRODUCT_STALE_STATE: Product % expected barcode % but was %', v_id, v_expected_barcode, v_current_barcode; END IF;

        UPDATE adquisiciones.products
        SET sku = NULLIF(TRIM(v_update->>'new_sku'), ''),
            barcode = NULLIF(TRIM(v_update->>'new_barcode'), ''),
            description = v_update->>'description',
            bsale_product_state = (v_update->>'bsale_product_state')::pg_catalog.int4,
            bsale_variant_state = (v_update->>'bsale_variant_state')::pg_catalog.int4,
            bsale_product_classification = (v_update->>'bsale_product_classification')::pg_catalog.int4,
            bsale_product_type_id = (v_update->>'bsale_product_type_id')::pg_catalog.int4,
            bsale_product_type_name = v_update->>'bsale_product_type_name',
            product_type = v_update->>'product_type',
            bsale_brand_id = (v_update->>'bsale_brand_id')::pg_catalog.int4,
            bsale_brand_href = v_update->>'bsale_brand_href',
            is_active = (v_update->>'is_active')::pg_catalog.bool,
            last_bsale_sync_at = (v_update->>'last_bsale_sync_at')::pg_catalog.timestamptz,
            updated_at = pg_catalog.NOW()
        WHERE id = v_id;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION mermas.reject_pack_request_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones, mermas
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM adquisiciones.products p
        WHERE p.company_id = NEW.company_id
          AND p.bsale_variant_id = NEW.bsale_variant_id
          AND p.bsale_product_classification = 3
    ) THEN
        RAISE EXCEPTION 'Los Packs deben registrarse por cada artículo físico que los compone.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_request_lines_reject_packs ON mermas.request_lines;
CREATE TRIGGER trg_request_lines_reject_packs
    BEFORE INSERT ON mermas.request_lines
    FOR EACH ROW EXECUTE FUNCTION mermas.reject_pack_request_line();
