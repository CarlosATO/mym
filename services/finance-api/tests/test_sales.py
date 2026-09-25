from datetime import date
from decimal import Decimal
from uuid import UUID

from app.financial.sales import build_sales_net_response


COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def test_sales_net_subtracts_credit_notes_and_matches_ytd() -> None:
    response = build_sales_net_response(
        company_id=COMPANY_ID,
        year=2026,
        monthly_rows=[
            {"month": 1, "net_sales": Decimal("100.00")},
            {"month": 2, "net_sales": Decimal("-25.00")},
        ],
        data_through=date(2026, 2, 28),
        documents_count=3,
        lines_count=4,
    )

    assert response["months"][0]["amount"] == "100.00"
    assert response["months"][1]["amount"] == "-25.00"
    assert response["total_ytd"] == "75.00"
    assert response["documents_count"] == 3


def test_sales_net_leaves_future_months_unavailable() -> None:
    response = build_sales_net_response(
        company_id=COMPANY_ID,
        year=2026,
        monthly_rows=[{"month": 9, "net_sales": Decimal("0.00")}],
        data_through=date(2026, 9, 15),
        documents_count=1,
        lines_count=1,
    )

    assert response["months"][8]["amount"] == "0.00"
    assert response["months"][9]["amount"] is None
    assert response["months"][11]["amount"] is None
    assert response["total_ytd"] == "0.00"


def test_sales_net_without_information_has_no_month_values() -> None:
    response = build_sales_net_response(
        company_id=COMPANY_ID,
        year=2026,
        monthly_rows=[],
        data_through=None,
        documents_count=0,
        lines_count=0,
    )

    assert response["has_information"] is False
    assert all(month["amount"] is None for month in response["months"])
