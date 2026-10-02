from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from fastapi import HTTPException, status

from app.core.config import get_settings
from app.db.connection import get_session_factory


SALES_SOURCE = (
    "integraciones.vw_bsale_documents_normalized.net_amount"
)
MONEY_QUANTUM = Decimal("0.01")
SALES_ELIGIBLE_DOCUMENTS_CTE = """
    SELECT DISTINCT
        normalized.company_id,
        normalized.bsale_id,
        normalized.emission_date,
        normalized.document_type_id,
        normalized.document_type_name,
        normalized.folio,
        normalized.sign_for_sales,
        normalized.net_amount,
        normalized.office_id,
        normalized.office_name
    FROM integraciones.vw_bsale_documents_normalized AS normalized
    WHERE normalized.company_id = :company_id
      AND normalized.emission_date >= :date_from
      AND normalized.emission_date < :date_to
      AND normalized.include_in_replenishment = TRUE
      AND normalized.sign_for_sales IN (1, -1)
      AND normalized.business_category IN ('sale', 'reversal')
"""


MONTHLY_NET_SALES_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    )
    SELECT
        EXTRACT(MONTH FROM emission_date)::integer AS month,
        SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS net_sales,
        COUNT(*)::integer AS documents_count,
        COALESCE(
            SUM((
                SELECT COUNT(*)
                FROM integraciones.bsale_document_details AS details
                WHERE details.company_id = eligible_documents.company_id
                  AND details.bsale_document_id = eligible_documents.bsale_id
            )),
            0
        )::integer AS lines_count
    FROM eligible_documents
    GROUP BY EXTRACT(MONTH FROM emission_date)::integer
    ORDER BY month
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_METADATA_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    )
    SELECT
        MAX(emission_date) AS data_through,
        COUNT(*)::integer AS documents_count,
        COALESCE(
            SUM((
                SELECT COUNT(*)
                FROM integraciones.bsale_document_details AS details
                WHERE details.company_id = eligible_documents.company_id
                  AND details.bsale_document_id = eligible_documents.bsale_id
            )),
            0
        )::integer AS lines_count
    FROM eligible_documents
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_DETAIL_METADATA_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    )
    SELECT MAX(emission_date) AS data_through
    FROM eligible_documents
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_DETAIL_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    )
    SELECT
        bsale_id,
        emission_date,
        document_type_id,
        document_type_name,
        folio,
        net_amount,
        sign_for_sales
    FROM eligible_documents
    WHERE emission_date <= :data_through
      AND (:month IS NULL OR EXTRACT(MONTH FROM emission_date)::integer = :month)
    ORDER BY emission_date, document_type_id, folio, bsale_id
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_FAMILY_EXISTS_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.bsale_id,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'unclassified'
                ELSE 'product_type:' || lower(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'))
            END AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    )
    SELECT family_name
    FROM classified_lines
    WHERE family_key = :family_key
    LIMIT 1
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_FAMILY_DETAIL_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.company_id,
            documents.bsale_id,
            documents.emission_date,
            documents.document_type_id,
            documents.document_type_name,
            documents.folio,
            documents.sign_for_sales,
            documents.office_id,
            documents.office_name,
            NULL::integer AS client_id,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'unclassified'
                ELSE 'product_type:' || lower(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'))
            END AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL THEN documents.net_amount
                ELSE family_lines.line_net_amount
            END AS net_amount,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN 0 ELSE 1 END AS line_count
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    ), family_documents AS (
        SELECT
            company_id,
            bsale_id,
            MAX(emission_date) AS emission_date,
            MAX(document_type_id) AS document_type_id,
            MAX(document_type_name) AS document_type_name,
            MAX(folio) AS folio,
            MAX(sign_for_sales) AS sign_for_sales,
            MAX(office_id) AS office_id,
            MAX(office_name) AS office_name,
            MAX(client_id) AS client_id,
            MAX(family_name) AS family_name,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS contribution,
            SUM(line_count)::integer AS line_count
        FROM classified_lines
        WHERE family_key = :family_key
          AND emission_date <= :data_through
          AND (CAST(:month AS integer) IS NULL OR EXTRACT(MONTH FROM emission_date)::integer = CAST(:month AS integer))
        GROUP BY company_id, bsale_id
    )
    SELECT
        *,
        COUNT(*) OVER()::integer AS total_documents,
        COALESCE(SUM(contribution) OVER(), 0)::numeric AS total_contribution,
        COALESCE(SUM(line_count) OVER(), 0)::integer AS total_lines
    FROM family_documents
    ORDER BY emission_date DESC, bsale_id DESC
    OFFSET :offset
    LIMIT :page_size
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_BY_FAMILY_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.emission_date,
            documents.sign_for_sales,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'unclassified'
                ELSE 'product_type:' || lower(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'))
            END AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL THEN documents.net_amount
                ELSE family_lines.line_net_amount
            END AS net_amount,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN 0 ELSE 1 END AS line_count
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    ), family_rows AS (
        SELECT
            'FAMILY' AS row_type,
            family_key,
            MIN(family_name) AS family_name,
            EXTRACT(MONTH FROM emission_date)::integer AS month,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS amount,
            SUM(line_count)::integer AS line_count
        FROM classified_lines
        GROUP BY family_key, EXTRACT(MONTH FROM emission_date)::integer
    ), total_rows AS (
        SELECT
            'TOTAL' AS row_type,
            NULL::text AS family_key,
            NULL::text AS family_name,
            EXTRACT(MONTH FROM emission_date)::integer AS month,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS amount,
            NULL::integer AS line_count
        FROM eligible_documents
        GROUP BY EXTRACT(MONTH FROM emission_date)::integer
    )
    SELECT row_type, family_key, family_name, month, amount, line_count
    FROM family_rows
    UNION ALL
    SELECT row_type, family_key, family_name, month, amount, line_count
    FROM total_rows
    ORDER BY row_type, family_key NULLS FIRST, month
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

# Provider identity is part of the classification key so the same product
# type cannot merge across brands. The API still exposes the child family
# name separately for the matrix and its traceability inspector.
PROVIDER_FAMILY_CLASSIFICATION = """
            COALESCE(family_lines.provider_key, 'unassigned') || '|' ||
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'unclassified'
                WHEN family_lines.product_type_id IS NOT NULL
                    THEN 'product_type:' || family_lines.product_type_id::text
                ELSE 'product_type:' || lower(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'))
            END
"""

SALES_PROVIDER_FAMILY_EXISTS_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            {classification} AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_provider_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    )
    SELECT family_name
    FROM classified_lines
    WHERE family_key = :family_key
    LIMIT 1
    """.format(
        eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE,
        classification=PROVIDER_FAMILY_CLASSIFICATION,
    )
)

SALES_PROVIDER_FAMILY_DETAIL_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.company_id,
            documents.bsale_id,
            documents.emission_date,
            documents.document_type_id,
            documents.document_type_name,
            documents.folio,
            documents.sign_for_sales,
            documents.office_id,
            documents.office_name,
            {classification} AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN documents.net_amount ELSE family_lines.line_net_amount END AS net_amount,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN 0 ELSE 1 END AS line_count
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_provider_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    ), family_documents AS (
        SELECT
            company_id, bsale_id, MAX(emission_date) AS emission_date,
            MAX(document_type_id) AS document_type_id,
            MAX(document_type_name) AS document_type_name,
            MAX(folio) AS folio, MAX(sign_for_sales) AS sign_for_sales,
            MAX(office_id) AS office_id, MAX(office_name) AS office_name,
            MAX(family_name) AS family_name,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS contribution,
            SUM(line_count)::integer AS line_count
        FROM classified_lines
        WHERE family_key = :family_key
          AND emission_date <= :data_through
          AND (CAST(:month AS integer) IS NULL OR EXTRACT(MONTH FROM emission_date)::integer = CAST(:month AS integer))
        GROUP BY company_id, bsale_id
    )
    SELECT *, COUNT(*) OVER()::integer AS total_documents,
        COALESCE(SUM(contribution) OVER(), 0)::numeric AS total_contribution,
        COALESCE(SUM(line_count) OVER(), 0)::integer AS total_lines
    FROM family_documents
    ORDER BY emission_date DESC, bsale_id DESC
    OFFSET :offset LIMIT :page_size
    """.format(
        eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE,
        classification=PROVIDER_FAMILY_CLASSIFICATION,
    )
)

SALES_DETAIL_COMBINED_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), period_documents AS (
        SELECT *
        FROM eligible_documents
        WHERE emission_date <= (SELECT MAX(emission_date) FROM eligible_documents)
          AND (CAST(:month AS integer) IS NULL OR EXTRACT(MONTH FROM emission_date)::integer = CAST(:month AS integer))
    ), summary AS (
        SELECT
            (SELECT MAX(emission_date) FROM eligible_documents) AS data_through,
            COUNT(*)::integer AS total_documents,
            COALESCE(SUM(COALESCE(net_amount, 0) * sign_for_sales), 0)::numeric AS total_contribution
        FROM period_documents
    )
    SELECT
        'SUMMARY' AS row_kind,
        NULL::bigint AS bsale_id,
        NULL::date AS emission_date,
        NULL::integer AS document_type_id,
        NULL::text AS document_type_name,
        NULL::integer AS folio,
        NULL::numeric AS net_amount,
        NULL::integer AS sign_for_sales,
        summary.data_through,
        summary.total_documents,
        summary.total_contribution
    FROM summary
    UNION ALL
    SELECT
        'DOCUMENT' AS row_kind,
        period_documents.bsale_id,
        period_documents.emission_date,
        period_documents.document_type_id,
        period_documents.document_type_name,
        period_documents.folio,
        period_documents.net_amount,
        period_documents.sign_for_sales,
        summary.data_through,
        summary.total_documents,
        summary.total_contribution
    FROM period_documents
    CROSS JOIN summary
    ORDER BY row_kind DESC, emission_date, document_type_id, folio, bsale_id
    """.format(eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE)
)

SALES_PROVIDER_FAMILY_DETAIL_COMBINED_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.company_id,
            documents.bsale_id,
            documents.emission_date,
            documents.document_type_id,
            documents.document_type_name,
            documents.folio,
            documents.sign_for_sales,
            {classification} AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN documents.net_amount ELSE family_lines.line_net_amount END AS net_amount,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN 0 ELSE 1 END AS line_count
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_provider_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    ), family_catalog AS (
        SELECT family_key, MAX(family_name) AS family_name
        FROM classified_lines
        GROUP BY family_key
    ), family_documents AS (
        SELECT
            company_id,
            bsale_id,
            MAX(emission_date) AS emission_date,
            MAX(document_type_id) AS document_type_id,
            MAX(document_type_name) AS document_type_name,
            MAX(folio) AS folio,
            MAX(sign_for_sales) AS sign_for_sales,
            MAX(family_name) AS family_name,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS contribution,
            SUM(line_count)::integer AS line_count
        FROM classified_lines
        WHERE family_key = :family_key
          AND emission_date <= (SELECT MAX(emission_date) FROM eligible_documents)
          AND (CAST(:month AS integer) IS NULL OR EXTRACT(MONTH FROM emission_date)::integer = CAST(:month AS integer))
        GROUP BY company_id, bsale_id
    ), summary AS (
        SELECT
            catalog.family_name,
            (SELECT MAX(emission_date) FROM eligible_documents) AS data_through,
            COUNT(documents.bsale_id)::integer AS total_documents,
            COALESCE(SUM(documents.contribution), 0)::numeric AS total_contribution,
            COALESCE(SUM(documents.line_count), 0)::integer AS total_lines
        FROM family_catalog AS catalog
        LEFT JOIN family_documents AS documents ON TRUE
        WHERE catalog.family_key = :family_key
        GROUP BY catalog.family_name
    ), paged_documents AS (
        SELECT *
        FROM family_documents
        ORDER BY emission_date DESC, bsale_id DESC
        OFFSET :offset
        LIMIT :page_size
    )
    SELECT
        'SUMMARY' AS row_kind,
        NULL::bigint AS bsale_id,
        NULL::date AS emission_date,
        NULL::integer AS document_type_id,
        NULL::text AS document_type_name,
        NULL::integer AS folio,
        summary.family_name,
        NULL::numeric AS contribution,
        NULL::integer AS line_count,
        summary.data_through,
        summary.total_documents,
        summary.total_contribution,
        summary.total_lines
    FROM summary
    UNION ALL
    SELECT
        'DOCUMENT' AS row_kind,
        documents.bsale_id,
        documents.emission_date,
        documents.document_type_id,
        documents.document_type_name,
        documents.folio,
        documents.family_name,
        documents.contribution,
        documents.line_count,
        summary.data_through,
        summary.total_documents,
        summary.total_contribution,
        summary.total_lines
    FROM paged_documents AS documents
    CROSS JOIN summary
    ORDER BY row_kind DESC, emission_date DESC, bsale_id DESC
    """.format(
        eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE,
        classification=PROVIDER_FAMILY_CLASSIFICATION,
    )
)

SALES_DOCUMENT_LINES_SQL = text(
    """
    SELECT
        lines.company_id,
        lines.document_id,
        lines.folio,
        lines.emission_date,
        lines.document_total_amount,
        lines.document_net_amount,
        lines.document_tax_amount,
        lines.document_exempt_amount,
        lines.document_type_id,
        lines.document_type_name,
        lines.client_id,
        lines.client_name,
        lines.client_code,
        lines.office_id,
        lines.office_name,
        lines.sign_for_sales,
        lines.detail_id,
        lines.detail_bsale_id,
        lines.line_number,
        lines.variant_id,
        lines.sku,
        lines.barcode,
        lines.variant_name,
        lines.product_id,
        lines.product_name,
        lines.quantity,
        lines.unit_price,
        lines.net_amount,
        lines.discount,
        lines.tax_amount,
        lines.total_amount,
        lines.provider_key,
        lines.provider_name,
        lines.product_type_id,
        lines.family_name,
        lines.family_key_suffix
    FROM integraciones.vw_bsale_sales_document_lines AS lines
    WHERE lines.company_id = :company_id
      AND lines.document_id = :document_id
      AND lines.emission_date >= :date_from
      AND lines.emission_date < :date_to
    ORDER BY lines.line_number NULLS LAST, lines.detail_bsale_id
    """
)

SALES_BY_PROVIDER_FAMILY_SQL = text(
    """
    WITH eligible_documents AS (
        {eligible_documents}
    ), classified_lines AS (
        SELECT
            documents.emission_date, documents.sign_for_sales,
            COALESCE(family_lines.provider_key, 'unassigned') AS provider_key,
            COALESCE(family_lines.provider_name, 'SIN PROVEEDOR') AS provider_name,
            {classification} AS family_key,
            CASE
                WHEN family_lines.detail_bsale_id IS NULL
                    OR NULLIF(regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g'), '') IS NULL
                    THEN 'Sin clasificar'
                ELSE regexp_replace(btrim(family_lines.family_name), '\\s+', ' ', 'g')
            END AS family_name,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN documents.net_amount ELSE family_lines.line_net_amount END AS net_amount,
            CASE WHEN family_lines.detail_bsale_id IS NULL THEN 0 ELSE 1 END AS line_count
        FROM eligible_documents AS documents
        LEFT JOIN integraciones.vw_bsale_sales_provider_family_lines AS family_lines
          ON family_lines.company_id = documents.company_id
         AND family_lines.bsale_document_id = documents.bsale_id
    ), family_rows AS (
        SELECT 'FAMILY' AS row_type, provider_key, provider_name, family_key,
            MIN(family_name) AS family_name,
            EXTRACT(MONTH FROM emission_date)::integer AS month,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS amount,
            SUM(line_count)::integer AS line_count
        FROM classified_lines
        GROUP BY provider_key, provider_name, family_key, EXTRACT(MONTH FROM emission_date)::integer
    ), total_rows AS (
        SELECT 'TOTAL' AS row_type, NULL::text AS provider_key, NULL::text AS provider_name,
            NULL::text AS family_key, NULL::text AS family_name,
            EXTRACT(MONTH FROM emission_date)::integer AS month,
            SUM(COALESCE(net_amount, 0) * sign_for_sales)::numeric AS amount,
            NULL::integer AS line_count
        FROM eligible_documents
        GROUP BY EXTRACT(MONTH FROM emission_date)::integer
    )
    SELECT row_type, provider_key, provider_name, family_key, family_name, month, amount, line_count FROM family_rows
    UNION ALL
    SELECT row_type, provider_key, provider_name, family_key, family_name, month, amount, line_count FROM total_rows
    ORDER BY row_type, provider_key NULLS FIRST, family_key NULLS FIRST, month
    """.format(
        eligible_documents=SALES_ELIGIBLE_DOCUMENTS_CTE,
        classification=PROVIDER_FAMILY_CLASSIFICATION,
    )
)


def _money(value: Any) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_string(value: Decimal) -> str:
    return format(_money(value), "f")


def _date_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def build_sales_net_response(
    company_id: UUID,
    year: int,
    monthly_rows: list[dict[str, Any]],
    data_through: Any,
    documents_count: int,
    lines_count: int,
) -> dict[str, Any]:
    through = _date_string(data_through)
    through_month = int(through[5:7]) if through and through.startswith(f"{year:04d}-") else 0
    amounts = {
        int(row["month"]): _money(row.get("net_sales"))
        for row in monthly_rows
    }


    months = []
    ytd = Decimal("0.00")
    for month in range(1, 13):
        amount = amounts.get(month) if month <= through_month else None
        if amount is not None:
            ytd += amount
        months.append({
            "month": month,
            "amount": _money_string(amount) if amount is not None else None,
        })

    return {
        "company_id": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": SALES_SOURCE,
        "data_through": through,
        "has_information": data_through is not None,
        "documents_count": documents_count,
        "lines_count": lines_count,
        "months": months,
        "total_ytd": _money_string(ytd),
    }


def build_sales_net_detail_response(
    company_id: UUID,
    year: int,
    month: int | None,
    data_through: Any,
    detail_rows: list[dict[str, Any]],
    summary_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    through = _date_string(data_through)
    items = []
    total = _money(summary_row.get("total_contribution")) if summary_row else Decimal("0.00")

    for row in detail_rows:
        net_amount = _money(row.get("net_amount"))
        sign_for_sales = int(row.get("sign_for_sales") or 0)
        contribution = (net_amount * sign_for_sales).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)
        if summary_row is None:
            total += contribution
        items.append({
            "document_id": int(row["bsale_id"]),
            "emission_date": _date_string(row["emission_date"]),
            "document_type_id": int(row["document_type_id"]),
            "document_type": row.get("document_type_name") or "UNKNOWN",
            "folio": int(row["folio"]),
            "net_amount": _money_string(net_amount),
            "sign_for_sales": sign_for_sales,
            "contribution": _money_string(contribution),
        })

    return {
        "company_id": str(company_id),
        "year": year,
        "scope": "YTD" if month is None else "MONTH",
        "month": month,
        "data_through": through,
        "currency": "CLP",
        "documents_count": int(summary_row.get("total_documents") or 0) if summary_row else len(items),
        "total_net": _money_string(total),
        "items": items,
    }


def build_sales_net_family_detail_response(
    company_id: UUID,
    year: int,
    month: int | None,
    data_through: Any,
    family_key: str,
    detail_rows: list[dict[str, Any]],
    page: int,
    page_size: int,
    family_name: str | None = None,
    summary_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    through = _date_string(data_through)
    first = summary_row or (detail_rows[0] if detail_rows else {})
    total = _money(first.get("total_contribution"))
    line_count = int(first.get("total_lines") or 0)
    items = []
    for row in detail_rows:
        contribution = _money(row.get("contribution"))
        items.append({
            "date": _date_string(row.get("emission_date")),
            "emission_date": _date_string(row.get("emission_date")),
            "source": "BSALE",
            "document_id": int(row["bsale_id"]),
            "document_type_id": int(row["document_type_id"]),
            "document_type": row.get("document_type_name") or "UNKNOWN",
            "document_type_name": row.get("document_type_name") or "UNKNOWN",
            "folio": int(row["folio"]),
            "office_id": int(row["office_id"]) if row.get("office_id") is not None else None,
            "office_name": row.get("office_name"),
            "client_id": int(row["client_id"]) if row.get("client_id") is not None else None,
            "signed_net_amount": _money_string(contribution),
            "contribution": _money_string(contribution),
            "line_count": int(row.get("line_count") or 0),
        })

    return {
        "company_id": str(company_id),
        "year": year,
        "scope": "YTD" if month is None else "MONTH",
        "period": "YTD" if month is None else "MONTH",
        "month": month,
        "data_through": through,
        "currency": "CLP",
        "family_key": family_key,
        "family_name": first.get("family_name") or family_name,
        "source": "BSALE",
        "total": _money_string(total),
        "total_net": _money_string(total),
        "document_count": int(first.get("total_documents") or 0),
        "documents_count": int(first.get("total_documents") or 0),
        "line_count": line_count,
        "page": page,
        "page_size": page_size,
        "items": items,
    }


def build_sales_net_by_family_response(
    company_id: UUID,
    year: int,
    data_through: Any,
    aggregate_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    through = _date_string(data_through)
    through_month = int(through[5:7]) if through and through.startswith(f"{year:04d}-") else 0
    families: dict[str, dict[str, Any]] = {}
    totals: dict[int, Decimal] = {}

    for row in aggregate_rows:
        month = int(row["month"])
        amount = _money(row.get("amount"))
        if row["row_type"] == "TOTAL":
            totals[month] = amount
            continue

        key = str(row["family_key"])
        family = families.setdefault(key, {
            "key": key,
            "name": row["family_name"],
            "provider_key": row.get("provider_key"),
            "provider_name": row.get("provider_name"),
            "months": {},
            "ytd": Decimal("0.00"),
            "line_count": 0,
        })
        family["months"][str(month)] = _money_string(amount)
        family["ytd"] += amount
        family["line_count"] += int(row.get("line_count") or 0)

    family_payload = []
    for family in sorted(families.values(), key=lambda item: (item["name"].casefold(), item["key"])):
        family_months = {
            month: amount
            for month, amount in sorted(family["months"].items(), key=lambda item: int(item[0]))
            if int(month) <= through_month
        }
        family_ytd = sum((_money(amount) for amount in family_months.values()), Decimal("0.00"))
        family_payload.append({
            "family_key": family["key"],
            "family_name": family["name"],
            "provider_key": family["provider_key"],
            "provider_name": family["provider_name"],
            "months": family_months,
            "ytd": _money_string(family_ytd),
            "line_count": family["line_count"],
        })

    total_ytd = sum((amount for month, amount in totals.items() if month <= through_month), Decimal("0.00"))
    totals_payload = {
        "months": {
            str(month): _money_string(amount)
            for month, amount in sorted(totals.items())
            if month <= through_month
        },
        "ytd": _money_string(total_ytd),
    }

    family_by_month = {
        month: sum(
            (_money(family["months"].get(str(month))) for family in family_payload),
            Decimal("0.00"),
        )
        for month in totals_payload["months"]
    }
    for month, total in totals.items():
        if month <= through_month and family_by_month.get(str(month), Decimal("0.00")) != total:
            raise ValueError(f"Sales family reconciliation failed for month {month}")
    family_ytd = sum((_money(family["ytd"]) for family in family_payload), Decimal("0.00"))
    if family_ytd != total_ytd:
        raise ValueError("Sales family reconciliation failed for YTD")

    unclassified = next(
        (
            family for family in family_payload
            if family["provider_key"] == "unassigned" or family["family_key"] == "unclassified"
        ),
        None,
    )
    return {
        "company_id": str(company_id),
        "year": year,
        "through_date": through,
        "families": family_payload,
        "totals": totals_payload,
        "unclassified": {
            "line_count": unclassified["line_count"] if unclassified else 0,
            "amount_ytd": unclassified["ytd"] if unclassified else "0.00",
        },
    }


def get_monthly_net_sales(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    params = {
        "company_id": company_id,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    try:
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            monthly_result = session.execute(MONTHLY_NET_SALES_SQL, params)
            monthly_rows = [dict(row) for row in monthly_result.mappings().all()]
            metadata = session.execute(SALES_METADATA_SQL, params).mappings().one()
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial sales data is unavailable",
        ) from None

    return build_sales_net_response(
        company_id=company_id,
        year=year,
        monthly_rows=monthly_rows,
        data_through=metadata["data_through"],
        documents_count=int(metadata["documents_count"] or 0),
        lines_count=int(metadata["lines_count"] or 0),
    )


def get_sales_net_document_lines(
    company_id: UUID,
    year: int,
    document_id: int,
    provider_key: str | None = None,
    family_key: str | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    params = {
        "company_id": company_id,
        "document_id": document_id,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    try:
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            rows = [
                dict(row)
                for row in session.execute(SALES_DOCUMENT_LINES_SQL, params).mappings().all()
            ]
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial document lines are unavailable",
        ) from None

    if not rows:
        raise HTTPException(status_code=404, detail="Sales document not found")

    first = rows[0]
    sign = int(first.get("sign_for_sales") or 0)
    lines = []
    for row in rows:
        line_family_key = (
            f"{row['provider_key']}|{row['family_key_suffix']}"
            if row.get("provider_key")
            else None
        )
        quantity = row.get("quantity")
        net_amount = _money(row.get("net_amount"))
        tax_amount = _money(row.get("tax_amount"))
        total_amount = _money(row.get("total_amount"))
        lines.append({
            "detail_id": int(row["detail_id"]) if row.get("detail_id") is not None else None,
            "line_number": int(row["line_number"]) if row.get("line_number") is not None else None,
            "variant_id": int(row["variant_id"]) if row.get("variant_id") is not None else None,
            "product_id": int(row["product_id"]) if row.get("product_id") is not None else None,
            "sku": row.get("sku"),
            "barcode": row.get("barcode"),
            "product_name": row.get("product_name"),
            "variant_name": row.get("variant_name"),
            "quantity": str(quantity) if quantity is not None else None,
            "signed_quantity": str(quantity * sign) if quantity is not None else None,
            "unit_price": _money_string(row.get("unit_price")),
            "net_amount": _money_string(net_amount),
            "signed_net_amount": _money_string(net_amount * sign),
            "discount": _money_string(row.get("discount")),
            "tax_amount": _money_string(tax_amount),
            "signed_tax_amount": _money_string(tax_amount * sign),
            "total_amount": _money_string(total_amount),
            "signed_total_amount": _money_string(total_amount * sign),
            "family_key": line_family_key,
            "family_name": row.get("family_name"),
            "provider_key": row.get("provider_key"),
            "provider_name": row.get("provider_name"),
            "matches_selection": family_key is None or line_family_key == family_key,
        })

    return {
        "document": {
            "document_id": int(first["document_id"]),
            "folio": int(first["folio"]) if first.get("folio") is not None else None,
            "date": _date_string(first.get("emission_date")),
            "document_type_id": int(first["document_type_id"]) if first.get("document_type_id") is not None else None,
            "document_type": first.get("document_type_name") or "UNKNOWN",
            "office_id": int(first["office_id"]) if first.get("office_id") is not None else None,
            "office_name": first.get("office_name"),
            "client_id": int(first["client_id"]) if first.get("client_id") is not None else None,
            "client_name": first.get("client_name"),
            "client_code": first.get("client_code"),
            "net_amount": _money_string(first.get("document_net_amount")),
            "tax_amount": _money_string(first.get("document_tax_amount")),
            "total_amount": _money_string(first.get("document_total_amount")),
            "exempt_amount": _money_string(first.get("document_exempt_amount")),
            "sign_for_sales": sign,
        },
        "selection": {
            "provider_key": provider_key,
            "family_key": family_key,
        },
        "lines": lines,
    }


def get_sales_net_detail(
    company_id: UUID,
    year: int,
    month: int | None = None,
    family_key: str | None = None,
    page: int = 1,
    page_size: int = 100,
) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    params = {
        "company_id": company_id,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    try:
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            if family_key is None:
                rows = [
                    dict(row)
                    for row in session.execute(
                        SALES_DETAIL_COMBINED_SQL,
                        {**params, "month": month},
                    ).mappings().all()
                ]
            else:
                rows = [
                    dict(row)
                    for row in session.execute(
                        SALES_PROVIDER_FAMILY_DETAIL_COMBINED_SQL,
                        {
                            **params,
                            "month": month,
                            "family_key": family_key,
                            "offset": (page - 1) * page_size,
                            "page_size": page_size,
                        },
                    ).mappings().all()
                ]
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial sales detail is unavailable",
        ) from None

    if not rows:
        if family_key is not None:
            raise HTTPException(status_code=404, detail="Sales family not found")
        return build_sales_net_detail_response(company_id, year, month, None, [])

    summary_row = rows[0]
    detail_rows = rows[1:]
    data_through = summary_row.get("data_through")
    if family_key is not None:
        return build_sales_net_family_detail_response(
            company_id, year, month, data_through, family_key, detail_rows, page, page_size,
            family_name=summary_row.get("family_name"),
            summary_row=summary_row,
        )
    return build_sales_net_detail_response(
        company_id, year, month, data_through, detail_rows, summary_row=summary_row
    )


def get_sales_net_by_family(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    params = {
        "company_id": company_id,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    try:
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            metadata = session.execute(SALES_METADATA_SQL, params).mappings().one()
            aggregate_rows = [
                dict(row)
                for row in session.execute(SALES_BY_PROVIDER_FAMILY_SQL, params).mappings().all()
            ]
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial sales by family is unavailable",
        ) from None

    try:
        return build_sales_net_by_family_response(
            company_id=company_id,
            year=year,
            data_through=metadata["data_through"],
            aggregate_rows=aggregate_rows,
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial sales by family failed reconciliation",
        ) from None
