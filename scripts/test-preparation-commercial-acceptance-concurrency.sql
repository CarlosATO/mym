-- Se ejecuta después del fixture principal en la misma base efímera.
CREATE OR REPLACE FUNCTION logistica.fixture_acceptance_sleep()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_sleep(2);
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixture_acceptance_sleep
BEFORE INSERT ON logistica.sales_order_preparation_commercial_versions
FOR EACH ROW EXECUTE FUNCTION logistica.fixture_acceptance_sleep();

DO $fixture$
DECLARE
  v_company uuid := '10000000-0000-0000-0000-000000000001';
  v_user uuid := '20000000-0000-0000-0000-000000000001';
  v_card uuid := '30000000-0000-0000-0000-000000000005';
  v_request uuid := '40000000-0000-0000-0000-000000000005';
BEGIN
  INSERT INTO logistica.sales_order_preparation_cards(id,company_id,bsale_nv_id,bsale_nv_folio,status,canonical_bsale_token,current_bsale_nv_id)
  VALUES(v_card,v_company,5500,'5500','IN_PREPARATION','fixture-token-5500',5500);
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id,company_id,card_id,expected_fingerprint,verified_current_bsale_nv_id,version_snapshot,plan_snapshot,verified_at,requested_by)
  VALUES(v_request,v_company,v_card,'fp-concurrent',5501,
    jsonb_build_object('identity',jsonb_build_object('canonicalToken','fixture-token-5500'),'physicalId',5501),
    jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',jsonb_build_array(jsonb_build_object('kind','ADD','current',jsonb_build_object('detailId',5501,'variantId',6501,'sku','CONCURRENT','productName','Concurrent','quantity',1)))),now(),v_user);
END;
$fixture$;
