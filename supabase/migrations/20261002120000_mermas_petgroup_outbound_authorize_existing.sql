-- Legacy sync may insert the exact PetGroup movement before local application.
-- Applying the confirmed outbound is the authorization event for that row.

CREATE OR REPLACE FUNCTION mermas.authorize_petgroup_outbound_movements()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, mermas
AS $$
BEGIN
  IF NEW.local_applied_at IS NOT NULL
     AND OLD.local_applied_at IS NULL THEN
    UPDATE mermas.movements
    SET authorization_status = 'AUTORIZADA',
        authorized_by = NEW.created_by,
        authorized_at = now()
    WHERE company_id = NEW.company_id
      AND request_id = NEW.request_id
      AND consumption_id = NEW.bsale_consumption_id
      AND movement_type = 'ENTRADA_BSALE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mermas_authorize_petgroup_outbound_movements ON mermas.bsale_outbound_operations;
CREATE TRIGGER mermas_authorize_petgroup_outbound_movements
AFTER UPDATE OF local_applied_at ON mermas.bsale_outbound_operations
FOR EACH ROW EXECUTE FUNCTION mermas.authorize_petgroup_outbound_movements();
