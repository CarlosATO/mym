from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import logging
from typing import Any
from uuid import UUID

import httpx
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.db.connection import get_session_factory


logger = logging.getLogger(__name__)
FINANCIAL_DAILY_REVIEW_CUTOFF = date(2026, 10, 1)
EXPENSES_SOURCE = "comercial.financial_bank_movements"
EXPENSE_CATEGORIES = (
    "EXPENSE_SOFTWARE_SUBSCRIPTIONS",
    "EXPENSE_OFFICE_CONSUMPTION",
    "EXPENSE_VEHICLE_OPERATING",
    "EXPENSE_NOTARY",
    "EXPENSE_BANK_FEES",
    "EXPENSE_FINANCIAL_INTEREST",
    "EXPENSE_INSURANCE",
    "EXPENSE_TELECOM",
    "EXPENSE_EXTERNAL_SERVICES",
)
OPERATING_CATEGORIES = EXPENSE_CATEGORIES[:5] + EXPENSE_CATEGORIES[6:]
MONEY_QUANTUM = Decimal("0.01")

MONTHLY_EXPENSES_SQL = text(
    """
    WITH approved_categories AS (
        SELECT code
        FROM comercial.financial_categories
        WHERE company_id = :company_id
          AND is_active
          AND parent_id IS NOT NULL
          AND code IN (
            'EXPENSE_SOFTWARE_SUBSCRIPTIONS',
            'EXPENSE_OFFICE_CONSUMPTION',
            'EXPENSE_VEHICLE_OPERATING',
            'EXPENSE_NOTARY',
            'EXPENSE_BANK_FEES',
            'EXPENSE_FINANCIAL_INTEREST',
            'EXPENSE_INSURANCE',
            'EXPENSE_TELECOM',
            'EXPENSE_EXTERNAL_SERVICES'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM comercial.financial_categories child
            WHERE child.company_id = :company_id
              AND child.parent_id = financial_categories.id
              AND child.is_active
          )
    ),
    movements AS (
        SELECT
            EXTRACT(MONTH FROM movement.transaction_date)::integer AS month,
            category.code AS category_code,
            COALESCE(SUM(movement.debit_amount), 0)::numeric AS amount
        FROM comercial.financial_bank_movements AS movement
        JOIN comercial.financial_categories AS category
          ON category.company_id = movement.company_id
         AND category.id = movement.category_id
        JOIN approved_categories AS approved
          ON approved.code = category.code
        WHERE movement.company_id = :company_id
          AND movement.transaction_date >= :date_from
          AND movement.transaction_date < :date_to
          AND (movement.transaction_date < DATE '2026-10-01' OR movement.review_status = 'REVIEWED')
        GROUP BY EXTRACT(MONTH FROM movement.transaction_date)::integer, category.code
    )
    SELECT
        statement.month,
        statement.last_transaction_date,
        movements.category_code,
        movements.amount
    FROM comercial.financial_statement_periods AS statement
    LEFT JOIN movements
      ON movements.month = statement.month
    WHERE statement.company_id = :company_id
      AND statement.year = :year
    ORDER BY statement.month, movements.category_code
    """
)

REVIEW_SUMMARY_SQL = text(
    """
    SELECT
      count(*) FILTER (WHERE direction = 'DEBE' AND transaction_date >= DATE '2026-10-01' AND review_status = 'PENDING') AS pending_review_count,
      coalesce(sum(debit_amount) FILTER (WHERE direction = 'DEBE' AND transaction_date < DATE '2026-10-01' AND category_id IN (
        SELECT id FROM comercial.financial_categories WHERE company_id = :company_id AND code IN ('EXPENSE_OPERATING_PENDING', 'EXPENSE_AGROVET_PENDING')
      )), 0)::numeric AS pending_historical_amount
    FROM comercial.financial_bank_movements
    WHERE company_id = :company_id
    """
)


def _money(value: Any) -> Decimal:
    if value is None:
        return Decimal("0.00")
    return Decimal(str(value)).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_string(value: Decimal | None) -> str | None:
    return format(_money(value), "f") if value is not None else None


def _sum(values: list[Decimal]) -> Decimal:
    return sum(values, Decimal("0.00"))


def _date_string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _supabase_headers(settings: Any) -> tuple[str, dict[str, str]] | None:
    if settings.supabase_url is None or settings.supabase_service_role_key is None:
        return None
    key = settings.supabase_service_role_key.get_secret_value()
    return settings.supabase_url.rstrip("/"), {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept-Profile": "comercial",
    }


def _supabase_get(settings: Any, table: str, params: dict[str, str] | list[tuple[str, str]]) -> list[dict[str, Any]]:
    connection = _supabase_headers(settings)
    if connection is None:
        raise RuntimeError("Supabase service role is not configured")
    base_url, headers = connection
    response = httpx.get(
        f"{base_url}/rest/v1/{table}",
        headers=headers,
        params=params,
        timeout=5.0,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected Supabase response for {table}")
    return payload


def _get_expenses_from_supabase(settings: Any, company_id: UUID, year: int) -> dict[str, Any]:
    company = str(company_id)
    categories = _supabase_get(
        settings,
        "financial_categories",
        {
            "select": "id,code",
            "company_id": f"eq.{company}",
            "is_active": "eq.true",
            "code": f"in.({','.join(EXPENSE_CATEGORIES)})",
        },
    )
    category_codes = {row["id"]: row["code"] for row in categories}
    if set(category_codes.values()) != set(EXPENSE_CATEGORIES):
        raise RuntimeError("Required expense categories are unavailable")

    statement_rows = _supabase_get(
        settings,
        "financial_statement_periods",
        {
            "select": "month,last_transaction_date",
            "company_id": f"eq.{company}",
            "year": f"eq.{year}",
            "order": "month.asc",
        },
    )
    bank_rows = _supabase_get(
        settings,
        "financial_bank_movements",
        [
            ("select", "transaction_date,debit_amount,category_id,review_status"),
            ("company_id", f"eq.{company}"),
            ("transaction_date", f"gte.{year}-01-01"),
            ("transaction_date", f"lt.{year + 1}-01-01"),
            ("category_id", f"in.({','.join(category_codes)})"),
        ],
    )
    pending_rows = _supabase_get(
        settings,
        "financial_bank_movements",
        [
            ("select", "id"),
            ("company_id", f"eq.{company}"),
            ("direction", "eq.DEBE"),
            ("transaction_date", f"gte.{FINANCIAL_DAILY_REVIEW_CUTOFF.isoformat()}"),
            ("review_status", "eq.PENDING"),
        ],
    )
    pending_categories = _supabase_get(
        settings,
        "financial_categories",
        {"select": "id", "company_id": f"eq.{company}", "code": "in.(EXPENSE_OPERATING_PENDING,EXPENSE_AGROVET_PENDING)"},
    )
    pending_category_ids = {row["id"] for row in pending_categories}
    historical_pending_rows = _supabase_get(
        settings,
        "financial_bank_movements",
        [
            ("select", "debit_amount,category_id"),
            ("company_id", f"eq.{company}"),
            ("direction", "eq.DEBE"),
            ("transaction_date", f"lt.{FINANCIAL_DAILY_REVIEW_CUTOFF.isoformat()}"),
        ],
    )
    historical_pending_amount = sum(
        (_money(row.get("debit_amount")) for row in historical_pending_rows if row.get("category_id") in pending_category_ids),
        Decimal("0.00"),
    )

    aggregates: dict[tuple[int, str], Decimal] = {}
    for row in bank_rows:
        month = date.fromisoformat(row["transaction_date"]).month
        category = category_codes[row["category_id"]]
        if date.fromisoformat(row["transaction_date"]) >= FINANCIAL_DAILY_REVIEW_CUTOFF and row.get("review_status") != "REVIEWED":
            continue
        key = (month, category)
        aggregates[key] = aggregates.get(key, Decimal("0")) + _money(row.get("debit_amount"))
    movement_rows = [
        {"month": month, "category_code": category, "amount": amount}
        for (month, category), amount in sorted(aggregates.items())
    ]
    return build_expenses_response(company_id, year, statement_rows, movement_rows, len(pending_rows), historical_pending_amount)


def build_expenses_response(
    company_id: UUID,
    year: int,
    statement_rows: list[dict[str, Any]],
    movement_rows: list[dict[str, Any]],
    pending_review_count: int = 0,
    pending_historical_amount: Decimal = Decimal("0.00"),
) -> dict[str, Any]:
    covered_months = sorted({int(row["month"]) for row in statement_rows})
    covered_set = set(covered_months)
    missing_months = [month for month in range(1, 13) if month not in covered_set]
    data_through = max(
        (_date_string(row.get("last_transaction_date")) for row in statement_rows),
        default=None,
    )
    by_month: dict[int, dict[str, Decimal]] = {}
    for row in movement_rows:
        month = int(row["month"])
        category = str(row["category_code"])
        if category not in EXPENSE_CATEGORIES or month not in covered_set:
            continue
        by_month.setdefault(month, {})[category] = _money(row.get("amount"))

    def values_for(month: int) -> dict[str, Decimal | None]:
        if month not in covered_set:
            return {category: None for category in EXPENSE_CATEGORIES}
        values = by_month.get(month, {})
        return {category: values.get(category, Decimal("0.00")) for category in EXPENSE_CATEGORIES}

    months: list[dict[str, Any]] = []
    for month in range(1, 13):
        values = values_for(month)
        operating = None if month not in covered_set else _sum([values[category] for category in OPERATING_CATEGORIES if values[category] is not None])
        financial = values[EXPENSE_CATEGORIES[5]]
        months.append(
            {
                "month": month,
                "status": "AVAILABLE" if month in covered_set else "MISSING",
                "softwareSubscriptions": _money_string(values[EXPENSE_CATEGORIES[0]]),
                "officeConsumption": _money_string(values[EXPENSE_CATEGORIES[1]]),
                "vehicleOperating": _money_string(values[EXPENSE_CATEGORIES[2]]),
                "notaryServices": _money_string(values[EXPENSE_CATEGORIES[3]]),
                "bankFees": _money_string(values[EXPENSE_CATEGORIES[4]]),
                "insurance": _money_string(values[EXPENSE_CATEGORIES[6]]),
                "telecom": _money_string(values[EXPENSE_CATEGORIES[7]]),
                "externalServices": _money_string(values[EXPENSE_CATEGORIES[8]]),
                "operatingIdentifiedTotal": _money_string(operating),
                "financialInterest": _money_string(financial),
                "nonOperatingIdentifiedTotal": _money_string(financial),
            }
        )

    available_rows = [month for month in months if month["status"] == "AVAILABLE"]

    def available_sum(field: str) -> Decimal:
        return _sum([_money(row[field]) for row in available_rows])

    coverage_status = "MISSING" if not covered_months else "COMPLETE" if len(covered_months) == 12 else "INCOMPLETE"
    coverage = {
        "availableMonths": covered_months,
        "missingMonths": missing_months,
        "latestAvailableMonth": max(covered_months) if covered_months else None,
        "coverageStatus": coverage_status,
    }
    ytd = {
        "status": coverage_status,
        **coverage,
        "softwareSubscriptions": _money_string(available_sum("softwareSubscriptions")) if available_rows else None,
        "officeConsumption": _money_string(available_sum("officeConsumption")) if available_rows else None,
        "vehicleOperating": _money_string(available_sum("vehicleOperating")) if available_rows else None,
        "notaryServices": _money_string(available_sum("notaryServices")) if available_rows else None,
        "bankFees": _money_string(available_sum("bankFees")) if available_rows else None,
        "insurance": _money_string(available_sum("insurance")) if available_rows else None,
        "telecom": _money_string(available_sum("telecom")) if available_rows else None,
        "externalServices": _money_string(available_sum("externalServices")) if available_rows else None,
        "operatingIdentifiedTotal": _money_string(available_sum("operatingIdentifiedTotal")) if available_rows else None,
        "financialInterest": _money_string(available_sum("financialInterest")) if available_rows else None,
        "nonOperatingIdentifiedTotal": _money_string(available_sum("nonOperatingIdentifiedTotal")) if available_rows else None,
    }
    return {
        "companyId": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": EXPENSES_SOURCE,
        "dataThrough": data_through,
        "months": months,
        "coverage": coverage,
        "ytd": ytd,
        "pendingReviewCount": pending_review_count,
        "pendingHistoricalAmount": _money_string(pending_historical_amount),
        "historicalCoverageNote": "Histórico ene–sep 2026 basado en fecha de movimiento bancario.",
    }


def get_monthly_expenses(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None and _supabase_headers(settings) is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )
    params = {
        "company_id": company_id,
        "year": year,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    try:
        if _supabase_headers(settings) is not None:
            return _get_expenses_from_supabase(settings, company_id, year)
        with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
            rows = [dict(row) for row in session.execute(MONTHLY_EXPENSES_SQL, params).mappings().all()]
            review_summary = dict(session.execute(REVIEW_SUMMARY_SQL, {"company_id": company_id}).mappings().one())
    except (SQLAlchemyError, OSError, httpx.HTTPError, RuntimeError):
        logger.exception(
            "financial expenses query failed",
            extra={
                "company_id": str(company_id),
                "year": year,
                "source": "supabase_rest" if _supabase_headers(settings) is not None else "database",
            },
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial expenses data is unavailable",
        ) from None

    statement_rows = [
        {"month": row["month"], "last_transaction_date": row["last_transaction_date"]}
        for row in rows
    ]
    movement_rows = [
        row for row in rows if row.get("category_code") is not None
    ]
    return build_expenses_response(
        company_id,
        year,
        statement_rows,
        movement_rows,
        int(review_summary["pending_review_count"]),
        _money(review_summary["pending_historical_amount"]),
    )
