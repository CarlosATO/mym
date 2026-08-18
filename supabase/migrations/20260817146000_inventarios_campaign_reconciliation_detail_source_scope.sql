-- El detalle debe mostrar solo las fuentes que contribuyen a su variante/oficina.
DO $migration$
DECLARE
    v_definition text;
BEGIN
    SELECT pg_get_functiondef(
        'inventarios.get_inventory_campaign_stock_reconciliation_item_detail(uuid, uuid, uuid)'::regprocedure
    ) INTO v_definition;

    v_definition := replace(
        v_definition,
        $$WHERE s.reconciliation_id = (v_item->>'reconciliation_id')::uuid
          AND s.bsale_office_id = (v_item->>'bsale_office_id')::integer$$,
        $$WHERE s.reconciliation_id = (v_item->>'reconciliation_id')::uuid
          AND s.bsale_office_id = (v_item->>'bsale_office_id')::integer
          AND (
              (s.official_version_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM inventarios.official_version_items oi
                  WHERE oi.company_id = s.company_id
                    AND oi.official_version_id = s.official_version_id
                    AND oi.bsale_variant_id = (v_item->>'bsale_variant_id')::integer
              ))
              OR (s.official_version_id IS NULL AND EXISTS (
                  SELECT 1 FROM inventarios.session_product_scopes sps
                  WHERE sps.company_id = s.company_id
                    AND sps.session_id = s.session_id
                    AND sps.bsale_variant_id = (v_item->>'bsale_variant_id')::integer
              ))
          )$$
    );

    EXECUTE v_definition;
END;
$migration$;
