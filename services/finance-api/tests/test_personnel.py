from decimal import Decimal
from uuid import UUID

from fastapi.testclient import TestClient

from app.financial.personnel import (
    PERSONNEL_BANK_SQL,
    PERSONNEL_PAYROLL_SQL,
    build_personnel_response,
)
from app.main import app


client = TestClient(app)
COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def test_personnel_aggregates_formal_off_book_and_other_without_indemnity_duplication() -> None:
    response = build_personnel_response(
        COMPANY_ID,
        2026,
        [
            {
                "month": 1,
                "import_count": 1,
                "formal_earnings": Decimal("1000"),
                "employer_contributions": Decimal("100"),
                "formal_labor_cost": Decimal("1100"),
                "recurring_labor_cost": Decimal("1100"),
                "indemnities": Decimal("25"),
                "worker_count": 2,
            },
        ],
        [
            {"month": 1, "category_code": "EXPENSE_PERSONNEL_OFF_BOOK", "amount": Decimal("200")},
            {"month": 1, "category_code": "EXPENSE_SALARIES_OTHER", "amount": Decimal("50")},
        ],
    )

    january = response["months"][0]
    assert january["formalLaborCost"] == "1100.00"
    assert january["indemnities"] == "25.00"
    assert january["totalPersonnel"] == "1350.00"
    assert response["ytd"]["availableTotal"]["totalPersonnel"] == "1350.00"


def test_personnel_marks_missing_payroll_without_zeroing_known_bank_sources() -> None:
    response = build_personnel_response(
        COMPANY_ID,
        2026,
        [],
        [{"month": 9, "category_code": "EXPENSE_PERSONNEL_OFF_BOOK", "amount": Decimal("300")}],
    )

    september = response["months"][8]
    assert september["status"] == "MISSING"
    assert september["formalEarnings"] is None
    assert september["employerContributions"] is None
    assert september["offBook"] == "300.00"
    assert september["totalPersonnel"] is None
    assert response["coverage"]["coverageStatus"] == "MISSING"
    assert response["ytd"]["availableTotal"]["offBook"] == "300.00"
    assert response["ytd"]["availableTotal"]["totalPersonnel"] is None


def test_personnel_uses_exact_company_scoped_sources_and_excludes_cash_categories() -> None:
    payroll_sql = str(PERSONNEL_PAYROLL_SQL)
    bank_sql = str(PERSONNEL_BANK_SQL)

    assert "company_id = :company_id" in payroll_sql
    assert "status = 'IMPORTED'" in payroll_sql
    assert "movements.company_id = :company_id" in bank_sql
    assert "categories.code IN ('EXPENSE_PERSONNEL_OFF_BOOK', 'EXPENSE_SALARIES_OTHER')" in bank_sql
    assert "EXPENSE_SALARIES_WAGES" not in bank_sql
    assert "EXPENSE_SALARIES_SOCIAL" not in bank_sql
    assert "EXPENSE_PERSONNEL_CASH" not in bank_sql


def test_personnel_endpoint_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/personnel?year=2026",
        headers={"X-Company-Id": str(COMPANY_ID)},
    )

    assert response.status_code == 401
