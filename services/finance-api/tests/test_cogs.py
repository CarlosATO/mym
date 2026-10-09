from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi.testclient import TestClient

from app.financial.cogs import MONTHLY_COGS_SQL, build_cogs_response
from app.main import app


client = TestClient(app)


COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def _response(rows, data_through=date(2026, 9, 30)):
    return build_cogs_response(COMPANY_ID, 2026, rows, data_through)


def test_cogs_subtracts_credit_note_reversal_with_decimal_precision() -> None:
    response = _response([
        {
            "month": 1,
            "gross_cogs": Decimal("100.005"),
            "credit_note_reversal": Decimal("25.005"),
            "observed_document_count": 2,
            "missing_document_count": 0,
            "data_through": date(2026, 1, 31),
        },
    ], date(2026, 1, 31))

    assert response["months"][0]["gross_cogs"] == "100.01"
    assert response["months"][0]["credit_note_reversal"] == "25.01"
    assert response["months"][0]["net_cogs"] == "75.00"
    assert response["ytd"]["net_cogs"] == "75.00"


def test_cogs_marks_month_and_ytd_incomplete_without_zeroing_missing_cost() -> None:
    response = _response([
        {
            "month": 1,
            "gross_cogs": Decimal("100.00"),
            "credit_note_reversal": Decimal("10.00"),
            "observed_document_count": 504,
            "missing_document_count": 1,
            "data_through": date(2026, 1, 31),
        },
    ], date(2026, 1, 31))

    assert response["months"][0]["coverage_status"] == "INCOMPLETE"
    assert response["months"][0]["missing_document_count"] == 1
    assert response["ytd"]["coverage_status"] == "INCOMPLETE"
    assert response["ytd"]["missing_document_count"] == 1
    assert response["months"][0]["gross_cogs"] == "100.00"


def test_cogs_with_only_missing_documents_has_no_zero_cost() -> None:
    response = _response([
        {
            "month": 10,
            "gross_cogs": None,
            "credit_note_reversal": Decimal("0.00"),
            "observed_document_count": 0,
            "missing_document_count": 158,
            "data_through": date(2026, 10, 31),
        },
    ], date(2026, 10, 31))

    assert response["months"][9]["gross_cogs"] is None
    assert response["months"][9]["net_cogs"] is None
    assert response["months"][9]["coverage_status"] == "INCOMPLETE"


def test_zero_with_evidence_is_resolved_and_contributes_zero_cogs() -> None:
    response = _response([
        {
            "month": 1,
            "gross_cogs": Decimal("0.00"),
            "credit_note_reversal": Decimal("0.00"),
            "observed_document_count": 0,
            "zero_evidence_document_count": 3,
            "resolved_document_count": 3,
            "missing_document_count": 0,
            "data_through": date(2026, 1, 31),
        },
    ], date(2026, 1, 31))

    assert response["months"][0]["gross_cogs"] == "0.00"
    assert response["months"][0]["net_cogs"] == "0.00"
    assert response["months"][0]["coverage_status"] == "COMPLETE"
    assert response["months"][0]["zero_evidence_document_count"] == 3
    assert response["months"][0]["resolved_document_count"] == 3


def test_cogs_keeps_future_months_unavailable() -> None:
    response = _response([
        {
            "month": 9,
            "gross_cogs": Decimal("100.00"),
            "credit_note_reversal": Decimal("10.00"),
            "observed_document_count": 1,
            "missing_document_count": 0,
            "data_through": date(2026, 9, 30),
        },
    ])

    assert response["months"][8]["net_cogs"] == "90.00"
    assert response["months"][9]["gross_cogs"] is None
    assert response["months"][11]["coverage_status"] is None


def test_cogs_does_not_duplicate_document_costs_for_detail_rows() -> None:
    response = _response([
        {
            "month": 1,
            "gross_cogs": Decimal("123.45"),
            "credit_note_reversal": Decimal("0"),
            "observed_document_count": 1,
            "missing_document_count": 0,
            "data_through": date(2026, 1, 31),
        },
    ], date(2026, 1, 31))

    assert response["months"][0]["gross_cogs"] == "123.45"
    assert response["months"][0]["observed_document_count"] == 1


def test_cogs_query_is_company_scoped_and_document_level() -> None:
    sql = str(MONTHLY_COGS_SQL)

    assert "normalized.company_id = :company_id" in sql
    assert "costs.company_id = eligible.company_id" in sql
    assert "JOIN integraciones.bsale_documents" not in sql
    assert "bsale_document_details" not in sql
    assert "SELECT DISTINCT" in sql


def test_cogs_endpoint_requires_authentication() -> None:
    response = client.get(
        "/financial/income-statement/cogs?year=2026",
        headers={"X-Company-Id": str(COMPANY_ID)},
    )

    assert response.status_code == 401
