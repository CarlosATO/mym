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

PERSONNEL_SOURCE = (
    "comercial.financial_payroll_imports + "
    "comercial.financial_bank_movements"
)
MONEY_QUANTUM = Decimal("0.01")
PERSONNEL_CATEGORIES = ("EXPENSE_PERSONNEL_OFF_BOOK", "EXPENSE_SALARIES_OTHER")

PERSONNEL_PAYROLL_SQL = text(
    """
    SELECT
        period_month AS month,
        COUNT(*)::integer AS import_count,
        SUM(total_earnings)::numeric AS formal_earnings,
        SUM(total_employer_contributions)::numeric AS employer_contributions,
        SUM(total_earnings + total_employer_contributions)::numeric AS formal_labor_cost,
        SUM(recurring_labor_cost)::numeric AS recurring_labor_cost,
        SUM(total_indemnities)::numeric AS indemnities,
        SUM(worker_count)::integer AS worker_count
    FROM comercial.financial_payroll_imports
    WHERE company_id = :company_id
      AND period_year = :year
      AND status = 'IMPORTED'
    GROUP BY period_month
    ORDER BY period_month
    """
)

PERSONNEL_BANK_SQL = text(
    """
    SELECT
        EXTRACT(MONTH FROM movements.transaction_date)::integer AS month,
        categories.code AS category_code,
        COALESCE(SUM(movements.debit_amount), 0)::numeric AS amount
    FROM comercial.financial_bank_movements AS movements
    JOIN comercial.financial_categories AS categories
      ON categories.company_id = movements.company_id
     AND categories.id = movements.category_id
    WHERE movements.company_id = :company_id
      AND movements.transaction_date >= :date_from
      AND movements.transaction_date < :date_to
      AND categories.code IN ('EXPENSE_PERSONNEL_OFF_BOOK', 'EXPENSE_SALARIES_OTHER')
    GROUP BY EXTRACT(MONTH FROM movements.transaction_date)::integer, categories.code
    ORDER BY month, category_code
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


def _coverage_status(available_months: list[int]) -> str:
    if not available_months:
        return "MISSING"
    if len(available_months) < 12:
        return "INCOMPLETE"
    return "COMPLETE"


def build_personnel_response(
    company_id: UUID,
    year: int,
    payroll_rows: list[dict[str, Any]],
    bank_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    payroll_by_month = {int(row["month"]): row for row in payroll_rows}
    bank_by_month: dict[int, dict[str, Decimal]] = {}
    for row in bank_rows:
        month = int(row["month"])
        category = str(row["category_code"])
        bank_by_month.setdefault(month, {})[category] = _money(row.get("amount"))

    months: list[dict[str, Any]] = []
    available_months: list[int] = []
    for month in range(1, 13):
        payroll = payroll_by_month.get(month)
        is_available = payroll is not None and int(payroll.get("import_count") or 0) == 1
        bank = bank_by_month.get(month, {})
        off_book = bank.get("EXPENSE_PERSONNEL_OFF_BOOK", Decimal("0.00"))
        salaries_other = bank.get("EXPENSE_SALARIES_OTHER", Decimal("0.00"))

        if is_available:
            available_months.append(month)
            formal_earnings = _money(payroll.get("formal_earnings"))
            employer_contributions = _money(payroll.get("employer_contributions"))
            formal_labor_cost = formal_earnings + employer_contributions
            recurring_labor_cost = _money(payroll.get("recurring_labor_cost"))
            indemnities = _money(payroll.get("indemnities"))
            worker_count = int(payroll.get("worker_count") or 0)
            total_personnel = formal_labor_cost + off_book + salaries_other
        else:
            formal_earnings = None
            employer_contributions = None
            formal_labor_cost = None
            recurring_labor_cost = None
            indemnities = None
            worker_count = None
            total_personnel = None

        months.append(
            {
                "month": month,
                "status": "AVAILABLE" if is_available else "MISSING",
                "formalEarnings": _money_string(formal_earnings),
                "employerContributions": _money_string(employer_contributions),
                "formalLaborCost": _money_string(formal_labor_cost),
                "recurringLaborCost": _money_string(recurring_labor_cost),
                "indemnities": _money_string(indemnities),
                "workerCount": worker_count,
                "offBook": _money_string(off_book),
                "salariesOther": _money_string(salaries_other),
                "totalPersonnel": _money_string(total_personnel),
            }
        )

    missing_months = [month for month in range(1, 13) if month not in available_months]
    available_rows = [months[month - 1] for month in available_months]

    def available_sum(field: str) -> Decimal:
        return _sum([_money(row[field]) for row in available_rows])

    bank_rows_for_ytd = available_rows if available_rows else months
    available_off_book = _sum([_money(row["offBook"]) for row in bank_rows_for_ytd])
    available_salaries_other = _sum([_money(row["salariesOther"]) for row in bank_rows_for_ytd])

    available_total = {
        "formalEarnings": _money_string(available_sum("formalEarnings")) if available_rows else None,
        "employerContributions": _money_string(available_sum("employerContributions")) if available_rows else None,
        "formalLaborCost": _money_string(available_sum("formalLaborCost")) if available_rows else None,
        "recurringLaborCost": _money_string(available_sum("recurringLaborCost")) if available_rows else None,
        "indemnities": _money_string(available_sum("indemnities")) if available_rows else None,
        "offBook": _money_string(available_off_book),
        "salariesOther": _money_string(available_salaries_other),
        "totalPersonnel": _money_string(
            available_sum("formalLaborCost")
            + available_off_book
            + available_salaries_other
        ) if available_rows else None,
    }
    coverage_status = _coverage_status(available_months)
    coverage = {
        "availableMonths": available_months,
        "missingMonths": missing_months,
        "latestAvailableMonth": max(available_months) if available_months else None,
        "coverageStatus": coverage_status,
    }

    return {
        "companyId": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": PERSONNEL_SOURCE,
        "months": months,
        "coverage": coverage,
        "ytd": {
            "status": coverage_status,
            "availableMonths": available_months,
            "missingMonths": missing_months,
            "latestAvailableMonth": coverage["latestAvailableMonth"],
            "availableTotal": available_total,
        },
    }


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


def _get_personnel_from_supabase(settings: Any, company_id: UUID, year: int) -> dict[str, Any]:
    company = str(company_id)
    payroll_rows = _supabase_get(
        settings,
        "financial_payroll_imports",
        {
            "select": "period_month,total_earnings,total_employer_contributions,recurring_labor_cost,total_indemnities,worker_count,status",
            "company_id": f"eq.{company}",
            "period_year": f"eq.{year}",
            "status": "eq.IMPORTED",
            "order": "period_month.asc",
        },
    )
    categories = _supabase_get(
        settings,
        "financial_categories",
        {
            "select": "id,code",
            "company_id": f"eq.{company}",
            "code": "in.(EXPENSE_PERSONNEL_OFF_BOOK,EXPENSE_SALARIES_OTHER)",
        },
    )
    category_codes = {row["id"]: row["code"] for row in categories}
    if set(category_codes.values()) != set(PERSONNEL_CATEGORIES):
        raise RuntimeError("Required personnel categories are unavailable")

    bank_rows = _supabase_get(
        settings,
        "financial_bank_movements",
        [
            ("select", "transaction_date,debit_amount,category_id"),
            ("company_id", f"eq.{company}"),
            ("transaction_date", f"gte.{year}-01-01"),
            ("transaction_date", f"lt.{year + 1}-01-01"),
            ("category_id", f"in.({','.join(category_codes)})"),
        ],
    )

    payroll_by_month: dict[int, list[dict[str, Any]]] = {}
    for row in payroll_rows:
        payroll_by_month.setdefault(int(row["period_month"]), []).append(row)
    payroll_aggregates = []
    for month, rows in payroll_by_month.items():
        payroll_aggregates.append(
            {
                "month": month,
                "import_count": len(rows),
                "formal_earnings": sum(Decimal(str(row["total_earnings"])) for row in rows),
                "employer_contributions": sum(Decimal(str(row["total_employer_contributions"])) for row in rows),
                "recurring_labor_cost": sum(Decimal(str(row["recurring_labor_cost"])) for row in rows),
                "indemnities": sum(Decimal(str(row["total_indemnities"])) for row in rows),
                "worker_count": sum(int(row["worker_count"]) for row in rows),
            }
        )

    bank_aggregates: dict[tuple[int, str], Decimal] = {}
    for row in bank_rows:
        month = date.fromisoformat(row["transaction_date"]).month
        code = category_codes[row["category_id"]]
        key = (month, code)
        bank_aggregates[key] = bank_aggregates.get(key, Decimal("0")) + Decimal(str(row["debit_amount"] or 0))
    bank_aggregate_rows = [
        {"month": month, "category_code": code, "amount": amount}
        for (month, code), amount in sorted(bank_aggregates.items())
    ]
    return build_personnel_response(company_id, year, payroll_aggregates, bank_aggregate_rows)


def _get_personnel_from_database(settings: Any, company_id: UUID, year: int) -> dict[str, Any]:
    params = {
        "company_id": company_id,
        "year": year,
        "date_from": date(year, 1, 1),
        "date_to": date(year + 1, 1, 1),
    }
    with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
        payroll_rows = [dict(row) for row in session.execute(PERSONNEL_PAYROLL_SQL, params).mappings().all()]
        bank_rows = [dict(row) for row in session.execute(PERSONNEL_BANK_SQL, params).mappings().all()]
    return build_personnel_response(company_id, year, payroll_rows, bank_rows)


def get_monthly_personnel(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None and _supabase_headers(settings) is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial database is not configured",
        )

    try:
        if _supabase_headers(settings) is not None:
            return _get_personnel_from_supabase(settings, company_id, year)
        return _get_personnel_from_database(settings, company_id, year)
    except (SQLAlchemyError, OSError, httpx.HTTPError, RuntimeError) as error:
        logger.exception(
            "financial personnel query failed",
            extra={"company_id": str(company_id), "year": year, "source": "supabase_rest" if _supabase_headers(settings) is not None else "database"},
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Financial personnel data is unavailable",
        ) from None

    return build_personnel_response(company_id, year, payroll_rows, bank_rows)
