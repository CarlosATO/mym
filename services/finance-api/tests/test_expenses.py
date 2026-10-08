from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from fastapi.testclient import TestClient

from pydantic import SecretStr

from app.financial import expenses
from app.financial.expenses import EXPENSE_CATEGORIES, MONTHLY_EXPENSES_SQL, OTHER_INCOME_CATEGORY, OTHER_INCOME_SQL, build_expenses_response
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


def test_expenses_response_includes_posted_manual_expense_amounts() -> None:
    response = build_expenses_response(
        COMPANY_ID,
        2026,
        [{"month": 1, "last_transaction_date": date(2026, 1, 30)}],
        [
            {"month": 1, "category_code": "EXPENSE_SOFTWARE_SUBSCRIPTIONS", "amount": Decimal("100")},
            {"month": 1, "category_code": "EXPENSE_OTHER", "amount": Decimal("40")},
        ],
    )
    assert response["months"][0]["otherExpenses"] == "40.00"
    assert response["months"][0]["operatingIdentifiedTotal"] == "140.00"
    assert response["months"][1]["status"] == "MISSING"
    assert response["months"][1]["operatingIdentifiedTotal"] is None


def test_expenses_response_includes_other_income_separately_from_sales_and_expenses() -> None:
    response = build_expenses_response(
        COMPANY_ID,
        2026,
        [{"month": 1, "last_transaction_date": date(2026, 1, 30)}],
        [{"month": 1, "category_code": "EXPENSE_OTHER", "amount": Decimal("40")}],
        other_income_rows=[{"month": 1, "amount": Decimal("250")}],
    )
    assert response["months"][0]["otherIncome"] == "250.00"
    assert response["months"][0]["operatingIdentifiedTotal"] == "40.00"
    assert response["ytd"]["otherIncome"] == "250.00"


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
    assert "expense.status = 'POSTED'" in sql
    assert "expense.period_year = :year" in sql
    assert "period_month AS month" in sql
    assert "available_periods" in sql
    assert "GREATEST" in sql
    assert "movement.direction = 'DEBE'" in sql
    other_sql = str(OTHER_INCOME_SQL)
    assert OTHER_INCOME_CATEGORY in other_sql
    assert "inflow.company_id = :company_id" in other_sql
    assert "inflow.entry_type = 'OTHER_INCOME'" in other_sql
    assert "inflow.status = 'POSTED'" in other_sql


def test_expenses_endpoint_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/expenses?year=2026",
        headers={"X-Company-Id": str(COMPANY_ID)},
    )
    assert response.status_code == 401


def test_expenses_supabase_residual_preserves_partial_bank_allocations(monkeypatch) -> None:
    settings = SimpleNamespace(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key=SecretStr("service-role"),
    )

    def run_case(allocated_rows, expense_status="POSTED", recognized_amount="40", loan_rows=None, source_type="MANUAL"):
        category_calls = 0

        def fake_get(_settings, table, _params):
            nonlocal category_calls
            if table == "financial_categories":
                category_calls += 1
                if category_calls == 1:
                    return [{"id": str(index), "code": code, "affects_pnl_directly": True} for index, code in enumerate(EXPENSE_CATEGORIES)]
                return []
            if table == "financial_statement_periods":
                return [{"month": 1, "last_transaction_date": "2026-01-30"}]
            if table == "financial_bank_movements":
                if isinstance(_params, list) and any("select" in item and item[1] == "id,transaction_date,debit_amount,category_id,review_status" for item in _params):
                    return [{"id": "bank-1", "transaction_date": "2026-01-01", "debit_amount": "100", "category_id": "0", "review_status": "REVIEWED"}]
                return []
            if table == "financial_expense_entries":
                if expense_status != "POSTED":
                    return []
                return [{"id": "expense-1", "period_month": 1, "category_id": "0", "recognized_amount": recognized_amount, "status": expense_status, "source_type": source_type}]
            if table == "financial_expense_bank_links":
                return allocated_rows
            if table == "financial_loan_payments":
                return loan_rows or []
            return []

        monkeypatch.setattr(expenses, "_supabase_get", fake_get)
        return expenses._get_expenses_from_supabase(settings, COMPANY_ID, 2026)

    partial = run_case([{"bank_movement_id": "bank-1", "expense_entry_id": "expense-1", "allocated_amount": "40"}])
    assert partial["months"][0]["softwareSubscriptions"] == "100.00"

    full = run_case([{"bank_movement_id": "bank-1", "expense_entry_id": "expense-1", "allocated_amount": "100"}], recognized_amount="100")
    assert full["months"][0]["softwareSubscriptions"] == "100.00"

    multiple = run_case([
        {"bank_movement_id": "bank-1", "expense_entry_id": "expense-1", "allocated_amount": "40"},
        {"bank_movement_id": "bank-1", "expense_entry_id": "expense-1", "allocated_amount": "60"},
    ], recognized_amount="100")
    assert multiple["months"][0]["softwareSubscriptions"] == "100.00"

    voided = run_case([{"bank_movement_id": "bank-1", "expense_entry_id": "expense-voided", "allocated_amount": "40"}], expense_status="VOIDED")
    assert voided["months"][0]["softwareSubscriptions"] == "100.00"

    draft = run_case([], expense_status="DRAFT")
    assert draft["months"][0]["softwareSubscriptions"] == "100.00"

    for source_type in ("MANUAL", "PETTY_CASH", "LOAN", "IMPORT", "BANK_LINKED"):
        recognized = run_case([], recognized_amount="40", source_type=source_type)
        assert recognized["months"][0]["softwareSubscriptions"] == "140.00"

    linked_loan = run_case([], recognized_amount="0", loan_rows=[{"bank_movement_id": "bank-1", "status": "POSTED"}])
    assert linked_loan["months"][0]["softwareSubscriptions"] == "0.00"

    voided_loan = run_case([], recognized_amount="0", loan_rows=[{"bank_movement_id": "bank-1", "status": "VOIDED"}])
    assert voided_loan["months"][0]["softwareSubscriptions"] == "0.00"


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
            return [{"id": str(index), "code": code, "affects_pnl_directly": True} for index, code in enumerate(EXPENSE_CATEGORIES)]
        if table == "financial_statement_periods":
            return [{"month": 1, "last_transaction_date": "2026-01-30"}]
        return [
            {"id": "bank-1", "transaction_date": "2026-01-01", "debit_amount": "100", "category_id": "0", "review_status": "REVIEWED"},
        ]

    monkeypatch.setattr(expenses, "_supabase_get", fake_get)
    response = expenses._get_expenses_from_supabase(settings, COMPANY_ID, 2026)
    assert response["months"][0]["softwareSubscriptions"] == "100.00"
    assert response["months"][1]["status"] == "MISSING"


def test_posted_recognized_period_is_available_without_bank_period(monkeypatch) -> None:
    settings = SimpleNamespace(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key=SecretStr("service-role"),
    )

    def fake_get(_settings, table, _params):
        if table == "financial_categories":
            return [{"id": str(index), "code": code, "affects_pnl_directly": True} for index, code in enumerate(EXPENSE_CATEGORIES)]
        if table == "financial_statement_periods":
            return []
        if table == "financial_bank_movements":
            return []
        if table == "financial_expense_entries":
            return [{"id": "expense-qa", "period_month": 10, "category_id": "2", "recognized_amount": "45000", "status": "POSTED", "source_type": "MANUAL"}]
        return []

    monkeypatch.setattr(expenses, "_supabase_get", fake_get)
    response = expenses._get_expenses_from_supabase(settings, COMPANY_ID, 2026)
    assert response["months"][9]["status"] == "AVAILABLE"
    assert response["months"][9]["vehicleOperating"] == "45000.00"
