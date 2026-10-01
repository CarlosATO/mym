-- Compatibility guard for the existing sync path.
-- A locally applied PetGroup consumption must not be reclassified as DIRECTO_BSALE
-- when the later sync sees the same remote consumption.

CREATE OR REPLACE FUNCTION mermas.preserve_petgroup_outbound_match()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, mermas
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.match_method = 'PETGROUP_OUTBOUND'
     AND OLD.request_id IS NOT NULL THEN
    NEW.request_id := OLD.request_id;
    NEW.match_method := OLD.match_method;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mermas.skip_petgroup_outbound_direct_movement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, mermas
AS $$
BEGIN
  IF NEW.source = 'BSALE'
     AND NEW.request_id IS NULL
     AND NEW.consumption_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM mermas.bsale_consumptions c
       WHERE c.company_id = NEW.company_id
         AND c.consumption_id = NEW.consumption_id
         AND c.request_id IS NOT NULL
         AND c.match_method = 'PETGROUP_OUTBOUND'
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mermas_preserve_petgroup_outbound_match ON mermas.bsale_consumptions;
CREATE TRIGGER mermas_preserve_petgroup_outbound_match
BEFORE UPDATE ON mermas.bsale_consumptions
FOR EACH ROW EXECUTE FUNCTION mermas.preserve_petgroup_outbound_match();

DROP TRIGGER IF EXISTS mermas_skip_petgroup_outbound_direct_movement ON mermas.movements;
CREATE TRIGGER mermas_skip_petgroup_outbound_direct_movement
BEFORE INSERT ON mermas.movements
FOR EACH ROW EXECUTE FUNCTION mermas.skip_petgroup_outbound_direct_movement();
