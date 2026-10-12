-- Provider-level COGS attribution for the income statement, read-only.
--
-- Reuses the already validated COGS sources without introducing a second cost model:
--   gross  : integraciones.bsale_document_costs.total_cost (status OBSERVED / ZERO_WITH_EVIDENCE)
--   reversal: integraciones.bsale_credit_note_cogs_resolutions.reversal_cogs
-- Both are decomposed to the same provider_key that the EERR already uses
-- (integraciones.vw_bsale_sales_provider_family_lines, i.e. the BSale brand), so the
-- per-provider amounts reconcile exactly against the global COGS of the period.
--
-- The document total_cost is authoritative (the amount the engine sums). Its residual
-- against the sum of the real per-line cost components is deterministic: when BSale's
-- document total differs from the sum of its cost_detail rows (cent rounding), the
-- residual is assigned to the document's single largest-cost line. This keeps
-- SUM(provider gross) = validated gross at every month, with no fabricated cost.
--
-- The provider mapping and eligible document sets are materialized so the planner uses
-- real cardinalities (the finance runtime reads this view under a 5s statement timeout).
--
-- No new tables and no data writes. Exposed only to the finance runtime role.

CREATE OR REPLACE VIEW integraciones.vw_bsale_provider_cogs_monthly AS
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
variant_provider AS MATERIALIZED (
    SELECT DISTINCT
        company_id,
        variant_id,
        COALESCE(provider_key, 'unassigned') AS provider_key,
        COALESCE(provider_name, 'SIN PROVEEDOR') AS provider_name
    FROM integraciones.vw_bsale_sales_provider_family_lines
),
gross_lines AS MATERIALIZED (
    SELECT
        eligible.company_id,
        eligible.bsale_id,
        eligible.emission_date,
        details.cost_detail_key,
        details.total_cost,
        costs.total_cost AS document_total_cost,
        COALESCE(provider.provider_key, 'unassigned') AS provider_key,
        COALESCE(provider.provider_name, 'SIN PROVEEDOR') AS provider_name,
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
    LEFT JOIN variant_provider AS provider
      ON provider.company_id = details.company_id
     AND provider.variant_id = details.bsale_variant_id
),
gross_normalized AS (
    SELECT
        company_id,
        EXTRACT(YEAR FROM emission_date)::integer AS year,
        EXTRACT(MONTH FROM emission_date)::integer AS month,
        provider_key,
        provider_name,
        SUM(
            total_cost
            + CASE WHEN residual_rank = 1 THEN document_total_cost - document_detail_sum ELSE 0::numeric END
        ) AS gross_cogs
    FROM gross_lines
    GROUP BY company_id, EXTRACT(YEAR FROM emission_date)::integer, EXTRACT(MONTH FROM emission_date)::integer, provider_key, provider_name
),
reversal_lines AS MATERIALIZED (
    SELECT
        eligible.company_id,
        eligible.emission_date,
        COALESCE(provider.provider_key, 'unassigned') AS provider_key,
        COALESCE(provider.provider_name, 'SIN PROVEEDOR') AS provider_name,
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
    LEFT JOIN variant_provider AS provider
      ON provider.company_id = document_details.company_id
     AND provider.variant_id = document_details.variant_id
    UNION ALL
    SELECT
        eligible.company_id,
        eligible.emission_date,
        'unassigned' AS provider_key,
        'SIN PROVEEDOR' AS provider_name,
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
        provider_name,
        SUM(reversal_cogs) AS credit_note_reversal
    FROM reversal_lines
    GROUP BY company_id, EXTRACT(YEAR FROM emission_date)::integer, EXTRACT(MONTH FROM emission_date)::integer, provider_key, provider_name
),
combined AS (
    SELECT company_id, year, month, provider_key, provider_name, gross_cogs, 0::numeric AS credit_note_reversal
    FROM gross_normalized
    UNION ALL
    SELECT company_id, year, month, provider_key, provider_name, 0::numeric AS gross_cogs, credit_note_reversal
    FROM reversal_normalized
)
SELECT
    company_id,
    year,
    month,
    provider_key,
    MAX(provider_name) AS provider_name,
    SUM(gross_cogs) AS gross_cogs,
    SUM(credit_note_reversal) AS credit_note_reversal
FROM combined
GROUP BY company_id, year, month, provider_key;

COMMENT ON VIEW integraciones.vw_bsale_provider_cogs_monthly IS
    'Monthly provider-level COGS for the income statement. gross_cogs reuses bsale_document_costs.total_cost (OBSERVED / ZERO_WITH_EVIDENCE); credit_note_reversal reuses bsale_credit_note_cogs_resolutions per return detail. provider_key matches vw_bsale_sales_provider_family_lines. Read-only aggregation; no data writes.';

REVOKE ALL ON integraciones.vw_bsale_provider_cogs_monthly FROM PUBLIC, anon, authenticated;
GRANT SELECT ON integraciones.vw_bsale_provider_cogs_monthly TO petgroup_backend_runtime;
