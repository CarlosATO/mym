CREATE OR REPLACE FUNCTION comercial.protect_historical_commission_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source = 'HISTORICAL' THEN
    RAISE EXCEPTION 'Historical commission settlement cannot be modified';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION comercial.protect_historical_commission_settlement_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  settlement_source text;
BEGIN
  SELECT source
  INTO settlement_source
  FROM comercial.commission_settlements
  WHERE id = OLD.settlement_id;

  IF settlement_source = 'HISTORICAL' THEN
    RAISE EXCEPTION 'Historical commission settlement lines cannot be modified or deleted';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER protect_historical_commission_settlement_update
BEFORE UPDATE ON comercial.commission_settlements
FOR EACH ROW EXECUTE PROCEDURE comercial.protect_historical_commission_settlement();

CREATE TRIGGER protect_historical_commission_settlement_line_change
BEFORE UPDATE OR DELETE ON comercial.commission_settlement_lines
FOR EACH ROW EXECUTE PROCEDURE comercial.protect_historical_commission_settlement_line();
