from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.db.connection import get_session_factory


COGS_SOURCE = (
    "integraciones.bsale_document_costs.total_cost - "
    "integraciones.bsale_credit_note_cogs_resolutions.reversal_cogs"
)
MONEY_QUANTUM = Decimal("0.01")


MONTHLY_COGS_SQL = text(
    """
    WITH eligible_sales_documents AS (
        SELECT DISTINCT
            normalized.company_id,
            normalized.bsale_id,
            normalized.emission_date
        FROM integraciones.vw_bsale_documents_normalized AS normalized
        WHERE normalized.company_id = :company_id
          AND normalized.emission_date >= :date_from
          AND normalized.emission_date < :date_to
          AND normalized.document_type_id IN (1, 5)
          AND normalized.include_in_replenishment = TRUE
          AND normalized.sign_for_sales IN (1, -1)
          AND normalized.business_category IN ('sale', 'reversal')
    ),
    sales_costs AS (
        SELECT
            eligible.company_id,
            eligible.bsale_id,
            eligible.emission_date,
            costs.total_cost,
            costs.status
        FROM eligible_sales_documents AS eligible
        LEFT JOIN integraciones.bsale_document_costs AS costs
          ON costs.company_id = eligible.company_id
         AND costs.bsale_document_id = eligible.bsale_id
    ),
    gross_monthly AS (
        SELECT
            EXTRACT(MONTH FROM emission_date)::integer AS month,
            SUM(
                CASE WHEN status IN ('OBSERVED', 'ZERO_WITH_EVIDENCE') THEN COALESCE(total_cost, 0)
                     ELSE NULL END
            )::numeric AS gross_cogs,
            COUNT(*) FILTER (WHERE status = 'OBSERVED')::integer AS observed_document_count,
            COUNT(*) FILTER (WHERE status = 'ZERO_WITH_EVIDENCE')::integer AS zero_evidence_document_count,
            COUNT(*) FILTER (WHERE status IN ('OBSERVED', 'ZERO_WITH_EVIDENCE'))::integer AS resolved_document_count,
            COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'OBSERVED' AND status IS DISTINCT FROM 'ZERO_WITH_EVIDENCE')::integer AS missing_document_count,
            MAX(emission_date) AS data_through
        FROM sales_costs
        GROUP BY EXTRACT(MONTH FROM emission_date)::integer
    ),
    eligible_credit_notes AS (
        SELECT DISTINCT
            normalized.company_id,
            normalized.bsale_id,
            normalized.emission_date
        FROM integraciones.vw_bsale_documents_normalized AS normalized
        WHERE normalized.company_id = :company_id
          AND normalized.emission_date >= :date_from
          AND normalized.emission_date < :date_to
          AND normalized.document_type_id = 2
          AND normalized.include_in_replenishment = TRUE
          AND normalized.sign_for_sales IN (1, -1)
          AND normalized.business_category IN ('sale', 'reversal')
    ),
    reversal_monthly AS (
        SELECT
            EXTRACT(MONTH FROM eligible.emission_date)::integer AS month,
            SUM(resolution.reversal_cogs)::numeric AS credit_note_reversal,
            MAX(eligible.emission_date) AS data_through
        FROM eligible_credit_notes AS eligible
        JOIN integraciones.bsale_credit_note_cogs_resolutions AS resolution
          ON resolution.company_id = eligible.company_id
         AND resolution.bsale_credit_note_id = eligible.bsale_id
        GROUP BY EXTRACT(MONTH FROM eligible.emission_date)::integer
    ),
    monthly AS (
        SELECT
            COALESCE(gross.month, reversal.month) AS month,
            gross.gross_cogs,
            reversal.credit_note_reversal,
            COALESCE(gross.observed_document_count, 0)::integer AS observed_document_count,
            COALESCE(gross.zero_evidence_document_count, 0)::integer AS zero_evidence_document_count,
            COALESCE(gross.resolved_document_count, 0)::integer AS resolved_document_count,
            COALESCE(gross.missing_document_count, 0)::integer AS missing_document_count,
            COALESCE(gross.data_through, reversal.data_through) AS data_through
        FROM gross_monthly AS gross
        FULL OUTER JOIN reversal_monthly AS reversal ON reversal.month = gross.month
    )
    SELECT
        month,
        gross_cogs,
         credit_note_reversal,
         observed_document_count,
         zero_evidence_document_count,
         resolved_document_count,
         missing_document_count,
        data_through,
        MAX(data_through) OVER () AS overall_data_through
    FROM monthly
    ORDER BY month
    """
)


PROVIDER_COGS_SOURCE = "integraciones.vw_bsale_provider_cogs_monthly"
FAMILY_COGS_SOURCE = "integraciones.vw_bsale_provider_family_cogs_monthly"
PROVIDER_COGS_SQL = text(
    """
    SELECT
        'PROVIDER' AS row_type,
        month,
        provider_key,
        provider_name,
        NULL::text AS family_key,
        NULL::text AS family_name,
        gross_cogs,
        credit_note_reversal
    FROM integraciones.vw_bsale_provider_cogs_monthly
    WHERE company_id = :company_id
      AND year = :year
    UNION ALL
    SELECT
        'FAMILY' AS row_type,
        month,
        provider_key,
        provider_name,
        family_key,
        family_name,
        gross_cogs,
        credit_note_reversal
    FROM integraciones.vw_bsale_provider_family_cogs_monthly
    WHERE company_id = :company_id
      AND year = :year
    ORDER BY row_type, month, provider_key, family_key
    """
)


def _money(value: Any) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_string(value: Decimal | None) -> str | None:
    return format(_money(value), "f") if value is not None else None


def _date_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _coverage(observed: int, missing: int) -> str:
    return "INCOMPLETE" if missing > 0 else "COMPLETE"


def build_cogs_response(
    company_id: UUID,
    year: int,
    monthly_rows: list[dict[str, Any]],
    data_through: Any,
) -> dict[str, Any]:
    through = _date_string(data_through)
    through_month = int(through[5:7]) if through and through.startswith(f"{year:04d}-") else 0
    by_month = {int(row["month"]): row for row in monthly_rows}
    months: list[dict[str, Any]] = []
    ytd_gross = Decimal("0.00")
    ytd_reversal = Decimal("0.00")
    ytd_observed = 0
    ytd_zero_evidence = 0
    ytd_resolved = 0
    ytd_missing = 0

    for month in range(1, 13):
        row = by_month.get(month) if month <= through_month else None
        if row is None:
            months.append({
                "month": month,
                "gross_cogs": None,
                "credit_note_reversal": None,
                "net_cogs": None,
                "observed_document_count": None,
                "missing_document_count": None,
                "coverage_status": None,
            })
            continue

        raw_gross = row.get("gross_cogs")
        reversal = _money(row.get("credit_note_reversal"))
        observed = int(row.get("observed_document_count") or 0)
        zero_evidence = int(row.get("zero_evidence_document_count") or 0)
        resolved = int(row.get("resolved_document_count") or observed + zero_evidence)
        missing = int(row.get("missing_document_count") or 0)
        gross = _money(raw_gross) if raw_gross is not None else None
        ytd_gross += gross or Decimal("0.00")
        ytd_reversal += reversal
        ytd_observed += observed
        ytd_zero_evidence += zero_evidence
        ytd_resolved += resolved
        ytd_missing += missing
        net = gross - reversal if gross is not None else None
        months.append({
            "month": month,
            "gross_cogs": _money_string(gross),
            "credit_note_reversal": _money_string(reversal),
            "net_cogs": _money_string(net),
            "observed_document_count": observed,
            "zero_evidence_document_count": zero_evidence,
            "resolved_document_count": resolved,
            "missing_document_count": missing,
            "coverage_status": _coverage(resolved, missing),
        })

    has_information = data_through is not None
    ytd = {
        "gross_cogs": _money_string(ytd_gross) if has_information else None,
        "credit_note_reversal": _money_string(ytd_reversal) if has_information else None,
        "net_cogs": _money_string(ytd_gross - ytd_reversal) if has_information else None,
        "observed_document_count": ytd_observed if has_information else None,
        "zero_evidence_document_count": ytd_zero_evidence if has_information else None,
        "resolved_document_count": ytd_resolved if has_information else None,
        "missing_document_count": ytd_missing if has_information else None,
        "coverage_status": _coverage(ytd_resolved, ytd_missing) if has_information else None,
    }
    return {
        "company_id": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": COGS_SOURCE,
        "data_through": through,
        "has_information": has_information,
        "months": months,
        "ytd": ytd,
    }


def build_provider_cogs_response(
    company_id: UUID,
    year: int,
    monthly_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Aggregate the provider COGS view to YTD using the same month cutoff as the engine."""
    through_month = max((int(row["month"]) for row in monthly_rows), default=0)
    providers: dict[str, dict[str, Any]] = {}
    families: dict[str, dict[str, Any]] = {}
    for row in monthly_rows:
        if int(row["month"]) > through_month:
            continue
        row_type = str(row.get("row_type") or "PROVIDER")
        key = str(row["provider_key"])
        target = families if row_type == "FAMILY" else providers
        aggregate_key = str(row.get("family_key")) if row_type == "FAMILY" else key
        item = target.setdefault(aggregate_key, {
            "provider_key": key,
            "provider_name": row.get("provider_name") or "SIN PROVEEDOR",
            "family_key": row.get("family_key"),
            "family_name": row.get("family_name") or "Sin clasificar",
            "gross": Decimal("0.00"),
            "reversal": Decimal("0.00"),
        })
        item["gross"] += _money(row.get("gross_cogs"))
        item["reversal"] += _money(row.get("credit_note_reversal"))

    payload = []
    for provider in sorted(
        providers.values(),
        key=lambda item: (item["provider_name"].casefold(), item["provider_key"]),
    ):
        payload.append({
            "provider_key": provider["provider_key"],
            "provider_name": provider["provider_name"],
            "gross_cogs_ytd": _money_string(provider["gross"]),
            "credit_note_reversal_ytd": _money_string(provider["reversal"]),
            "net_cogs_ytd": _money_string(provider["gross"] - provider["reversal"]),
        })

    family_payload = []
    for family in sorted(
        families.values(),
        key=lambda item: (item["provider_name"].casefold(), item["family_name"].casefold(), item["family_key"]),
    ):
        family_payload.append({
            "provider_key": family["provider_key"],
            "provider_name": family["provider_name"],
            "family_key": family["family_key"],
            "family_name": family["family_name"],
            "gross_cogs_ytd": _money_string(family["gross"]),
            "credit_note_reversal_ytd": _money_string(family["reversal"]),
            "net_cogs_ytd": _money_string(family["gross"] - family["reversal"]),
        })

    return {
        "company_id": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": PROVIDER_COGS_SOURCE,
        "has_information": bool(monthly_rows),
        "through_month": through_month or None,
        "providers": payload,
        "families": family_payload,
    }


def get_provider_cogs(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    params = {"company_id": company_id, "year": year}
    try:
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            rows = [
                dict(row)
                for row in session.execute(PROVIDER_COGS_SQL, params).mappings().all()
            ]
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial provider COGS data is unavailable",
        ) from None

    return build_provider_cogs_response(company_id, year, rows)


def get_monthly_cogs(company_id: UUID, year: int) -> dict[str, Any]:
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
            result = session.execute(MONTHLY_COGS_SQL, params)
            rows = [dict(row) for row in result.mappings().all()]
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial COGS data is unavailable",
        ) from None

    data_through = rows[0]["overall_data_through"] if rows else None
    return build_cogs_response(company_id, year, rows, data_through)
