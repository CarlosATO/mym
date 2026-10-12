from uuid import UUID

from app.financial.cogs import (
    PROVIDER_COGS_SOURCE,
    PROVIDER_COGS_SQL,
    build_provider_cogs_response,
)

COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def test_provider_cogs_reads_only_the_readonly_view() -> None:
    sql = str(PROVIDER_COGS_SQL)

    assert "integraciones.vw_bsale_provider_cogs_monthly" in sql
    assert "company_id = :company_id" in sql
    assert "year = :year" in sql
    # The endpoint must not re-derive cost, nor join sales net amounts.
    assert "bsale_document_costs" not in sql
    assert "bsale_document_cost_details" not in sql
    assert "net_amount" not in sql
    assert "integraciones.vw_bsale_provider_family_cogs_monthly" in sql
    assert "UNION ALL" in sql
    assert PROVIDER_COGS_SOURCE == "integraciones.vw_bsale_provider_cogs_monthly"


def test_provider_cogs_sums_months_to_ytd_and_keeps_unassigned() -> None:
    rows = [
        {"month": 1, "provider_key": "brand:1", "provider_name": "A", "gross_cogs": "100.00", "credit_note_reversal": "10.00"},
        {"month": 2, "provider_key": "brand:1", "provider_name": "A", "gross_cogs": "200.00", "credit_note_reversal": "5.00"},
        {"month": 2, "provider_key": "unassigned", "provider_name": None, "gross_cogs": "50.00", "credit_note_reversal": "2.50"},
    ]

    response = build_provider_cogs_response(COMPANY_ID, 2026, rows)

    assert response["through_month"] == 2
    assert response["has_information"] is True
    by_key = {provider["provider_key"]: provider for provider in response["providers"]}
    assert by_key["brand:1"]["gross_cogs_ytd"] == "300.00"
    assert by_key["brand:1"]["credit_note_reversal_ytd"] == "15.00"
    assert by_key["brand:1"]["net_cogs_ytd"] == "285.00"
    assert by_key["unassigned"]["provider_name"] == "SIN PROVEEDOR"
    assert by_key["unassigned"]["net_cogs_ytd"] == "47.50"


def test_provider_cogs_preserves_legit_zero_with_evidence() -> None:
    rows = [
        {"month": 1, "provider_key": "brand:9", "provider_name": "Z", "gross_cogs": "0.00", "credit_note_reversal": "0.00"},
    ]

    response = build_provider_cogs_response(COMPANY_ID, 2026, rows)

    assert response["providers"][0]["gross_cogs_ytd"] == "0.00"
    assert response["providers"][0]["net_cogs_ytd"] == "0.00"


def test_provider_cogs_returns_family_rows_in_the_same_aggregate_response() -> None:
    rows = [
        {"row_type": "PROVIDER", "month": 1, "provider_key": "brand:1", "provider_name": "A", "gross_cogs": "100.00", "credit_note_reversal": "10.00"},
        {"row_type": "FAMILY", "month": 1, "provider_key": "brand:1", "provider_name": "A", "family_key": "brand:1|product_type:47", "family_name": "ACWS/ALIMENTO", "gross_cogs": "100.00", "credit_note_reversal": "10.00"},
    ]

    response = build_provider_cogs_response(COMPANY_ID, 2026, rows)

    assert response["providers"][0]["net_cogs_ytd"] == "90.00"
    assert response["families"] == [{
        "provider_key": "brand:1",
        "provider_name": "A",
        "family_key": "brand:1|product_type:47",
        "family_name": "ACWS/ALIMENTO",
        "gross_cogs_ytd": "100.00",
        "credit_note_reversal_ytd": "10.00",
        "net_cogs_ytd": "90.00",
    }]


def test_provider_cogs_empty_period_has_no_information() -> None:
    response = build_provider_cogs_response(COMPANY_ID, 2026, [])

    assert response["providers"] == []
    assert response["through_month"] is None
    assert response["has_information"] is False
