-- PROV-1B: persist Bsale brand references without resolving suppliers.

ALTER TABLE adquisiciones.products
    ADD COLUMN IF NOT EXISTS bsale_brand_id integer,
    ADD COLUMN IF NOT EXISTS bsale_brand_href text;

CREATE INDEX IF NOT EXISTS idx_products_company_bsale_brand
    ON adquisiciones.products (company_id, bsale_brand_id)
    WHERE bsale_brand_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS integraciones.bsale_brands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_brand_id integer NOT NULL,
    bsale_brand_href text,
    status text NOT NULL DEFAULT 'DETECTED',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_bsale_brands_id_positive CHECK (bsale_brand_id > 0),
    CONSTRAINT chk_bsale_brands_status CHECK (status = 'DETECTED'),
    CONSTRAINT uq_bsale_brands_company_id UNIQUE (company_id, bsale_brand_id)
);

CREATE INDEX IF NOT EXISTS idx_bsale_brands_company
    ON integraciones.bsale_brands (company_id);

ALTER TABLE integraciones.bsale_brands ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'integraciones'
          AND tablename = 'bsale_brands'
          AND policyname = 'rls_bsale_brands_select'
    ) THEN
        CREATE POLICY rls_bsale_brands_select
            ON integraciones.bsale_brands
            FOR SELECT TO authenticated
            USING (core.has_company_access(auth.uid(), company_id));
    END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON integraciones.bsale_brands TO service_role;

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
        SET
            sku = NULLIF(TRIM(v_update->>'new_sku'), ''),
            barcode = NULLIF(TRIM(v_update->>'new_barcode'), ''),
            description = v_update->>'description',
            bsale_product_state = (v_update->>'bsale_product_state')::pg_catalog.int4,
            bsale_variant_state = (v_update->>'bsale_variant_state')::pg_catalog.int4,
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
