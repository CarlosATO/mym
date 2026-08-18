-- Preserve the auxiliary product identity fields in the web report contract.
-- Schema affected exclusively: inventarios.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'inventarios.list_inventory_campaign_variances(uuid,uuid,text,text,text,integer,integer,text,text)'::regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, '''barcode''') = 0 THEN
        v_definition := pg_catalog.replace(
            v_definition,
            $$'variance_status', f.variance_status, 'coverage_status', f.coverage_status)$$,
            $$'variance_status', f.variance_status, 'coverage_status', f.coverage_status,
             'barcode', inventarios.inventory_campaign_product_original_barcode(p_company_id, p_campaign_id, f.bsale_variant_id) ->> 'barcode',
             'approved_barcodes', coalesce((SELECT jsonb_agg(pba.barcode ORDER BY pba.barcode)
                 FROM inventarios.product_barcode_aliases pba
                 WHERE pba.company_id = p_company_id AND pba.bsale_variant_id = f.bsale_variant_id AND pba.is_active = true), '[]'::jsonb))$$
        );
    END IF;
    EXECUTE v_definition;
END;
$migration$;

COMMIT;
