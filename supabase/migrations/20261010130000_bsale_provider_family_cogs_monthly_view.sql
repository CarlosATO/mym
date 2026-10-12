-- Family-level COGS attribution for the income statement.
--
-- This is intentionally a second view. The applied provider-level view is not
-- modified. family_key is the exact key used by the sales API/UI:
-- provider_key|product_type:<bsale product type id>, or the normalized family
-- name, with unclassified/Sin clasificar as the deterministic fallback.
--
-- Cost is attributed only from the real cost detail variant. No sales-share
-- allocation is used. Document residuals are assigned to the largest real
-- cost-detail line, matching the validated provider-level engine.

CREATE OR REPLACE VIEW integraciones.vw_bsale_provider_family_cogs_monthly AS
WITH eligible_gross_documents AS MATERIALIZED (
    SELECT DISTINCT normalized.company_id, normalized.bsale_id, normalized.emission_date
    FROM integraciones.vw_bsale_documents_normalized AS normalized
    WHERE normalized.include_in_replenishment = TRUE
      AND normalized.sign_for_sales IN (1, -1)
      AND normalized.business_category IN ('sale', 'reversal')
      AND normalized.document_type_id IN (1, 5)
),
eligible_credit_notes AS MATERIALIZED (
    SELECT DISTINCT normalized.company_id, normalized.bsale_id, normalized.emission_date
    FROM integraciones.vw_bsale_documents_normalized AS normalized
    WHERE normalized.include_in_replenishment = TRUE
      AND normalized.sign_for_sales IN (1, -1)
      AND normalized.business_category IN ('sale', 'reversal')
      AND normalized.document_type_id = 2
),
variant_family AS MATERIALIZED (
    SELECT DISTINCT
        family_lines.company_id,
        family_lines.variant_id,
        COALESCE(family_lines.provider_key, 'unassigned') AS provider_key,
        COALESCE(family_lines.provider_name, 'SIN PROVEEDOR') AS provider_name,
        CASE
            WHEN family_lines.detail_bsale_id IS NULL
                OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                THEN COALESCE(family_lines.provider_key, 'unassigned') || '|unclassified'
            WHEN family_lines.product_type_id IS NOT NULL
                THEN COALESCE(family_lines.provider_key, 'unassigned') || '|product_type:' || family_lines.product_type_id::text
            ELSE COALESCE(family_lines.provider_key, 'unassigned') || '|product_type:' || lower(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'))
        END AS family_key,
        CASE
            WHEN family_lines.detail_bsale_id IS NULL
                OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                THEN 'Sin clasificar'
            ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
        END AS family_name
    FROM integraciones.vw_bsale_sales_provider_family_lines AS family_lines
),
gross_lines AS MATERIALIZED (
    SELECT
        eligible.company_id,
        eligible.bsale_id,
        eligible.emission_date,
        details.cost_detail_key,
        details.total_cost,
        costs.total_cost AS document_total_cost,
        COALESCE(family.provider_key, 'unassigned') AS provider_key,
        COALESCE(family.provider_name, 'SIN PROVEEDOR') AS provider_name,
        COALESCE(family.family_key, 'unassigned|unclassified') AS family_key,
        COALESCE(family.family_name, 'Sin clasificar') AS family_name,
        ROW_NUMBER() OVER (
            PARTITION BY eligible.company_id, eligible.bsale_id
            ORDER BY details.total_cost DESC, details.cost_detail_key
        ) AS residual_rank,
        SUM(details.total_cost) OVER (
            PARTITION BY eligible.company_id, eligible.bsale_id
        ) AS document_detail_sum
    FROM eligible_gross_documents AS eligible
    JOIN integraciones.bsale_document_costs AS costs
      ON costs.company_id = eligible.company_id
     AND costs.bsale_document_id = eligible.bsale_id
     AND costs.status IN ('OBSERVED', 'ZERO_WITH_EVIDENCE')
    JOIN integraciones.bsale_document_cost_details AS details
      ON details.company_id = eligible.company_id
     AND details.bsale_document_id = eligible.bsale_id
    LEFT JOIN variant_family AS family
      ON family.company_id = details.company_id
     AND family.variant_id = details.bsale_variant_id
),
gross_normalized AS (
    SELECT
        company_id,
        EXTRACT(YEAR FROM emission_date)::integer AS year,
        EXTRACT(MONTH FROM emission_date)::integer AS month,
        provider_key,
        MAX(provider_name) AS provider_name,
        family_key,
        MAX(family_name) AS family_name,
        SUM(total_cost + CASE WHEN residual_rank = 1 THEN document_total_cost - document_detail_sum ELSE 0::numeric END) AS gross_cogs
    FROM gross_lines
    GROUP BY company_id, EXTRACT(YEAR FROM emission_date)::integer, EXTRACT(MONTH FROM emission_date)::integer, provider_key, family_key
),
reversal_lines AS MATERIALIZED (
    SELECT
        eligible.company_id,
        eligible.emission_date,
        COALESCE(family.provider_key, 'unassigned') AS provider_key,
        COALESCE(family.provider_name, 'SIN PROVEEDOR') AS provider_name,
        COALESCE(family.family_key, 'unassigned|unclassified') AS family_key,
        COALESCE(family.family_name, 'Sin clasificar') AS family_name,
        details.reversal_cogs
    FROM eligible_credit_notes AS eligible
    JOIN integraciones.bsale_credit_note_cogs_resolutions AS resolution
      ON resolution.company_id = eligible.company_id
     AND resolution.bsale_credit_note_id = eligible.bsale_id
    JOIN integraciones.bsale_credit_note_cogs_resolution_details AS details
      ON details.company_id = eligible.company_id
     AND details.bsale_credit_note_id = eligible.bsale_id
    LEFT JOIN integraciones.bsale_document_details AS document_details
      ON document_details.company_id = eligible.company_id
     AND document_details.bsale_id = details.bsale_document_detail_id
    LEFT JOIN variant_family AS family
      ON family.company_id = document_details.company_id
     AND family.variant_id = document_details.variant_id
    UNION ALL
    SELECT
        eligible.company_id,
        eligible.emission_date,
        'unassigned' AS provider_key,
        'SIN PROVEEDOR' AS provider_name,
        'unassigned|unclassified' AS family_key,
        'Sin clasificar' AS family_name,
        resolution.reversal_cogs
    FROM eligible_credit_notes AS eligible
    JOIN integraciones.bsale_credit_note_cogs_resolutions AS resolution
      ON resolution.company_id = eligible.company_id
     AND resolution.bsale_credit_note_id = eligible.bsale_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM integraciones.bsale_credit_note_cogs_resolution_details AS details
        WHERE details.company_id = eligible.company_id
          AND details.bsale_credit_note_id = eligible.bsale_id
    )
),
reversal_normalized AS (
    SELECT
        company_id,
        EXTRACT(YEAR FROM emission_date)::integer AS year,
        EXTRACT(MONTH FROM emission_date)::integer AS month,
        provider_key,
        MAX(provider_name) AS provider_name,
        family_key,
        MAX(family_name) AS family_name,
        SUM(reversal_cogs) AS credit_note_reversal
    FROM reversal_lines
    GROUP BY company_id, EXTRACT(YEAR FROM emission_date)::integer, EXTRACT(MONTH FROM emission_date)::integer, provider_key, family_key
),
combined AS (
    SELECT company_id, year, month, provider_key, provider_name, family_key, family_name, gross_cogs, 0::numeric AS credit_note_reversal
    FROM gross_normalized
    UNION ALL
    SELECT company_id, year, month, provider_key, provider_name, family_key, family_name, 0::numeric AS gross_cogs, credit_note_reversal
    FROM reversal_normalized
)
SELECT
    company_id,
    year,
    month,
    provider_key,
    MAX(provider_name) AS provider_name,
    family_key,
    MAX(family_name) AS family_name,
    SUM(gross_cogs) AS gross_cogs,
    SUM(credit_note_reversal) AS credit_note_reversal
FROM combined
GROUP BY company_id, year, month, provider_key, family_key;

COMMENT ON VIEW integraciones.vw_bsale_provider_family_cogs_monthly IS
    'Monthly real COGS by the exact provider-family key used by the sales UI. Reuses observed/zero-with-evidence document costs, cost-detail residual normalization, and credit-note resolution details. Read-only; no data writes.';

REVOKE ALL ON integraciones.vw_bsale_provider_family_cogs_monthly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON integraciones.vw_bsale_provider_family_cogs_monthly TO petgroup_backend_runtime;
