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
    "integraciones.vw_bsale_documents_normalized + "
    "integraciones.bsale_documents.net_amount"
)
MONEY_QUANTUM = Decimal("0.01")


MONTHLY_NET_SALES_SQL = text(
    """
    WITH eligible_documents AS (
        SELECT DISTINCT
            normalized.company_id,
            normalized.bsale_id,
            normalized.emission_date,
            normalized.sign_for_sales,
            documents.net_amount
        FROM integraciones.vw_bsale_documents_normalized AS normalized
        JOIN integraciones.bsale_documents AS documents
          ON documents.company_id = normalized.company_id
         AND documents.bsale_id = normalized.bsale_id
        WHERE normalized.company_id = :company_id
          AND normalized.emission_date >= :date_from
          AND normalized.emission_date < :date_to
          AND normalized.include_in_replenishment = TRUE
          AND normalized.sign_for_sales IN (1, -1)
          AND normalized.business_category IN ('sale', 'reversal')
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
    """
)

SALES_METADATA_SQL = text(
    """
    WITH eligible_documents AS (
        SELECT DISTINCT
            normalized.company_id,
            normalized.bsale_id,
            normalized.emission_date
        FROM integraciones.vw_bsale_documents_normalized AS normalized
        JOIN integraciones.bsale_documents AS documents
          ON documents.company_id = normalized.company_id
         AND documents.bsale_id = normalized.bsale_id
        WHERE normalized.company_id = :company_id
          AND normalized.emission_date >= :date_from
          AND normalized.emission_date < :date_to
          AND normalized.include_in_replenishment = TRUE
          AND normalized.sign_for_sales IN (1, -1)
          AND normalized.business_category IN ('sale', 'reversal')
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
    """
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
