from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException

from app.financial.sales import (
    MONTHLY_NET_SALES_SQL,
    SALES_BY_FAMILY_SQL,
    SALES_DETAIL_SQL,
    SALES_DETAIL_COMBINED_SQL,
    SALES_FAMILY_DETAIL_SQL,
    SALES_FAMILY_EXISTS_SQL,
    SALES_PROVIDER_FAMILY_DETAIL_COMBINED_SQL,
    SALES_METADATA_SQL,
    SALES_DOCUMENT_LINES_SQL,
    build_sales_net_by_family_response,
    build_sales_net_detail_response,
    build_sales_net_family_detail_response,
    build_sales_net_response,
    get_sales_net_detail,
)


COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def test_sales_query_reads_net_amount_from_normalized_view() -> None:
    monthly_sql = str(MONTHLY_NET_SALES_SQL)
    metadata_sql = str(SALES_METADATA_SQL)

    assert "normalized.net_amount" in monthly_sql
    assert "JOIN integraciones.bsale_documents" not in monthly_sql
    assert "JOIN integraciones.bsale_documents" not in metadata_sql
    assert "vw_bsale_documents_normalized" in monthly_sql
    assert "vw_bsale_documents_normalized" in metadata_sql


def test_sales_detail_combines_summary_and_page_in_one_query() -> None:
    detail_sql = str(SALES_DETAIL_COMBINED_SQL)
    family_sql = str(SALES_PROVIDER_FAMILY_DETAIL_COMBINED_SQL)

    assert detail_sql.count("SELECT") >= 3
    assert "data_through" in detail_sql
    assert "total_documents" in detail_sql
    assert "total_contribution" in detail_sql
    assert "family_catalog" in family_sql
    assert "WHERE catalog.family_key = :family_key" in family_sql
    assert "OFFSET :offset" in family_sql
    assert "LIMIT :page_size" in family_sql


def test_sales_document_lines_are_company_scoped_and_return_all_lines() -> None:
    lines_sql = str(SALES_DOCUMENT_LINES_SQL)

    assert "vw_bsale_sales_document_lines" in lines_sql
    assert "lines.company_id = :company_id" in lines_sql
    assert "lines.document_id = :document_id" in lines_sql
    assert "provider_key" not in lines_sql.split("WHERE", 1)[1]


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


def test_sales_detail_uses_same_eligibility_and_reconciles_credit_notes() -> None:
    detail_sql = str(SALES_DETAIL_SQL)
    assert "include_in_replenishment = TRUE" in detail_sql
    assert "sign_for_sales IN (1, -1)" in detail_sql
    assert "business_category IN ('sale', 'reversal')" in detail_sql

    response = build_sales_net_detail_response(
        company_id=COMPANY_ID,
        year=2026,
        month=2,
        data_through=date(2026, 2, 28),
        detail_rows=[
            {
                "bsale_id": 101,
                "emission_date": date(2026, 2, 5),
                "document_type_id": 1,
                "document_type_name": "Factura",
                "folio": 10,
                "net_amount": Decimal("100.005"),
                "sign_for_sales": 1,
            },
            {
                "bsale_id": 102,
                "emission_date": date(2026, 2, 8),
                "document_type_id": 3,
                "document_type_name": "Nota de Crédito",
                "folio": 11,
                "net_amount": Decimal("25.00"),
                "sign_for_sales": -1,
            },
        ],
    )

    assert response["scope"] == "MONTH"
    assert response["month"] == 2
    assert response["total_net"] == "75.01"
    assert response["documents_count"] == 2
    assert response["items"][1]["contribution"] == "-25.00"


def test_sales_detail_ytd_marks_scope_without_recomputing_total_in_frontend() -> None:
    response = build_sales_net_detail_response(
        company_id=COMPANY_ID,
        year=2026,
        month=None,
        data_through=date(2026, 9, 30),
        detail_rows=[],
    )

    assert response["scope"] == "YTD"
    assert response["month"] is None
    assert response["data_through"] == "2026-09-30"
    assert response["total_net"] == "0.00"


def test_sales_family_detail_uses_family_key_and_server_side_pagination() -> None:
    family_sql = str(SALES_FAMILY_DETAIL_SQL)
    exists_sql = str(SALES_FAMILY_EXISTS_SQL)
    assert "vw_bsale_sales_family_lines" in family_sql
    assert "WHERE family_key = :family_key" in family_sql
    assert "OFFSET :offset" in family_sql
    assert "LIMIT :page_size" in family_sql
    assert "WHERE family_key = :family_key" in exists_sql

    response = build_sales_net_family_detail_response(
        company_id=COMPANY_ID,
        year=2026,
        month=1,
        data_through=date(2026, 1, 31),
        family_key="product_type:food",
        detail_rows=[
            {
                "bsale_id": 101,
                "emission_date": date(2026, 1, 20),
                "document_type_id": 1,
                "document_type_name": "Factura",
                "folio": 10,
                "office_id": 2,
                "office_name": "Casa Matriz",
                "family_name": "Food",
                "contribution": Decimal("70.00"),
                "line_count": 2,
                "total_documents": 1,
                "total_lines": 2,
                "total_contribution": Decimal("70.00"),
            },
        ],
        page=1,
        page_size=100,
    )
    assert response["family_key"] == "product_type:food"
    assert response["family_name"] == "Food"
    assert response["total"] == "70.00"
    assert response["line_count"] == 2
    assert response["items"][0]["signed_net_amount"] == "70.00"


def test_sales_family_detail_keeps_credit_notes_and_multifamily_line_contributions_separate() -> None:
    food = build_sales_net_family_detail_response(
        company_id=COMPANY_ID,
        year=2026,
        month=None,
        data_through=date(2026, 2, 28),
        family_key="product_type:food",
        detail_rows=[
            {
                "bsale_id": 201, "emission_date": date(2026, 1, 10),
                "document_type_id": 1, "document_type_name": "Factura", "folio": 20,
                "family_name": "Food", "contribution": Decimal("70.00"), "line_count": 1,
                "total_documents": 2, "total_lines": 2, "total_contribution": Decimal("50.00"),
            },
            {
                "bsale_id": 202, "emission_date": date(2026, 2, 10),
                "document_type_id": 3, "document_type_name": "Nota de Crédito", "folio": 21,
                "family_name": "Food", "contribution": Decimal("-20.00"), "line_count": 1,
                "total_documents": 2, "total_lines": 2, "total_contribution": Decimal("50.00"),
            },
        ],
        page=1,
        page_size=100,
    )
    assert food["total"] == "50.00"
    assert food["items"][1]["signed_net_amount"] == "-20.00"
    assert sum(Decimal(item["signed_net_amount"]) for item in food["items"]) == Decimal("50.00")


def test_sales_family_detail_is_company_scoped_and_respects_through_date() -> None:
    family_sql = str(SALES_FAMILY_DETAIL_SQL)
    assert "documents.company_id" in family_sql
    assert "family_lines.company_id = documents.company_id" in family_sql
    assert "emission_date <= :data_through" in family_sql


def test_invalid_family_key_returns_not_found(monkeypatch) -> None:
    class Result:
        def mappings(self):
            return self

        def all(self):
            return []

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, *_args, **_kwargs):
            return Result()

    import app.financial.sales as sales_module

    monkeypatch.setattr(
        sales_module,
        "get_settings",
        lambda: SimpleNamespace(
            database_runtime_dsn=SimpleNamespace(get_secret_value=lambda: "test-dsn")
        ),
    )
    monkeypatch.setattr(sales_module, "get_session_factory", lambda _dsn: lambda: Session())

    try:
        get_sales_net_detail(COMPANY_ID, 2026, None, "product_type:not-real", 1, 100)
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("Expected invalid family_key to return 404")


def test_sales_by_family_uses_product_type_and_shared_sales_eligibility() -> None:
    family_sql = str(SALES_BY_FAMILY_SQL)
    assert "include_in_replenishment = TRUE" in family_sql
    assert "sign_for_sales IN (1, -1)" in family_sql
    assert "business_category IN ('sale', 'reversal')" in family_sql
    assert "vw_bsale_sales_family_lines" in family_sql
    assert "regexp_replace" in family_sql


def test_sales_by_family_reconciles_normal_documents_credit_notes_and_unclassified() -> None:
    response = build_sales_net_by_family_response(
        company_id=COMPANY_ID,
        year=2026,
        data_through=date(2026, 2, 28),
        aggregate_rows=[
            {"row_type": "TOTAL", "month": 1, "amount": Decimal("105.00")},
            {"row_type": "TOTAL", "month": 2, "amount": Decimal("-20.00")},
            {"row_type": "FAMILY", "family_key": "product_type:food", "family_name": "Food", "month": 1, "amount": Decimal("80.00"), "line_count": 1},
            {"row_type": "FAMILY", "family_key": "product_type:food", "family_name": "Food", "month": 2, "amount": Decimal("-20.00"), "line_count": 1},
            {"row_type": "FAMILY", "family_key": "product_type:other", "family_name": "Other", "month": 1, "amount": Decimal("20.00"), "line_count": 1},
            {"row_type": "FAMILY", "family_key": "unclassified", "family_name": "Sin clasificar", "month": 1, "amount": Decimal("5.00"), "line_count": 1},
        ],
    )

    assert response["totals"]["months"] == {"1": "105.00", "2": "-20.00"}
    assert response["totals"]["ytd"] == "85.00"
    assert [(family["family_name"], family["ytd"]) for family in response["families"]] == [
        ("Food", "60.00"),
        ("Other", "20.00"),
        ("Sin clasificar", "5.00"),
    ]
    assert response["unclassified"] == {"line_count": 1, "amount_ytd": "5.00"}


def test_sales_by_family_rejects_non_reconciled_aggregate() -> None:
    try:
        build_sales_net_by_family_response(
            company_id=COMPANY_ID,
            year=2026,
            data_through=date(2026, 1, 31),
            aggregate_rows=[
                {"row_type": "TOTAL", "month": 1, "amount": Decimal("100.00")},
                {"row_type": "FAMILY", "family_key": "product_type:food", "family_name": "Food", "month": 1, "amount": Decimal("99.99"), "line_count": 1},
            ],
        )
    except ValueError as error:
        assert "reconciliation" in str(error)
    else:
        raise AssertionError("Expected family reconciliation failure")
