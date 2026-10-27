-- Fixture destructivo para una base PostgreSQL efímera.
-- No contiene IDs ni datos de producción.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS portal;
CREATE SCHEMA IF NOT EXISTS logistica;
CREATE SCHEMA IF NOT EXISTS integraciones;
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END
$roles$;

CREATE TABLE core.companies (id uuid PRIMARY KEY);
CREATE TABLE portal.users (id uuid PRIMARY KEY, nombre text, apellido text);
CREATE OR REPLACE FUNCTION core.has_company_access(uuid, uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

CREATE TABLE logistica.sales_order_preparation_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  bsale_nv_id bigint NOT NULL, bsale_nv_folio text NOT NULL,
  status text NOT NULL, canonical_bsale_token text, current_bsale_nv_id bigint,
  assigned_user_id uuid, locked_by_user_id uuid, locked_at timestamptz,
  last_moved_by uuid, last_moved_at timestamptz, closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE logistica.sales_order_preparation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE CASCADE,
  bsale_nv_id bigint NOT NULL, bsale_detail_id bigint NOT NULL, bsale_variant_id bigint,
  sku text, product_name text NOT NULL, requested_quantity numeric NOT NULL,
  prepared_quantity numeric, line_status text NOT NULL DEFAULT 'PENDING',
  excluded_from_dispatch boolean NOT NULL DEFAULT false, confirmed_by uuid, confirmed_at timestamptz,
  source_snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, card_id, bsale_detail_id)
);
CREATE TABLE logistica.sales_order_preparation_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
  preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN', incident_type text NOT NULL,
  reason_code text NOT NULL DEFAULT 'OTRO', observation text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE logistica.sales_order_audit_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
  preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT
);
CREATE TABLE logistica.sales_order_audit_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
  card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
  preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_preparation_snapshot(uuid, uuid)
RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text,
  p_user_id uuid, p_user_name text
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_pending integer;
BEGIN
  SELECT count(*) INTO v_pending FROM logistica.sales_order_preparation_lines
   WHERE company_id = p_company_id AND card_id = p_card_id
     AND (line_status = 'PENDING' OR prepared_quantity IS NULL);
  RETURN jsonb_build_object('pending', v_pending);
END;
$$;
CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_preparation_line(
  p_company_id uuid, p_line_id uuid, p_prepared_quantity numeric,
  p_reason_code text DEFAULT NULL, p_observation text DEFAULT NULL, p_excluded boolean DEFAULT false
)
RETURNS logistica.sales_order_preparation_lines LANGUAGE plpgsql AS $$
DECLARE v_line logistica.sales_order_preparation_lines%ROWTYPE;
BEGIN
  SELECT l.* INTO v_line FROM logistica.sales_order_preparation_lines l
   WHERE l.id = p_line_id AND l.company_id = p_company_id FOR UPDATE;
  RETURN v_line;
END;
$$;
CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_audit_snapshot(
  p_company_id uuid, p_card_id uuid, p_actor_id uuid, p_cycle_no integer
)
RETURNS uuid LANGUAGE sql AS $$ SELECT p_card_id $$;

\i supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql

-- Segunda ejecución: debe ser idempotente.
\i supabase/migrations/20261027120000_logistica_preparation_commercial_acceptance.sql

DO $fixture$
DECLARE
  v_company uuid := '10000000-0000-0000-0000-000000000001';
  v_user uuid := '20000000-0000-0000-0000-000000000001';
  v_card uuid := '30000000-0000-0000-0000-000000000001';
  v_prepared_card uuid := '30000000-0000-0000-0000-000000000002';
  v_incident_card uuid := '30000000-0000-0000-0000-000000000003';
  v_audit_card uuid := '30000000-0000-0000-0000-000000000004';
  v_line uuid;
  v_request uuid := '40000000-0000-0000-0000-000000000001';
  v_request_prepared uuid := '40000000-0000-0000-0000-000000000002';
  v_request_incident uuid := '40000000-0000-0000-0000-000000000003';
  v_request_audit uuid := '40000000-0000-0000-0000-000000000004';
  v_result jsonb;
  v_actions jsonb;
  v_version jsonb;
  v_line_ids jsonb := '[]';
  i integer;
BEGIN
  INSERT INTO core.companies VALUES (v_company);
  INSERT INTO portal.users VALUES (v_user, 'Fixture', 'Operator');

  INSERT INTO logistica.sales_order_preparation_cards(id, company_id, bsale_nv_id, bsale_nv_folio, status, canonical_bsale_token, current_bsale_nv_id)
  VALUES (v_card, v_company, 5129, '5129', 'IN_PREPARATION', 'fixture-token-5129', 5129),
         (v_prepared_card, v_company, 5200, '5200', 'IN_PREPARATION', 'fixture-token-5200', 5200),
         (v_incident_card, v_company, 5300, '5300', 'IN_PREPARATION', 'fixture-token-5300', 5300),
         (v_audit_card, v_company, 5400, '5400', 'IN_AUDIT', 'fixture-token-5400', 5400);

  -- NV 5129: ocho líneas anteriores, MGMYM es detail 1008.
  FOR i IN 1..8 LOOP
    INSERT INTO logistica.sales_order_preparation_lines(company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name, requested_quantity, source_snapshot)
    VALUES (v_company, v_card, 5129, 1000 + i, 2000 + i, 'SKU-' || i, CASE WHEN i = 8 THEN 'MGMYM' ELSE 'Producto ' || i END, 1, jsonb_build_object('detail_id', 1000+i, 'variant_id', 2000+i, 'sku', 'SKU-'||i, 'product_name', CASE WHEN i=8 THEN 'MGMYM' ELSE 'Producto '||i END, 'quantity', 1));
  END LOOP;
  SELECT jsonb_agg(id) INTO v_line_ids FROM logistica.sales_order_preparation_lines WHERE card_id = v_card;
  v_version := jsonb_build_object('identity', jsonb_build_object('canonicalToken', 'fixture-token-5129', 'historicalBsaleId', 5129, 'currentBsaleId', 51290, 'folio', '5129'), 'physicalId', 51290, 'lines', jsonb_build_array());
  v_actions := jsonb_build_array(
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1001)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1002)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1003)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1004)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1005)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1006)),
    jsonb_build_object('kind','KEEP','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1007)),
    jsonb_build_object('kind','REMOVE','preparationLineId',(SELECT id FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1008)),
    jsonb_build_object('kind','ADD','current',jsonb_build_object('detailId',1090,'variantId',2090,'sku','MUESTRA','productName','MUESTRA','quantity',1)),
    jsonb_build_object('kind','ADD','current',jsonb_build_object('detailId',1091,'variantId',2091,'sku','PW12401','productName','PW12401','quantity',1))
  );
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id, company_id, card_id, expected_fingerprint, previous_fingerprint, verified_current_bsale_nv_id, version_snapshot, plan_snapshot, verified_at, requested_by)
  VALUES (v_request, v_company, v_card, 'fp-5129-new', 'fp-5129-old', 51290, v_version, jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',v_actions), now(), v_user);
  v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request, v_company, v_card, 'fp-5129-new', v_user);
  IF v_result->>'status' <> 'ACCEPTED' THEN RAISE EXCEPTION 'NV 5129 fixture failed: %', v_result; END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND retired_at IS NULL) <> 9 THEN RAISE EXCEPTION 'active line count mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND bsale_detail_id=1008 AND retired_at IS NOT NULL) THEN RAISE EXCEPTION 'MGMYM was not retired'; END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_lines WHERE card_id=v_card AND line_status='PENDING' AND bsale_detail_id IN (1090,1091)) <> 2 THEN RAISE EXCEPTION 'ADD lines not pending'; END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_commercial_versions WHERE card_id=v_card AND fingerprint='fp-5129-new') <> 1 THEN RAISE EXCEPTION 'accepted version missing'; END IF;
  v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request, v_company, v_card, 'fp-5129-new', v_user);
  IF v_result->>'status' <> 'ALREADY_ACCEPTED' THEN RAISE EXCEPTION 'idempotency failed: %', v_result; END IF;

  -- Cantidad preparada: el trabajo físico y su confirmación se conservan.
  INSERT INTO logistica.sales_order_preparation_lines(id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name, requested_quantity, prepared_quantity, line_status, confirmed_by, confirmed_at)
  VALUES ('50000000-0000-0000-0000-000000000001', v_company, v_prepared_card, 5200, 5201, 6201, 'PREP', 'Preparado', 2, 1, 'INCIDENT', v_user, now());
  v_version := jsonb_build_object('identity',jsonb_build_object('canonicalToken','fixture-token-5200'),'physicalId',5201);
  v_actions := jsonb_build_array(jsonb_build_object('kind','UPDATE_QUANTITY','preparationLineId','50000000-0000-0000-0000-000000000001','newRequestedQuantity',3,'current',jsonb_build_object('detailId',5201,'variantId',6201,'sku','PREP','productName','Preparado','quantity',3)));
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id, company_id, card_id, expected_fingerprint, verified_current_bsale_nv_id, version_snapshot, plan_snapshot, verified_at, requested_by)
  VALUES (v_request_prepared,v_company,v_prepared_card,'fp-prepared',5201,v_version,jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',v_actions),now(),v_user);
  v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request_prepared,v_company,v_prepared_card,'fp-prepared',v_user);
  IF v_result->>'status' <> 'ACCEPTED' OR (SELECT prepared_quantity FROM logistica.sales_order_preparation_lines WHERE id='50000000-0000-0000-0000-000000000001') <> 1 THEN RAISE EXCEPTION 'prepared work not preserved: %', v_result; END IF;

  -- Incidencia relacionada: el plan puede existir, pero la RPC debe bloquearlo.
  INSERT INTO logistica.sales_order_preparation_lines(id, company_id, card_id, bsale_nv_id, bsale_detail_id, sku, product_name, requested_quantity)
  VALUES ('50000000-0000-0000-0000-000000000002',v_company,v_incident_card,5300,5301,'INC','Con incidencia',1);
  INSERT INTO logistica.sales_order_preparation_incidents(company_id,card_id,preparation_line_id,incident_type)
  VALUES (v_company,v_incident_card,'50000000-0000-0000-0000-000000000002','LINE_EXCLUDED');
  v_version := jsonb_build_object('identity',jsonb_build_object('canonicalToken','fixture-token-5300'),'physicalId',5301);
  v_actions := jsonb_build_array(jsonb_build_object('kind','REMOVE','preparationLineId','50000000-0000-0000-0000-000000000002'));
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id, company_id, card_id, expected_fingerprint, verified_current_bsale_nv_id, version_snapshot, plan_snapshot, verified_at, requested_by)
  VALUES (v_request_incident,v_company,v_incident_card,'fp-incident',5301,v_version,jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',v_actions),now(),v_user);
  v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request_incident,v_company,v_incident_card,'fp-incident',v_user);
  IF v_result->>'status' <> 'REQUIRES_RESOLUTION' OR (SELECT count(*) FROM logistica.sales_order_preparation_incidents WHERE card_id=v_incident_card) <> 1 THEN RAISE EXCEPTION 'incident protection failed: %',v_result; END IF;

  -- Auditoría se rechaza antes de tocar líneas.
  v_version := jsonb_build_object('identity',jsonb_build_object('canonicalToken','fixture-token-5400'),'physicalId',5401);
  INSERT INTO logistica.sales_order_preparation_commercial_acceptance_requests(id, company_id, card_id, expected_fingerprint, verified_current_bsale_nv_id, version_snapshot, plan_snapshot, verified_at, requested_by)
  VALUES (v_request_audit,v_company,v_audit_card,'fp-audit',5401,v_version,jsonb_build_object('status','READY','conflicts',jsonb_build_array(),'actions',jsonb_build_array()),now(),v_user);
  v_result := logistica.accept_sales_order_preparation_commercial_changes(v_request_audit,v_company,v_audit_card,'fp-audit',v_user);
  IF v_result->>'status' <> 'INVALID_STATUS' THEN RAISE EXCEPTION 'audit protection failed: %',v_result; END IF;

  RAISE NOTICE 'POSTGRES_ACCEPTANCE_FIXTURES=PASS';
END;
$fixture$;
