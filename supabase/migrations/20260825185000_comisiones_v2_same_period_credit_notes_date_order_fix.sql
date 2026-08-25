-- COMV2-29D: a credit note keeps the original invoice payment date, which
-- may precede the credit-note emission date. Apply payment-date ordering only
-- to invoices while retaining credit-note date ordering.

ALTER TABLE comisiones.settlement_lines
    DROP CONSTRAINT chk_comisiones_settlement_lines_date_order;

ALTER TABLE comisiones.settlement_lines
    ADD CONSTRAINT chk_comisiones_settlement_lines_date_order CHECK (
        (
            line_kind = 'CREDIT_NOTE'
            OR document_emission_date IS NULL
            OR full_payment_date IS NULL
            OR full_payment_date >= document_emission_date
        )
        AND (
            line_kind = 'INVOICE'
            OR credit_note_date IS NULL
            OR document_emission_date IS NULL
            OR credit_note_date >= document_emission_date
        )
    );
