-- Keep "Al día" separate from actual cash in route-guide operational data.

ALTER TABLE logistica.route_guide_items
  DROP CONSTRAINT IF EXISTS route_guide_items_payment_method_normalized_check;

ALTER TABLE logistica.route_guide_items
  ADD CONSTRAINT route_guide_items_payment_method_normalized_check
  CHECK (payment_method_normalized IN ('CASH', 'AL_DIA', 'CHECK', 'TRANSFER', 'CREDIT', 'UNKNOWN'));

CREATE OR REPLACE FUNCTION logistica.normalize_payment_method(p_original text)
RETURNS varchar(30) LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_s text;
BEGIN
    v_s := logistica.normalize_payment_text(p_original);
    IF v_s = '' THEN RETURN 'UNKNOWN'; END IF;

    IF v_s IN ('al dia', 'aldia') THEN RETURN 'AL_DIA'; END IF;

    IF v_s IN ('efectivo', 'contado', 'cash', 'pago contra entrega', 'prepago', '48 horas')
       OR v_s LIKE '%efectivo%' THEN
        RETURN 'CASH';
    END IF;
    IF v_s IN ('cheque', 'chq', 'cheq', 'documento cheque')
       OR v_s LIKE '%cheque%' OR v_s LIKE '%cheq%' OR v_s LIKE '%chq%' THEN
        RETURN 'CHECK';
    END IF;
    IF v_s LIKE '%transferencia%' OR v_s LIKE '%tranferencia%'
       OR v_s LIKE '%transf%' OR v_s LIKE '%deposito%' THEN
        RETURN 'TRANSFER';
    END IF;
    IF v_s LIKE '%credito%' OR v_s LIKE '%cuenta corriente%'
       OR v_s LIKE '%cta cte%' OR v_s LIKE '%fiado%' THEN
        RETURN 'CREDIT';
    END IF;
    RETURN 'UNKNOWN';
END;
$$;

ALTER FUNCTION logistica.normalize_payment_method(text) OWNER TO postgres;

-- Repair only legacy CASH rows whose original value unambiguously means Al día.
UPDATE logistica.route_guide_items AS item
SET payment_method_normalized = 'AL_DIA',
    requires_settlement = false
WHERE item.route_guide_id <> '24a8be95-f0b3-4dc9-a2b2-c5fd78d35592'::uuid
  AND item.payment_method_normalized = 'CASH'
  AND logistica.normalize_payment_method(item.payment_method_original) = 'AL_DIA';

-- Rebuild only affected guide aggregates; no settlement/payment tables are touched.
UPDATE logistica.route_guides AS guide
SET total_cash_expected = totals.cash,
    total_check_expected = totals.chk,
    total_credit = totals.credit,
    total_transfer = totals.transfer,
    total_unknown_payment = totals.unknown
FROM (
  SELECT item.route_guide_id,
         COALESCE(SUM(item.amount) FILTER (WHERE item.payment_method_normalized = 'CASH'), 0) AS cash,
         COALESCE(SUM(item.amount) FILTER (WHERE item.payment_method_normalized = 'CHECK'), 0) AS chk,
         COALESCE(SUM(item.amount) FILTER (WHERE item.payment_method_normalized = 'CREDIT'), 0) AS credit,
         COALESCE(SUM(item.amount) FILTER (WHERE item.payment_method_normalized = 'TRANSFER'), 0) AS transfer,
         COALESCE(SUM(item.amount) FILTER (WHERE item.payment_method_normalized = 'UNKNOWN'), 0) AS unknown
  FROM logistica.route_guide_items AS item
  WHERE item.route_guide_id <> '24a8be95-f0b3-4dc9-a2b2-c5fd78d35592'::uuid
  GROUP BY item.route_guide_id
) AS totals
WHERE guide.id = totals.route_guide_id
  AND guide.id <> '24a8be95-f0b3-4dc9-a2b2-c5fd78d35592'::uuid
  AND EXISTS (
    SELECT 1
    FROM logistica.route_guide_items AS candidate
    WHERE candidate.route_guide_id = guide.id
      AND candidate.payment_method_normalized = 'AL_DIA'
  );
