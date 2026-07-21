-- Fase 3C: vendedor comercial real certificado desde GET /documents/{id}/sellers.json

CREATE OR REPLACE VIEW comercial.vw_client_seller_metrics
WITH (security_invoker = true)
AS
WITH invoice_sellers AS (
    SELECT
        d.company_id,
        d.client_id AS bsale_client_id,
        d.bsale_id,
        d.emission_date,
        d.total_amount,
        ds.seller_bsale_id::bigint AS seller_id,
        COALESCE(NULLIF(ds.seller_name, ''), s.name) AS seller_name
    FROM integraciones.bsale_documents d
    JOIN integraciones.bsale_document_sellers ds
        ON ds.company_id = d.company_id
        AND ds.bsale_document_id = d.bsale_id
        AND ds.is_primary = true
    LEFT JOIN integraciones.bsale_sellers s
        ON s.company_id = d.company_id
        AND s.bsale_id = ds.seller_bsale_id
    WHERE d.document_type_id = 5
      AND d.client_id IS NOT NULL
),
last_seller AS (
    SELECT ranked.company_id, ranked.bsale_client_id, ranked.seller_id, ranked.seller_name
    FROM (
        SELECT
            inv.company_id,
            inv.bsale_client_id,
            inv.seller_id,
            inv.seller_name,
            ROW_NUMBER() OVER (
                PARTITION BY inv.company_id, inv.bsale_client_id
                ORDER BY inv.emission_date DESC, inv.bsale_id DESC
            ) AS rn
        FROM invoice_sellers inv
    ) ranked
    WHERE ranked.rn = 1
),
seller_sales_180d AS (
    SELECT
        inv.company_id,
        inv.bsale_client_id,
        inv.seller_id,
        inv.seller_name,
        SUM(inv.total_amount) AS seller_sales_180d,
        COUNT(*) AS seller_invoice_count_180d
    FROM invoice_sellers inv
    WHERE inv.emission_date >= current_date - interval '180 days'
    GROUP BY inv.company_id, inv.bsale_client_id, inv.seller_id, inv.seller_name
),
main_seller AS (
    SELECT ranked.company_id, ranked.bsale_client_id, ranked.seller_id, ranked.seller_name, ranked.seller_sales_180d
    FROM (
        SELECT
            ss.company_id,
            ss.bsale_client_id,
            ss.seller_id,
            ss.seller_name,
            ss.seller_sales_180d,
            ROW_NUMBER() OVER (
                PARTITION BY ss.company_id, ss.bsale_client_id
                ORDER BY ss.seller_sales_180d DESC, ss.seller_invoice_count_180d DESC, ss.seller_id
            ) AS rn
        FROM seller_sales_180d ss
    ) ranked
    WHERE ranked.rn = 1
)
SELECT
    COALESCE(ls.company_id, ms.company_id) AS company_id,
    COALESCE(ls.bsale_client_id, ms.bsale_client_id) AS bsale_client_id,
    ls.seller_id AS last_seller_id,
    ls.seller_name AS last_seller_name,
    ms.seller_id AS main_seller_id,
    ms.seller_name AS main_seller_name,
    ms.seller_sales_180d AS main_seller_sales_180d
FROM last_seller ls
FULL JOIN main_seller ms ON ms.company_id = ls.company_id AND ms.bsale_client_id = ls.bsale_client_id;

GRANT SELECT ON comercial.vw_client_seller_metrics TO authenticated;
GRANT SELECT ON comercial.vw_client_seller_metrics TO service_role;
