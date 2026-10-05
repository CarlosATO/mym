from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from uuid import UUID

from sqlalchemy import text

from app.core.config import get_settings
from app.db.connection import get_session_factory


MONEY_QUANTUM = Decimal("0.01")
RECEIVABLES_SOURCE = "BSale documentos + pagos válidos"


RECEIVABLES_SQL = text(
    """
    WITH eligible_documents AS (
        SELECT
            d.company_id,
            d.bsale_id,
            d.emission_date,
            d.document_type_id,
            d.client_id,
            d.total_amount,
            d.raw_json,
            NULLIF(to_timestamp(NULLIF(d.raw_json ->> 'expirationDate', '')::double precision)::date, NULL) AS expiration_date,
            d.sign_for_sales,
            d.business_category,
            d.include_in_replenishment,
            d.document_type_name,
            d.folio
        FROM integraciones.vw_bsale_receivables_documents d
        WHERE d.company_id = :company_id
            AND d.state = 0
            AND d.emission_date IS NOT NULL
            AND d.emission_date >= make_date(:year, 1, 1)
            AND d.emission_date < make_date(:year + 1, 1, 1)
          AND d.include_in_replenishment = TRUE
          AND d.sign_for_sales IN (1, -1)
          AND d.business_category IN ('sale', 'reversal')
          AND d.client_id IS NOT NULL
    ), valid_payments AS (
        SELECT
            p.company_id,
            p.bsale_document_id,
            p.payment_date,
            p.amount_applied
        FROM integraciones.vw_bsale_receivables_payments p
        WHERE p.company_id = :company_id
          AND p.state = 0
          AND p.amount_applied > 0
          AND p.payment_date IS NOT NULL
          AND (
              p.is_credit_payment IS TRUE
              OR (p.is_credit_payment IS FALSE AND p.payment_type_raw_json ->> 'isClientCredit' = '0')
          )
    ), reference_candidates AS (
        SELECT
            links.credit_note_bsale_id,
            links.company_id,
            links.bsale_document_id,
            links.emission_date,
            links.total_amount,
            COUNT(*) OVER (PARTITION BY links.credit_note_bsale_id) AS target_count
        FROM (
            SELECT DISTINCT
                d.bsale_id AS credit_note_bsale_id,
                target.company_id,
                target.bsale_id AS bsale_document_id,
                d.emission_date,
                d.total_amount
            FROM eligible_documents d
            JOIN integraciones.vw_bsale_receivables_references r
              ON r.company_id = d.company_id
             AND r.bsale_document_id = d.bsale_id
            JOIN eligible_documents target
              ON target.company_id = d.company_id
             AND target.sign_for_sales = 1
             AND (
                 target.bsale_id = r.referenced_document_id
                 OR (
                     r.referenced_document_id IS NULL
                     AND r.referenced_document_number IS NOT NULL
                     AND target.folio = NULLIF(regexp_replace(r.referenced_document_number, '[^0-9]', '', 'g'), '')::integer
                     AND 1 = (
                         SELECT COUNT(*)
                         FROM eligible_documents same_number
                         WHERE same_number.company_id = target.company_id
                           AND same_number.sign_for_sales = 1
                           AND same_number.folio = target.folio
                     )
                 )
             )
            WHERE d.sign_for_sales = -1
        ) links
    ), document_credits AS (
        SELECT
            company_id,
            bsale_document_id,
            emission_date,
            SUM(total_amount) AS credit_amount
        FROM reference_candidates
        WHERE target_count = 1
        GROUP BY company_id, bsale_document_id, emission_date
    ), periods AS (
        SELECT
            month_number,
            CASE
                WHEN make_date(:year, month_number, 1) = date_trunc('month', CAST(:effective_date AS date))::date
                    THEN CAST(:effective_date AS date)
                ELSE make_date(:year, month_number, 1) + interval '1 month - 1 day'
            END AS close_date,
            make_date(:year, month_number, 1) <= date_trunc('month', CAST(:effective_date AS date))::date AS is_available
        FROM generate_series(1, 12) AS month_number
        UNION ALL
        SELECT 0, CAST(:effective_date AS date), TRUE
    ), payment_totals AS (
        SELECT periods.month_number, p.bsale_document_id, SUM(p.amount_applied) AS paid_amount
        FROM periods
        JOIN valid_payments p ON p.payment_date <= periods.close_date
        GROUP BY periods.month_number, p.bsale_document_id
    ), credit_totals AS (
        SELECT periods.month_number, c.bsale_document_id, SUM(c.credit_amount) AS credit_amount
        FROM periods
        JOIN document_credits c ON c.emission_date <= periods.close_date
        GROUP BY periods.month_number, c.bsale_document_id
    ), document_positions AS (
        SELECT
            periods.month_number,
            d.expiration_date,
            GREATEST(ROUND(COALESCE(d.total_amount, 0), 0)
                - ROUND(COALESCE(pt.paid_amount, 0), 0)
                - ROUND(COALESCE(ct.credit_amount, 0), 0), 0) AS pending_amount,
            periods.close_date
        FROM periods
        JOIN eligible_documents d
          ON periods.is_available
         AND d.sign_for_sales = 1
         AND d.emission_date <= periods.close_date
        LEFT JOIN payment_totals pt
          ON pt.month_number = periods.month_number
         AND pt.bsale_document_id = d.bsale_id
        LEFT JOIN credit_totals ct
          ON ct.month_number = periods.month_number
         AND ct.bsale_document_id = d.bsale_id
    ), monthly AS (
        SELECT
            periods.month_number,
            COALESCE(SUM(pending_amount), 0) AS receivable_amount,
            COALESCE(SUM(document_positions.pending_amount) FILTER (WHERE document_positions.expiration_date < document_positions.close_date), 0) AS overdue_amount,
            COUNT(document_positions.pending_amount) FILTER (WHERE document_positions.pending_amount > 0) AS pending_documents
        FROM periods
        LEFT JOIN document_positions
          ON document_positions.month_number = periods.month_number
        GROUP BY periods.month_number
    )
    SELECT monthly.month_number AS month, GREATEST(receivable_amount, 0) AS receivable_amount,
           GREATEST(overdue_amount, 0) AS overdue_amount,
           pending_documents,
           LEAST((SELECT MAX(emission_date) FROM eligible_documents), CAST(:effective_date AS date)) AS data_through
    FROM monthly
    ORDER BY month
    """
)


def _money(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(MONEY_QUANTUM, rounding=ROUND_HALF_UP)


def _money_string(value: Any) -> str:
    return format(_money(value), "f")


def _date_string(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if isinstance(value, date) else str(value)


def build_receivables_response(
    company_id: UUID,
    year: int,
    rows: list[dict[str, Any]],
    data_through: Any,
    effective_date: Any,
) -> dict[str, Any]:
    through = _date_string(data_through)
    effective = _date_string(effective_date)
    through_month = int(through[5:7]) if through and through.startswith(f"{year:04d}-") else 0
    row_by_month = {int(row["month"]): row for row in rows}
    months = [
        {
            "month": month,
            "receivable_amount": _money_string(row_by_month[month]["receivable_amount"]) if month <= through_month and month in row_by_month else None,
            "overdue_amount": _money_string(row_by_month[month]["overdue_amount"]) if month <= through_month and month in row_by_month else None,
        }
        for month in range(1, 13)
    ]
    actual = row_by_month.get(0)
    return {
        "company_id": str(company_id),
        "year": year,
        "currency": "CLP",
        "source": RECEIVABLES_SOURCE,
        "data_through": through,
        "effective_date": effective,
        "has_information": data_through is not None,
        "months": months,
        "actual": {
            "receivable_amount": _money_string(actual["receivable_amount"]) if actual else "0.00",
            "overdue_amount": _money_string(actual["overdue_amount"]) if actual else "0.00",
            "pending_documents": int(actual.get("pending_documents", 0)) if actual else 0,
        },
    }


def get_receivables(company_id: UUID, year: int) -> dict[str, Any]:
    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise RuntimeError("DATABASE_RUNTIME_DSN no está configurado")
    with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
        rows = session.execute(
            RECEIVABLES_SQL,
            {"company_id": company_id, "year": year, "effective_date": date.today()},
        ).mappings().all()
    data_through = rows[-1]["data_through"] if rows else None
    return build_receivables_response(company_id, year, rows, data_through, date.today())


ANALYSIS_BASE_CTE = """
WITH eligible_documents AS (
    SELECT d.*, NULLIF(to_timestamp(NULLIF(d.raw_json ->> 'expirationDate', '')::double precision)::date, NULL) AS expiration_date
    FROM integraciones.vw_bsale_receivables_documents d
    WHERE d.company_id = :company_id AND d.state = 0
      AND d.emission_date >= make_date(:year, 1, 1)
      AND d.emission_date < make_date(:year + 1, 1, 1)
      AND d.include_in_replenishment = TRUE AND d.sign_for_sales IN (1, -1)
      AND d.business_category IN ('sale', 'reversal') AND d.client_id IS NOT NULL
), valid_payments AS (
    SELECT p.* FROM integraciones.vw_bsale_receivables_payments p
    WHERE p.company_id = :company_id AND p.state = 0 AND p.amount_applied > 0
      AND p.payment_date IS NOT NULL
      AND (p.is_credit_payment IS TRUE OR (p.is_credit_payment IS FALSE AND p.payment_type_raw_json ->> 'isClientCredit' = '0'))
), reference_candidates AS (
    SELECT links.credit_note_bsale_id, links.company_id, links.bsale_document_id,
           links.emission_date, links.total_amount,
           COUNT(*) OVER (PARTITION BY links.credit_note_bsale_id) AS target_count
    FROM (
        SELECT DISTINCT d.bsale_id AS credit_note_bsale_id, d.company_id,
               target.bsale_id AS bsale_document_id, d.emission_date, d.total_amount
        FROM eligible_documents d
        JOIN integraciones.vw_bsale_receivables_references r
          ON r.company_id = d.company_id AND r.bsale_document_id = d.bsale_id
        JOIN eligible_documents target ON target.company_id = d.company_id
          AND target.sign_for_sales = 1
          AND (target.bsale_id = r.referenced_document_id OR
            (r.referenced_document_id IS NULL AND r.referenced_document_number IS NOT NULL
             AND target.folio = NULLIF(regexp_replace(r.referenced_document_number, '[^0-9]', '', 'g'), '')::integer
             AND 1 = (SELECT COUNT(*) FROM eligible_documents same_number
                      WHERE same_number.company_id = target.company_id
                        AND same_number.sign_for_sales = 1 AND same_number.folio = target.folio)))
        WHERE d.sign_for_sales = -1
    ) links
), document_credits AS (
    SELECT company_id, credit_note_bsale_id, bsale_document_id, emission_date, SUM(total_amount) AS credit_amount
    FROM reference_candidates WHERE target_count = 1
    GROUP BY company_id, credit_note_bsale_id, bsale_document_id, emission_date
), payment_totals AS (
    SELECT p.bsale_document_id, SUM(p.amount_applied) AS paid_amount
    FROM valid_payments p
    WHERE p.payment_date <= :close_date
    GROUP BY p.bsale_document_id
), credit_totals AS (
    SELECT c.bsale_document_id, SUM(c.credit_amount) AS credit_amount
    FROM document_credits c
    WHERE c.emission_date <= :close_date
    GROUP BY c.bsale_document_id
), document_positions AS (
    SELECT d.*, GREATEST(ROUND(d.total_amount, 0)
      - ROUND(COALESCE(pt.paid_amount, 0), 0)
      - ROUND(COALESCE(ct.credit_amount, 0), 0), 0) AS pending_amount
    FROM eligible_documents d
    LEFT JOIN payment_totals pt ON pt.bsale_document_id = d.bsale_id
    LEFT JOIN credit_totals ct ON ct.bsale_document_id = d.bsale_id
    WHERE d.sign_for_sales = 1 AND d.emission_date <= :close_date
)
"""

ANALYSIS_DOCUMENTS_SQL = text(ANALYSIS_BASE_CTE + """
SELECT d.bsale_id AS document_id, d.emission_date, d.folio, d.document_type_name,
       d.total_amount, d.net_amount, d.tax_amount, d.expiration_date, d.pending_amount,
       d.url_pdf, d.client_id, c.code AS client_code,
       COALESCE(NULLIF(c.name, ''), NULLIF(c.company, ''), concat_ws(' ', c.first_name, c.last_name)) AS client_name,
       d.pending_amount > 0 AND d.expiration_date < :close_date AS overdue
FROM document_positions d
LEFT JOIN integraciones.vw_bsale_receivables_clients c
  ON c.company_id = d.company_id AND c.bsale_id = d.client_id
WHERE d.pending_amount > 0
ORDER BY d.pending_amount DESC, d.emission_date, d.folio
""")

ANALYSIS_DAILY_SQL = text(ANALYSIS_BASE_CTE + """
, document_events AS (
    SELECT d.bsale_id AS document_id, d.emission_date AS event_date,
           d.total_amount AS invoice_amount, 0::numeric AS paid_amount, 0::numeric AS credit_amount
    FROM eligible_documents d
    WHERE d.sign_for_sales = 1 AND d.emission_date <= :close_date
    UNION ALL
    SELECT p.bsale_document_id, p.payment_date, 0::numeric, p.amount_applied, 0::numeric
    FROM valid_payments p
    JOIN eligible_documents d ON d.company_id = p.company_id
                             AND d.bsale_id = p.bsale_document_id
                             AND d.sign_for_sales = 1
    WHERE p.payment_date <= :close_date
    UNION ALL
    SELECT c.bsale_document_id, c.emission_date, 0::numeric, 0::numeric, c.credit_amount
    FROM document_credits c
    WHERE c.emission_date <= :close_date
), event_totals AS (
    SELECT document_id, event_date, SUM(invoice_amount) AS invoice_amount,
           SUM(paid_amount) AS paid_amount, SUM(credit_amount) AS credit_amount
    FROM document_events
    GROUP BY document_id, event_date
), document_balance_points AS (
    SELECT d.bsale_id AS document_id, d.expiration_date, e.event_date,
           GREATEST(ROUND(d.total_amount, 0)
             - ROUND(SUM(e.paid_amount) OVER (PARTITION BY e.document_id ORDER BY e.event_date
                                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)
             - ROUND(SUM(e.credit_amount) OVER (PARTITION BY e.document_id ORDER BY e.event_date
                                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0), 0) AS pending_amount
    FROM event_totals e
    JOIN eligible_documents d ON d.bsale_id = e.document_id AND d.sign_for_sales = 1
), document_balance_deltas AS (
    SELECT document_id, expiration_date, event_date, pending_amount,
           pending_amount - COALESCE(LAG(pending_amount) OVER (PARTITION BY document_id ORDER BY event_date), 0) AS pending_delta,
           CASE WHEN pending_amount > 0 THEN 1 ELSE 0 END
             - COALESCE(LAG(CASE WHEN pending_amount > 0 THEN 1 ELSE 0 END) OVER (PARTITION BY document_id ORDER BY event_date), 0) AS pending_count_delta
    FROM document_balance_points
), pending_opening AS (
    SELECT DISTINCT ON (document_id) document_id, pending_amount AS amount,
           CASE WHEN pending_amount > 0 THEN 1 ELSE 0 END AS document_count
    FROM document_balance_points
    WHERE event_date < CAST(:start_date AS date)
    ORDER BY document_id, event_date DESC
), pending_daily_events AS (
    SELECT CAST(:start_date AS date) AS day, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(document_count), 0) AS document_count
    FROM pending_opening
    UNION ALL
    SELECT event_date, SUM(pending_delta), SUM(pending_count_delta)
    FROM document_balance_deltas
    WHERE event_date >= CAST(:start_date AS date)
    GROUP BY event_date
), pending_daily AS (
    SELECT day, SUM(amount) AS amount, SUM(document_count) AS document_count
    FROM pending_daily_events GROUP BY day
), overdue_opening AS (
    SELECT DISTINCT ON (document_id) document_id, pending_amount AS amount,
           CASE WHEN pending_amount > 0 THEN 1 ELSE 0 END AS document_count
    FROM document_balance_points
    WHERE event_date < CAST(:start_date AS date) AND expiration_date < CAST(:start_date AS date)
    ORDER BY document_id, event_date DESC
), overdue_entries AS (
    SELECT DISTINCT ON (d.document_id) d.document_id, d.expiration_date + 1 AS day,
           d.pending_amount AS amount, CASE WHEN d.pending_amount > 0 THEN 1 ELSE 0 END AS document_count
    FROM document_balance_points d
    WHERE d.expiration_date IS NOT NULL
      AND d.expiration_date + 1 >= CAST(:start_date AS date)
      AND d.expiration_date + 1 <= CAST(:close_date AS date)
      AND d.event_date <= d.expiration_date + 1
    ORDER BY d.document_id, d.event_date DESC
), overdue_daily_events AS (
    SELECT CAST(:start_date AS date) AS day, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(document_count), 0) AS document_count
    FROM overdue_opening
    UNION ALL
    SELECT day, SUM(amount), SUM(document_count) FROM overdue_entries GROUP BY day
    UNION ALL
    SELECT event_date, SUM(pending_delta), SUM(pending_count_delta)
    FROM document_balance_deltas
    WHERE expiration_date IS NOT NULL
      AND event_date > expiration_date + 1
      AND event_date >= CAST(:start_date AS date)
    GROUP BY event_date
), overdue_daily AS (
    SELECT day, SUM(amount) AS amount, SUM(document_count) AS document_count
    FROM overdue_daily_events GROUP BY day
), days AS (
    SELECT generate_series(CAST(:start_date AS date), CAST(:close_date AS date), interval '1 day')::date AS day
)
SELECT days.day,
       GREATEST(SUM(COALESCE(pending_daily.amount, 0)) OVER (ORDER BY days.day), 0) AS receivable_amount,
       GREATEST(SUM(COALESCE(overdue_daily.amount, 0)) OVER (ORDER BY days.day), 0) AS overdue_amount,
       GREATEST(SUM(COALESCE(pending_daily.document_count, 0)) OVER (ORDER BY days.day), 0)::bigint AS pending_documents
FROM days
LEFT JOIN pending_daily ON pending_daily.day = days.day
LEFT JOIN overdue_daily ON overdue_daily.day = days.day
ORDER BY days.day
""")

ANALYSIS_EVENTS_SQL = text(ANALYSIS_BASE_CTE + """
SELECT 'PAYMENT' AS event_type, p.bsale_document_id AS document_id, p.payment_date AS event_date,
       p.amount_applied AS amount, p.payment_type_name, p.operation_number, NULL::text AS reference
FROM integraciones.vw_bsale_receivables_payments p
WHERE p.company_id = :company_id AND p.state = 0 AND p.bsale_document_id = ANY(:document_ids)
  AND p.amount_applied > 0 AND p.payment_date IS NOT NULL AND p.payment_date <= :close_date
  AND (p.is_credit_payment IS TRUE OR (p.is_credit_payment IS FALSE AND p.payment_type_raw_json ->> 'isClientCredit' = '0'))
UNION ALL
SELECT 'CREDIT_NOTE', c.bsale_document_id, c.emission_date, c.credit_amount,
       NULL, NULL, c.credit_note_bsale_id::text
 FROM document_credits c WHERE c.company_id = :company_id AND c.bsale_document_id = ANY(:document_ids)
  AND c.emission_date <= :close_date
ORDER BY event_date
""")


def get_receivables_analysis(company_id: UUID, year: int, period: int) -> dict[str, Any]:
    effective = date.today()
    if period < 0 or period > 12:
        raise ValueError("period debe estar entre 0 y 12")
    if period == 0:
        start_date = date(year, 1, 1)
        close_date = effective
    else:
        start_date = date(year, period, 1)
        next_month = date(year + (period == 12), (period % 12) + 1, 1)
        close_date = min(effective, next_month.fromordinal(next_month.toordinal() - 1))
    if close_date < start_date:
        raise ValueError("El período aún no está disponible")

    settings = get_settings()
    if settings.database_runtime_dsn is None:
        raise RuntimeError("DATABASE_RUNTIME_DSN no está configurado")
    params = {
        "company_id": company_id, "year": year, "close_date": close_date,
        "start_date": start_date,
    }
    with get_session_factory(settings.database_runtime_dsn.get_secret_value())() as session:
        daily = session.execute(ANALYSIS_DAILY_SQL, params).mappings().all()
        documents = session.execute(ANALYSIS_DOCUMENTS_SQL, params).mappings().all()
        document_ids = [int(row["document_id"]) for row in documents]
        events = session.execute(
            ANALYSIS_EVENTS_SQL,
            {**params, "document_ids": document_ids or [-1]},
        ).mappings().all()

    events_by_document: dict[int, list[dict[str, Any]]] = {}
    for event in events:
        events_by_document.setdefault(int(event["document_id"]), []).append({
            "type": event["event_type"],
            "date": _date_string(event["event_date"]),
            "amount": _money_string(event["amount"]),
            "payment_type": event["payment_type_name"],
            "operation": event["operation_number"],
            "reference": event["reference"],
        })
    document_payload = []
    for row in documents:
        item = dict(row)
        item["emission_date"] = _date_string(item["emission_date"])
        item["expiration_date"] = _date_string(item["expiration_date"])
        for key in ("total_amount", "net_amount", "tax_amount", "pending_amount"):
            item[key] = _money_string(item[key])
        item["events"] = events_by_document.get(int(item["document_id"]), [])
        document_payload.append(item)
    return {
        "company_id": str(company_id), "year": year, "period": period,
        "period_start": start_date.isoformat(), "close_date": close_date.isoformat(),
        "currency": "CLP", "source": RECEIVABLES_SOURCE,
        "summary": {
            "receivable_amount": _money_string(sum((row["receivable_amount"] for row in daily), Decimal(0))),
            "overdue_amount": _money_string(sum((row["overdue_amount"] for row in daily), Decimal(0))),
            "closing_receivable_amount": _money_string(sum((row["receivable_amount"] for row in daily[-1:]), Decimal(0))),
            "closing_overdue_amount": _money_string(sum((row["overdue_amount"] for row in daily[-1:]), Decimal(0))),
            "pending_documents": int(daily[-1]["pending_documents"]) if daily else 0,
            "clients": len({row["client_id"] for row in documents}),
        },
        "daily": [{
            "date": _date_string(row["day"]),
            "receivable_amount": _money_string(row["receivable_amount"]),
            "overdue_amount": _money_string(row["overdue_amount"]),
            "pending_documents": int(row["pending_documents"]),
        } for row in daily],
        "documents": document_payload,
    }
