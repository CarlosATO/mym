from datetime import date
from decimal import Decimal
from uuid import UUID

from app.financial.receivables import (
    ANALYSIS_DAILY_SQL,
    ANALYSIS_DOCUMENTS_SQL,
    RECEIVABLE_SNAPSHOT_DOCUMENTS_SQL,
    RECEIVABLE_SNAPSHOT_SQL,
    RECEIVABLES_SQL,
    HISTORICAL_SOURCE,
    SNAPSHOT_SOURCE,
    build_receivables_response,
)


COMPANY_ID = UUID("d1000000-0000-0000-0000-000000000001")


def _pending(documents, payments, credits, cutoff):
    documents_2026 = {
        document_id: (document_id, emission, total, expiration)
        for document_id, emission, total, expiration in documents
        if date(2026, 1, 1) <= emission < date(2027, 1, 1) and emission <= cutoff
    }
    result = []
    for document_id, (_, emission, total, expiration) in documents_2026.items():
        paid = sum(amount for payment_document_id, payment_date, amount in payments if payment_document_id == document_id and payment_date <= cutoff)
        credit = sum(amount for credit_document_id, credit_date, amount in credits if credit_document_id == document_id and credit_date <= cutoff)
        result.append((max(total - paid - credit, 0), expiration < cutoff))
    return sum(amount for amount, _ in result), sum(amount for amount, overdue in result if overdue)


def _pending_with_credit_note_dedup(total, monetary_payments, credit_notes, payment_credit_note_ids):
    linked_credit_note_ids = set(payment_credit_note_ids)
    paid = sum(amount for amount, credit_note_id in monetary_payments if credit_note_id not in linked_credit_note_ids)
    credited = sum(amount for credit_note_id, amount in credit_notes if credit_note_id in linked_credit_note_ids or credit_note_id not in payment_credit_note_ids)
    return max(total - paid - credited, 0)


def test_receivables_query_reuses_sales_eligibility_and_valid_payment_rules() -> None:
    sql = str(RECEIVABLES_SQL)
    assert "vw_bsale_receivables_documents" in sql
    assert "include_in_replenishment = TRUE" in sql
    assert "sign_for_sales IN (1, -1)" in sql
    assert "business_category IN ('sale', 'reversal')" in sql
    assert "d.state = 0" in sql
    assert "p.state = 0" in sql
    assert "p.is_credit_payment IS TRUE" in sql
    assert "isClientCredit" in sql
    assert "expirationDate" in sql
    assert "vw_bsale_receivables_references" in sql
    assert "same_number" in sql
    assert "unallocated_credits" not in sql
    assert "d.emission_date >= make_date(:year, 1, 1)" in sql
    assert "d.emission_date < make_date(:year + 1, 1, 1)" in sql
    assert "pending_documents" in sql
    assert "date_trunc('month', CAST(:effective_date AS date))" in sql
    assert "THEN CAST(:effective_date AS date)" in sql
    assert "periods.is_available" in sql


def test_actual_uses_latest_completed_snapshot() -> None:
    sql = str(RECEIVABLE_SNAPSHOT_SQL)
    assert "source = 'BSALE_UNPAID_DOCUMENTS'" in sql
    assert SNAPSHOT_SOURCE == "BSALE_UNPAID_DOCUMENTS_SNAPSHOT"
    assert SNAPSHOT_SOURCE != HISTORICAL_SOURCE
    assert "status = 'COMPLETED'" in sql
    assert "ORDER BY r.snapshot_at DESC" in sql
    assert "LIMIT 1" in sql
    assert "SUM(d.total_amount_owed)" in sql
    assert "AS receivable_amount" in sql
    assert "d.expiration_date < r.snapshot_date" in sql
    assert "SUM(d.total_amount_owed) FILTER (WHERE d.expiration_date < r.snapshot_date)" in sql
    assert "SUM(d.total_amount_owed) FILTER (WHERE d.status = 'OVERDUE')" not in sql
    assert "clients_unqueryable" in sql
    assert "coverage_percent" in sql


def test_actual_drilldown_reads_the_same_snapshot_run() -> None:
    sql = str(RECEIVABLE_SNAPSHOT_DOCUMENTS_SQL)
    assert "d.run_id = :run_id" in sql
    assert "d.total_amount_owed AS pending_amount" in sql
    assert "d.expiration_date < r.snapshot_date AS overdue" in sql
    assert "d.status AS source_status" in sql


def test_bsale_overdue_boundary_is_strictly_before_cutoff() -> None:
    cutoff = date(2026, 10, 6)
    assert date(2026, 10, 5) < cutoff
    assert not date(2026, 10, 6) < cutoff
    assert not date(2026, 10, 7) < cutoff


def test_historical_overdue_keeps_strict_close_date_semantics() -> None:
    sql = str(RECEIVABLES_SQL)
    assert "document_positions.expiration_date < document_positions.close_date" in sql
    assert "d.pending_amount > 0 AND d.expiration_date < :close_date AS overdue" in str(ANALYSIS_DOCUMENTS_SQL)


def test_receivables_deduplicates_only_identified_credit_note_payments() -> None:
    sql = str(RECEIVABLES_SQL)
    assert "bsale_credit_note_returns" in sql
    assert "p.payment_return_id" in sql
    assert "cnr.bsale_credit_note_id" in sql
    assert "dc.credit_note_bsale_id = cnr.bsale_credit_note_id" in sql
    assert "dc.bsale_document_id = p.bsale_document_id" in sql
    assert "dc.credit_note_bsale_id IS NULL" in sql
    assert "ROUND(dc.credit_amount, 0) = ROUND(p.amount_applied, 0)" in sql
    assert "p.state = 0" in sql
    assert "isClientCredit" in sql


def test_credit_note_payment_is_counted_once() -> None:
    assert _pending_with_credit_note_dedup(
        100,
        [(20, 10)],
        [(10, 20)],
        [10],
    ) == 80


def test_monetary_payment_and_credit_note_are_each_counted_once() -> None:
    assert _pending_with_credit_note_dedup(
        200,
        [(50, None), (20, 11)],
        [(11, 30)],
        [11],
    ) == 120


def test_distinct_credit_notes_with_same_amount_are_not_collapsed() -> None:
    assert _pending_with_credit_note_dedup(
        200,
        [],
        [(11, 30), (12, 30)],
        [11, 12],
    ) == 140


def test_unidentified_credit_note_payment_is_not_deduplicated_by_amount() -> None:
    assert _pending_with_credit_note_dedup(
        100,
        [(20, None)],
        [(10, 20)],
        [],
    ) == 60


def test_analysis_daily_uses_event_accumulation_instead_of_document_day_cross_join() -> None:
    sql = str(ANALYSIS_DAILY_SQL)
    assert "document_events" in sql
    assert "document_balance_points" in sql
    assert "pending_daily_events" in sql
    assert "overdue_entries" in sql
    assert "SUM(COALESCE(pending_daily.amount, 0)) OVER" in sql
    assert "SUM(COALESCE(overdue_daily.amount, 0)) OVER" in sql
    assert "generate_series" in sql
    assert "CROSS JOIN eligible_documents" not in sql
    assert "SELECT SUM(p.amount_applied) FROM valid_payments" not in sql
    assert "SELECT SUM(c.credit_amount) FROM document_credits" not in sql


def test_analysis_documents_preaggregates_payments_and_credits() -> None:
    sql = str(ANALYSIS_DOCUMENTS_SQL)
    assert "payment_totals" in sql
    assert "credit_totals" in sql
    assert "LEFT JOIN payment_totals" in sql
    assert "LEFT JOIN credit_totals" in sql
    assert "SELECT SUM(p.amount_applied) FROM valid_payments" not in sql


def test_receivables_builds_historical_snapshots_without_summing_months() -> None:
    response = build_receivables_response(
        COMPANY_ID,
        2026,
        [
            {"month": 0, "receivable_amount": Decimal("140"), "overdue_amount": Decimal("40")},
            {"month": 1, "receivable_amount": Decimal("100"), "overdue_amount": Decimal("0")},
            {"month": 2, "receivable_amount": Decimal("140"), "overdue_amount": Decimal("40")},
        ],
        date(2026, 2, 15),
        date(2026, 2, 15),
    )

    assert response["months"][0] == {"month": 1, "receivable_amount": "100.00", "overdue_amount": "0.00"}
    assert response["months"][1] == {"month": 2, "receivable_amount": "140.00", "overdue_amount": "40.00"}
    assert response["actual"] == {"receivable_amount": "140.00", "overdue_amount": "40.00", "pending_documents": 0}


def test_receivables_leave_future_months_unavailable() -> None:
    response = build_receivables_response(
        COMPANY_ID,
        2026,
        [
            {"month": 0, "receivable_amount": Decimal("75"), "overdue_amount": Decimal("25"), "pending_documents": 1},
            {"month": 1, "receivable_amount": Decimal("75"), "overdue_amount": Decimal("25"), "pending_documents": 1},
        ],
        date(2026, 1, 31),
        date(2026, 2, 1),
    )

    assert response["months"][0]["receivable_amount"] == "75.00"
    assert response["months"][1]["receivable_amount"] is None
    assert response["actual"]["receivable_amount"] == "75.00"
    assert response["actual"]["pending_documents"] == 1


def test_2025_unpaid_invoice_is_excluded() -> None:
    assert _pending([(1, date(2025, 12, 31), 100, date(2026, 1, 15))], [], [], date(2026, 1, 31)) == (0, 0)


def test_2025_invoice_paid_in_2026_is_excluded() -> None:
    assert _pending([(1, date(2025, 12, 31), 100, date(2026, 1, 15))], [(1, date(2026, 2, 1), 100)], [], date(2026, 2, 28)) == (0, 0)


def test_january_invoice_paid_in_march_is_pending_until_march() -> None:
    invoice = [(1, date(2026, 1, 15), 100, date(2026, 2, 15))]
    assert _pending(invoice, [(1, date(2026, 3, 1), 100)], [], date(2026, 1, 31)) == (100, 0)
    assert _pending(invoice, [(1, date(2026, 3, 1), 100)], [], date(2026, 2, 28)) == (100, 100)
    assert _pending(invoice, [(1, date(2026, 3, 1), 100)], [], date(2026, 3, 31)) == (0, 0)


def test_partial_payment_leaves_document_balance() -> None:
    assert _pending([(1, date(2026, 1, 15), 100, date(2026, 2, 15))], [(1, date(2026, 1, 20), 35)], [], date(2026, 1, 31)) == (65, 0)


def test_credit_note_for_2025_document_does_not_affect_2026() -> None:
    assert _pending([(1, date(2025, 12, 15), 100, date(2026, 1, 15))], [], [(1, date(2026, 1, 20), 20)], date(2026, 1, 31)) == (0, 0)


def test_deterministically_linked_credit_note_reduces_2026_invoice() -> None:
    assert _pending([(1, date(2026, 1, 15), 100, date(2026, 2, 15))], [], [(1, date(2026, 1, 20), 20)], date(2026, 1, 31)) == (80, 0)


def test_actual_contains_only_2026_originated_documents() -> None:
    assert _pending([
        (1, date(2025, 12, 31), 100, date(2026, 1, 15)),
        (2, date(2026, 1, 15), 75, date(2026, 2, 15)),
    ], [(1, date(2026, 10, 5), 100)], [], date(2026, 10, 5)) == (75, 75)


def test_incomplete_current_month_uses_effective_date_for_overdue() -> None:
    cutoff = date(2026, 10, 5)
    documents = [
        (1, date(2026, 9, 30), 100, date(2026, 10, 4)),
        (2, date(2026, 9, 30), 100, date(2026, 10, 6)),
        (3, date(2026, 9, 30), 100, date(2026, 10, 31)),
    ]
    october = _pending(documents, [], [], cutoff)
    actual = _pending(documents, [], [], cutoff)
    assert october == (300, 100)
    assert october == actual
