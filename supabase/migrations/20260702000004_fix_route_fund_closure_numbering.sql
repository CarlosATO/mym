-- MIGRATION: 20260702000004_fix_route_fund_closure_numbering.sql

-- 1. Create a secure, transactional RPC to generate the next sequence number.
--    This uses SECURITY DEFINER so it can modify the counters table regardless of RLS.
CREATE OR REPLACE FUNCTION adquisiciones.get_next_route_fund_closure_number(p_company_id uuid, p_year integer)
RETURNS integer AS $$
DECLARE
    v_next_sequence integer;
BEGIN
    INSERT INTO adquisiciones.route_fund_closure_counters (company_id, closure_year, last_sequence)
    VALUES (p_company_id, p_year, 1)
    ON CONFLICT (company_id, closure_year)
    DO UPDATE SET last_sequence = route_fund_closure_counters.last_sequence + 1
    RETURNING last_sequence INTO v_next_sequence;

    RETURN v_next_sequence;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Backfill: ensure the sequence in the counter matches the maximum sequence actually used in closures.
DO $$
DECLARE
    v_record RECORD;
BEGIN
    FOR v_record IN 
        SELECT company_id, closure_year, MAX(closure_sequence) as max_seq
        FROM adquisiciones.route_fund_closures
        GROUP BY company_id, closure_year
    LOOP
        INSERT INTO adquisiciones.route_fund_closure_counters (company_id, closure_year, last_sequence)
        VALUES (v_record.company_id, v_record.closure_year, v_record.max_seq)
        ON CONFLICT (company_id, closure_year)
        DO UPDATE SET last_sequence = GREATEST(route_fund_closure_counters.last_sequence, v_record.max_seq);
    END LOOP;
END $$;

-- 3. Add the recommended unique constraint to prevent duplicates logically
ALTER TABLE adquisiciones.route_fund_closures 
DROP CONSTRAINT IF EXISTS uq_route_fund_closures_year_seq;

ALTER TABLE adquisiciones.route_fund_closures 
ADD CONSTRAINT uq_route_fund_closures_year_seq UNIQUE (company_id, closure_year, closure_sequence);
