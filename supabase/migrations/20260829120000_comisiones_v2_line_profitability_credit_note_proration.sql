-- COMV2-34B2-QA: prorate credit-note cost from the resolved invoice line.
-- A credit note can keep the original quantity while reversing only part of
-- the invoice net amount, so quantity alone is not a safe reversal ratio.

DO $$
DECLARE
    v_definition text;
    v_old text := $old$
        CASE
            WHEN origin.cost_status = 'COSTED'
                THEN (origin.unit_cost * nc.quantity)::numeric
            ELSE NULL::numeric
        END AS line_cost,
$old$;
    v_new text := $new$
        CASE
            WHEN origin.cost_status = 'COSTED' AND origin.net_sales <> 0
                THEN (origin.line_cost * (nc.net_amount / origin.net_sales))::numeric
            ELSE NULL::numeric
        END AS line_cost,
$new$;
BEGIN
    SELECT pg_get_functiondef(
        'comisiones.get_v2_lines_profitability(uuid,date,date)'::regprocedure
    ) INTO v_definition;

    IF position(v_old IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Expected credit-note cost expression was not found';
    END IF;

    EXECUTE replace(v_definition, v_old, v_new);
END;
$$;

COMMENT ON FUNCTION comisiones.get_v2_lines_profitability(uuid, date, date) IS
    'Read-only historical profitability for Comisiones V2 simulation lines. Credit-note cost is prorated from the resolved invoice line net reversal.';
