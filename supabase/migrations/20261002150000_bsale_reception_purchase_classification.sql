CREATE VIEW integraciones.vw_bsale_reception_purchase_classification
WITH (security_invoker = true) AS
WITH source_rows AS (
    SELECT
        d.company_id,
        d.variant_id AS bsale_variant_id,
        d.variant_code,
        r.bsale_id AS reception_id,
        d.bsale_id AS reception_detail_id,
        r.admission_date,
        r.document,
        r.document_number,
        r.note,
        r.raw_json,
        d.quantity,
        d.cost,
        r.office_id,
        translate(upper(trim(coalesce(r.document, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN') AS document_norm,
        translate(upper(trim(coalesce(r.document_number, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN') AS document_number_norm,
        translate(upper(trim(coalesce(r.note, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN') AS note_norm,
        EXISTS (
            SELECT 1
            FROM mermas.bsale_reception_operations operation
            WHERE operation.company_id = d.company_id
              AND operation.reception_id = r.bsale_id
        ) AS has_merma_operation
    FROM integraciones.bsale_reception_details d
    JOIN integraciones.bsale_receptions r
      ON r.company_id = d.company_id
     AND r.bsale_id = d.bsale_reception_id
), classified AS (
    SELECT
        source_rows.*,
        CASE
            WHEN bsale_variant_id IS NULL THEN 'NO_VARIANT'
            WHEN coalesce(quantity, 0) <= 0 THEN 'INVALID_ZERO_QUANTITY'
            WHEN coalesce(cost, 0) <= 0 THEN 'INVALID_ZERO_COST'
            WHEN document_norm LIKE '%NOTA DE CREDITO%' THEN 'INVALID_CREDIT_NOTE'
            WHEN document_norm LIKE '%VENTA ANULADA%' THEN 'INVALID_SALE_REVERSAL'
            WHEN raw_json ->> 'cancellationStatus' = '1' THEN 'INVALID_CANCELLED'
            WHEN document_norm LIKE '%ANULAD%' THEN 'INVALID_CANCELLED'
            WHEN has_merma_operation
              OR document_norm LIKE '%MERMA%'
              OR note_norm LIKE '%MERMA%'
              OR document_norm LIKE '%REINTEGRO%'
              OR note_norm LIKE '%REINTEGRO%'
              OR document_norm LIKE '%REVERSION%'
              OR note_norm LIKE '%REVERSION%' THEN 'INVALID_MERMA_REINTEGRATION'
            WHEN document_number_norm LIKE '%AJUST%'
              OR note_norm LIKE '%AJUST%'
              OR document_norm LIKE '%AJUST%' THEN 'INVALID_INTERNAL_ADJUSTMENT'
            WHEN document_norm LIKE '%GUIA%' THEN 'AMBIGUOUS_GUIDE'
            WHEN document_norm = '' OR document_norm = 'SIN DOCUMENTO' THEN 'AMBIGUOUS_NO_DOCUMENT'
            WHEN document_norm = 'FACTURA'
              AND (document_number_norm ~ '(^|[^A-Z])NC([^A-Z]|$)'
                OR note_norm LIKE '% NOTA DE CREDITO%'
                OR note_norm ~ '(^|[^A-Z])NC([^A-Z]|$)') THEN 'AMBIGUOUS_INVOICE_REFERENCE'
            WHEN document_norm = 'FACTURA'
              AND (note_norm LIKE '%GERENCIA PREMIUM%') THEN 'AMBIGUOUS_INTERNAL_INVOICE'
            WHEN document_norm = 'FACTURA' THEN 'VALID_PURCHASE'
            ELSE 'AMBIGUOUS_OTHER_DOCUMENT'
        END AS purchase_validity_status
    FROM source_rows
)
SELECT
    company_id,
    bsale_variant_id,
    variant_code,
    reception_id,
    reception_detail_id,
    admission_date,
    document,
    document_number,
    note,
    quantity,
    cost,
    office_id,
    purchase_validity_status,
    CASE purchase_validity_status
        WHEN 'NO_VARIANT' THEN 'Detalle sin variante Bsale.'
        WHEN 'INVALID_ZERO_QUANTITY' THEN 'Quantity no positiva.'
        WHEN 'INVALID_ZERO_COST' THEN 'Cost no positivo.'
        WHEN 'INVALID_CREDIT_NOTE' THEN 'Nota de crédito: no es compra válida para último costo.'
        WHEN 'INVALID_SALE_REVERSAL' THEN 'Recepción generada por venta anulada.'
        WHEN 'INVALID_CANCELLED' THEN 'Documento o guía anulada.'
        WHEN 'INVALID_MERMA_REINTEGRATION' THEN 'Merma, reintegro, reversión u operación de merma relacionada.'
        WHEN 'INVALID_INTERNAL_ADJUSTMENT' THEN 'Ajuste interno identificado en documento, número o nota.'
        WHEN 'AMBIGUOUS_GUIDE' THEN 'Guía sin evidencia suficiente de compra.'
        WHEN 'AMBIGUOUS_NO_DOCUMENT' THEN 'Recepción sin documento identificable.'
        WHEN 'AMBIGUOUS_INVOICE_REFERENCE' THEN 'Factura con referencia a nota de crédito.'
        WHEN 'AMBIGUOUS_INTERNAL_INVOICE' THEN 'Factura con nota interna de operación ambigua.'
        WHEN 'VALID_PURCHASE' THEN 'Factura normal con quantity y cost positivos, sin exclusiones detectadas.'
        ELSE 'Tipo documental no demostrado como compra.'
    END AS purchase_validity_reason
FROM classified;

REVOKE ALL ON integraciones.vw_bsale_reception_purchase_classification
FROM anon, authenticated;

GRANT SELECT ON integraciones.vw_bsale_reception_purchase_classification
TO service_role;

CREATE VIEW integraciones.vw_bsale_variant_last_purchase_cost
WITH (security_invoker = true) AS
WITH ranked AS (
    SELECT
        classification.company_id,
        classification.bsale_variant_id,
        classification.variant_code,
        classification.cost AS last_purchase_cost,
        classification.quantity AS last_purchase_quantity,
        classification.admission_date AS last_purchase_date,
        classification.reception_id AS last_reception_id,
        classification.reception_detail_id AS last_reception_detail_id,
        classification.document AS last_document,
        classification.document_number AS last_document_number,
        row_number() OVER (
            PARTITION BY classification.company_id, classification.bsale_variant_id
            ORDER BY classification.admission_date DESC NULLS LAST,
                     classification.reception_id DESC,
                     classification.reception_detail_id DESC
        ) AS row_number
    FROM integraciones.vw_bsale_reception_purchase_classification classification
    WHERE classification.purchase_validity_status = 'VALID_PURCHASE'
)
SELECT
    company_id,
    bsale_variant_id,
    variant_code,
    last_purchase_cost,
    last_purchase_quantity,
    last_purchase_date,
    last_reception_id,
    last_reception_detail_id,
    last_document,
    last_document_number
FROM ranked
WHERE row_number = 1;

REVOKE ALL ON integraciones.vw_bsale_variant_last_purchase_cost
FROM anon, authenticated;

GRANT SELECT ON integraciones.vw_bsale_variant_last_purchase_cost
TO service_role;
