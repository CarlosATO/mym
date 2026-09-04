-- Migration: 20260903210000_inventarios_campaign_theoretical_stock_source.sql
-- Description: Fuente canonica unica de stock teorico por campana (solo lectura).
--
-- Regla definitiva MATERIALIZED -> IMPORT_FALLBACK:
--   1. Si existen datos materializados en inventory_campaign_theoretical_stocks
--      (scope TOTAL_CAMPAIGN) para la campana, esa es la fuente oficial.
--   2. Si NO existen datos materializados, se usa el import VALIDATED +
--      TOTAL_CAMPAIGN vigente de la campana, considerando unicamente las filas
--      incorporables segun el contrato actual: row_status IN ('VALID','WARNING')
--      sin issues de nivel ERROR y donde la unica advertencia permitida es
--      ZERO_COST (i.e. no existe ningun issue con issue_code <> 'ZERO_COST').
--
-- NO modifica importaciones, snapshots, filas de import ni ninguna lectura
-- existente. Es un read model puro (nuevo), aun no conectado a pantallas.

CREATE OR REPLACE FUNCTION inventarios.get_campaign_theoretical_stock(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS TABLE (
    company_id uuid,
    campaign_id uuid,
    product_id uuid,
    bsale_variant_id integer,
    sku text,
    theoretical_quantity numeric,
    unit_cost numeric,
    source text
)
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    PERFORM inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    -- 1. Fuente MATERIALIZED: existe fotografia de campana con stocks congelados.
    IF EXISTS (
        SELECT 1
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
        WHERE icts.company_id = p_company_id
          AND cs.campaign_id = p_campaign_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
    ) THEN
        RETURN QUERY
        SELECT
            icts.company_id,
            cs.campaign_id,
            csp.product_id,
            csp.bsale_variant_id,
            csp.sku,
            icts.theoretical_quantity,
            icts.unit_cost,
            'MATERIALIZED'::text AS source
        FROM inventarios.inventory_campaign_theoretical_stocks icts
        JOIN inventarios.inventory_campaign_snapshots cs
          ON cs.company_id = icts.company_id AND cs.id = icts.campaign_snapshot_id
        JOIN inventarios.inventory_campaign_snapshot_products csp
          ON csp.company_id = icts.company_id
         AND csp.campaign_snapshot_id = icts.campaign_snapshot_id
         AND csp.id = icts.snapshot_product_id
        WHERE icts.company_id = p_company_id
          AND cs.campaign_id = p_campaign_id
          AND icts.scope_level = 'TOTAL_CAMPAIGN'
        ORDER BY csp.sku;
        RETURN;
    END IF;

    -- 2. Fallback IMPORT_FALLBACK: import VALIDATED + TOTAL_CAMPAIGN vigente.
    --    Seleccion deterministica de UN solo stock_import_id: mismo criterio de
    --    "import vigente" que get_inventory_campaign_all_products
    --    (validated_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1).
    --    La igualdad r.import_id = (subquery) garantiza 0 mezcla de imports.
    RETURN QUERY
    SELECT
        r.company_id,
        p_campaign_id AS campaign_id,
        r.product_id,
        r.bsale_variant_id,
        r.sku,
        r.theoretical_quantity,
        r.unit_cost,
        'IMPORT_FALLBACK'::text AS source
    FROM inventarios.stock_import_rows r
    WHERE r.company_id = p_company_id
      AND r.import_id = (
          SELECT si.id
          FROM inventarios.stock_imports si
          WHERE si.company_id = p_company_id
            AND si.campaign_id = p_campaign_id
            AND si.status = 'VALIDATED'
            AND si.theoretical_scope = 'TOTAL_CAMPAIGN'
            AND si.consumed_campaign_id IS NULL
          ORDER BY si.validated_at DESC NULLS LAST, si.created_at DESC, si.id DESC
          LIMIT 1
      )
      AND r.row_status IN ('VALID', 'WARNING')
      AND r.product_id IS NOT NULL
      AND r.bsale_variant_id IS NOT NULL
      AND r.sku IS NOT NULL AND pg_catalog.btrim(r.sku) <> ''
      AND r.theoretical_quantity IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.stock_import_row_issues i
          WHERE i.company_id = r.company_id AND i.import_id = r.import_id
            AND i.row_id = r.id AND i.issue_level = 'ERROR'
      )
      AND NOT EXISTS (
          SELECT 1 FROM inventarios.stock_import_row_issues i
          WHERE i.company_id = r.company_id AND i.import_id = r.import_id
            AND i.row_id = r.id AND i.issue_code <> 'ZERO_COST'
      )
    ORDER BY r.sku;
END;
$$;

ALTER FUNCTION inventarios.get_campaign_theoretical_stock(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION inventarios.get_campaign_theoretical_stock(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION inventarios.get_campaign_theoretical_stock(uuid, uuid) TO authenticated;
