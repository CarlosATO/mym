from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from pydantic import SecretStr

from app.financial import expenses
from app.financial.expenses import EXPENSE_CATEGORIES, MONTHLY_EXPENSES_SQL, build_expenses_response
from app.main import app


client = TestClient(app)
COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def test_expenses_aggregate_allowlisted_categories_and_exclude_pending_and_personnel() -> None:
    response = build_expenses_response(
        COMPANY_ID,
        2026,
        [{"month": 1, "last_transaction_date": date(2026, 1, 30)}],
        [
            {"month": 1, "category_code": "EXPENSE_SOFTWARE_SUBSCRIPTIONS", "amount": Decimal("100")},
            {"month": 1, "category_code": "EXPENSE_BANK_FEES", "amount": Decimal("25")},
            {"month": 1, "category_code": "EXPENSE_OPERATING_PENDING", "amount": Decimal("999")},
            {"month": 1, "category_code": "EXPENSE_PERSONNEL_OFF_BOOK", "amount": Decimal("888")},
            {"month": 1, "category_code": "COLLECTION_REVERSAL", "amount": Decimal("777")},
        ],
    )

    january = response["months"][0]
    assert january["status"] == "AVAILABLE"
    assert january["softwareSubscriptions"] == "100.00"
    assert january["bankFees"] == "25.00"
    assert january["operatingIdentifiedTotal"] == "125.00"
    assert response["ytd"]["operatingIdentifiedTotal"] == "125.00"
    assert response["months"][1]["status"] == "MISSING"
    assert response["months"][1]["operatingIdentifiedTotal"] is None


def test_expenses_distinguish_covered_zero_from_missing_and_ytd_is_incomplete() -> None:
    response = build_expenses_response(
        COMPANY_ID,
        2026,
        [
            {"month": 1, "last_transaction_date": date(2026, 1, 30)},
            {"month": 2, "last_transaction_date": date(2026, 2, 27)},
        ],
        [{"month": 1, "category_code": "EXPENSE_NOTARY", "amount": Decimal("0")}],
    )

    assert response["months"][0]["status"] == "AVAILABLE"
    assert response["months"][0]["operatingIdentifiedTotal"] == "0.00"
    assert response["months"][1]["status"] == "AVAILABLE"
    assert response["months"][1]["operatingIdentifiedTotal"] == "0.00"
    assert response["months"][2]["status"] == "MISSING"
    assert response["ytd"]["status"] == "INCOMPLETE"
    assert response["ytd"]["availableMonths"] == [1, 2]
    assert response["ytd"]["operatingIdentifiedTotal"] == "0.00"


def test_expenses_query_has_company_scope_and_explicit_allowlist() -> None:
    sql = str(MONTHLY_EXPENSES_SQL)
    assert "movement.company_id = :company_id" in sql
    for code in EXPENSE_CATEGORIES:
        assert code in sql
    for code in ("EXPENSE_OPERATING_PENDING", "EXPENSE_AGROVET_PENDING", "EXPENSE_PERSONNEL_OFF_BOOK", "EXPENSE_SALARIES_OTHER", "COLLECTION_REVERSAL"):
        assert code not in sql
    assert "parent_id IS NOT NULL" in sql
    assert "statement.month" in sql


def test_expenses_endpoint_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/expenses?year=2026",
        headers={"X-Company-Id": str(COMPANY_ID)},
    )
    assert response.status_code == 401


def test_expenses_supabase_runtime_uses_comercial_profile_and_rest_sources(monkeypatch) -> None:
    settings = SimpleNamespace(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key=SecretStr("service-role"),
    )
    headers = expenses._supabase_headers(settings)
    assert headers is not None
    assert headers[1]["Accept-Profile"] == "comercial"

    def fake_get(_settings, table, _params):
        if table == "financial_categories":
            return [{"id": str(index), "code": code} for index, code in enumerate(EXPENSE_CATEGORIES)]
        if table == "financial_statement_periods":
            return [{"month": 1, "last_transaction_date": "2026-01-30"}]
        return [
            {"transaction_date": "2026-01-01", "debit_amount": "100", "category_id": "0"},
        ]

    monkeypatch.setattr(expenses, "_supabase_get", fake_get)
    response = expenses._get_expenses_from_supabase(settings, COMPANY_ID, 2026)
    assert response["months"][0]["softwareSubscriptions"] == "100.00"
    assert response["months"][1]["status"] == "MISSING"
