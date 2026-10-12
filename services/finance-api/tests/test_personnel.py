from decimal import Decimal
from uuid import UUID

from fastapi.testclient import TestClient

from app.financial.personnel import (
    PERSONNEL_BANK_SQL,
    PERSONNEL_PAYROLL_SQL,
    PERSONNEL_ALLOCATION_SQL,
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


def test_off_book_payroll_allocations_use_the_batch_period_and_complete_status() -> None:
    response = build_personnel_response(
        COMPANY_ID,
        2026,
        [],
        [],
        [{"month": 9, "amount": Decimal("7396733")}],
    )

    assert response["months"][8]["status"] == "MISSING"
    assert response["months"][8]["offBook"] == "7396733.00"
    assert response["months"][8]["totalPersonnel"] is None
    assert "batches.period_month AS month" in str(PERSONNEL_ALLOCATION_SQL)
    assert "batches.status = 'COMPLETE'" in str(PERSONNEL_ALLOCATION_SQL)


def test_personnel_endpoint_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/personnel?year=2026",
        headers={"X-Company-Id": str(COMPANY_ID)},
    )

    assert response.status_code == 401


def payroll(month: int, formal: int, employer: int) -> dict:
    return {"month": month, "import_count": 1, "formal_earnings": Decimal(formal),
            "employer_contributions": Decimal(employer), "recurring_labor_cost": Decimal(formal + employer),
            "indemnities": Decimal(0), "worker_count": 1}


def test_trailing_real_payroll_september_and_october() -> None:
    amounts = [(9073063, 396684), (8548598, 400254), (8330413, 391247),
               (10004981, 479016), (11123970, 589731), (10768995, 693660)]
    imports = [payroll(month, *amount) for month, amount in enumerate(amounts, 3)]
    bank = [{"month": 9, "category_code": "EXPENSE_PERSONNEL_OFF_BOOK", "amount": 962098},
            {"month": 9, "category_code": "EXPENSE_SALARIES_OTHER", "amount": 75481}]
    response = build_personnel_response(COMPANY_ID, 2026, imports, bank, [{"month": 9, "amount": 1110721}])
    september, october = response["months"][8:10]
    assert september["status"] == october["status"] == "ESTIMATED"
    assert september["formalEarnings"] == "9641670.00"
    assert september["employerContributions"] == "491765.00"
    assert september["offBook"] == "2072819.00"
    assert september["salariesOther"] == "75481.00"
    assert september["totalPersonnel"] == "12281735.00"
    assert september["personnelEstimated"] and september["formalEarningsEstimated"] and september["employerContributionsEstimated"]
    assert september["estimateMethod"] == "TRAILING_REAL_PAYROLL_AVERAGE"
    assert september["estimateWindowMonths"] == october["estimateWindowMonths"] == list(range(3, 9))
    assert september["estimateWindowCount"] == 6
    assert [source["formalEarnings"] for source in september["estimateSources"]] == [f"{amount[0]}.00" for amount in amounts]
    assert response["coverage"]["latestAvailableMonth"] == 8
    assert response["coverage"]["estimatedMonths"][:2] == [9, 10]

    imported = build_personnel_response(COMPANY_ID, 2026, imports + [payroll(9, 12000000, 600000)], bank)
    assert imported["months"][8]["status"] == "AVAILABLE"
    assert imported["months"][8]["formalEarnings"] == "12000000.00"
    assert not imported["months"][8]["personnelEstimated"]
    assert imported["months"][9]["estimateWindowMonths"] == [4, 5, 6, 7, 8, 9]


def test_estimates_only_previous_imported_months_and_rounds_half_up() -> None:
    response = build_personnel_response(COMPANY_ID, 2026, [payroll(2, 1, 2), payroll(4, 2, 3), payroll(8, 999, 999)], [])
    assert response["months"][0]["status"] == "MISSING"
    assert response["months"][2]["estimateWindowMonths"] == [2]
    assert response["months"][2]["formalEarnings"] == "1.00"
    assert response["months"][3]["status"] == "AVAILABLE"
    assert response["months"][4]["estimateWindowMonths"] == [2, 4]
    assert response["months"][4]["formalEarnings"] == "2.00"
    assert response["months"][4]["employerContributions"] == "3.00"
    assert response["months"][7]["status"] == "AVAILABLE"
    assert response["months"][7]["formalEarnings"] == "999.00"


def test_window_crosses_year_boundary_using_only_real_imports() -> None:
    previous = {**payroll(12, 101, 5), "year": 2025}
    result = build_personnel_response(COMPANY_ID, 2026, [previous, payroll(2, 102, 6)], [])
    assert result["months"][0]["status"] == "ESTIMATED"
    assert result["months"][0]["estimateSources"][0]["year"] == 2025
    assert result["months"][0]["formalEarnings"] == "101.00"
    assert result["months"][2]["estimateWindowMonths"] == [12, 2]
    assert result["months"][2]["formalEarnings"] == "102.00"
