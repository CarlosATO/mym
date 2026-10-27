-- Rollback real: el trigger falla después de marcar la línea retirada.
CREATE OR REPLACE FUNCTION logistica.fixture_acceptance_fail()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.card_id = '30000000-0000-0000-0000-000000000006' THEN
    RAISE EXCEPTION 'fixture forced failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixture_acceptance_fail
BEFORE UPDATE OF retired_at ON logistica.sales_order_preparation_lines
FOR EACH ROW EXECUTE FUNCTION logistica.fixture_acceptance_fail();

DO $fixture$
DECLARE
  v_company uuid := '10000000-0000-0000-0000-000000000001';
  v_user uuid := '20000000-0000-0000-0000-000000000001';
  v_card uuid := '30000000-0000-0000-0000-000000000006';
  v_line uuid := '50000000-0000-0000-0000-000000000006';
  v_request uuid := '40000000-0000-0000-0000-000000000006';
  v_result jsonb;
  v_failed boolean := false;
BEGIN
  INSERT INTO logistica.sales_order_preparation_cards(id,company_id,bsale_nv_id,bsale_nv_folio,status,canonical_bsale_token,current_bsale_nv_id)
  VALUES(v_card,v_company,5600,'5600','IN_PREPARATION','fixture-token-5600',5600);
  INSERT INTO logistica.sales_order_preparation_lines(id,company_id,card_id,bsale_nv_id,bsale_detail_id,sku,product_name,requested_quantity)
  VALUES(v_line,v_company,v_card,5600,5601,'ROLLBACK','Rollback',1);
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id,company_id,card_id,expected_fingerprint,verified_current_bsale_nv_id,version_snapshot,plan_snapshot,verified_at,requested_by)
  VALUES(v_request,v_company,v_card,'fp-rollback',5601,jsonb_build_object('identity',jsonb_build_object('canonicalToken','fixture-token-5600'),'physicalId',5601),jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',jsonb_build_array(jsonb_build_object('kind','REMOVE','preparationLineId',v_line))),now(),v_user);
  BEGIN
    v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request,v_company,v_card,'fp-rollback',v_user);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'rollback trigger did not fail'; END IF;
  IF (SELECT retired_at FROM logistica.sales_order_preparation_lines WHERE id=v_line) IS NOT NULL THEN RAISE EXCEPTION 'partial retirement survived rollback'; END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_commercial_versions WHERE card_id=v_card) <> 0 THEN RAISE EXCEPTION 'partial version survived rollback'; END IF;
  RAISE NOTICE 'POSTGRES_ROLLBACK=PASS';
END;
$fixture$;
