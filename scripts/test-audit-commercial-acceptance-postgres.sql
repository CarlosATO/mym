-- Run only in an empty, disposable database.
\set ON_ERROR_STOP on
CREATE EXTENSION pgcrypto; CREATE EXTENSION dblink;
CREATE SCHEMA auth; CREATE SCHEMA core; CREATE SCHEMA portal; CREATE SCHEMA logistica; CREATE SCHEMA integraciones;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE core.companies(id uuid PRIMARY KEY);
CREATE TABLE portal.users(id uuid PRIMARY KEY, is_active boolean, deleted_at timestamptz);
CREATE TABLE logistica.sales_order_audits(id uuid PRIMARY KEY, company_id uuid, card_id uuid, status text, package_count integer);
CREATE TABLE logistica.sales_order_preparation_cards(id uuid PRIMARY KEY, company_id uuid, status text, canonical_bsale_token text, current_bsale_nv_id bigint, bsale_nv_id bigint);
CREATE TABLE logistica.sales_order_preparation_commercial_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, card_id uuid, sequence_no int, canonical_bsale_token text, historical_bsale_nv_id bigint, current_bsale_nv_id bigint, previous_fingerprint text, fingerprint text, version_snapshot jsonb, applied_actions jsonb, accepted_by uuid, UNIQUE(company_id,card_id,sequence_no), UNIQUE(company_id,card_id,fingerprint));
CREATE TABLE logistica.sales_order_audit_lines(id uuid, company_id uuid, card_id uuid, audit_id uuid, bsale_variant_id bigint, line_status text, audit_quantity numeric, prepared_quantity_snapshot numeric, excluded_from_dispatch_snapshot boolean);
CREATE TABLE logistica.sales_order_preparation_incidents(id uuid PRIMARY KEY, company_id uuid, card_id uuid, status text);
CREATE TABLE logistica.sales_order_audit_incidents(id uuid PRIMARY KEY, company_id uuid, audit_id uuid, status text);
CREATE TABLE logistica.sales_order_audit_commercial_verifications(id uuid PRIMARY KEY, company_id uuid, card_id uuid, audit_id uuid, is_current boolean);
CREATE TABLE integraciones.vw_bsale_sales_order_documents_canonical(company_id uuid, canonical_bsale_token text, current_bsale_id bigint);
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT COALESCE(current_setting('test.role',true),'service_role') $$;
CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE current_setting('test.access',true) WHEN 'no' THEN false WHEN 'null' THEN NULL ELSE true END $$;
CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE current_setting('test.permission',true) WHEN 'no' THEN false WHEN 'null' THEN NULL ELSE true END $$;
\i supabase/migrations/20261110150000_logistica_audit_commercial_acceptance.sql

INSERT INTO core.companies VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO portal.users VALUES ('00000000-0000-0000-0000-000000000004',true,NULL);
INSERT INTO logistica.sales_order_preparation_cards VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','IN_AUDIT','token',10,10);
INSERT INTO logistica.sales_order_audits VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','OPEN',8);
INSERT INTO logistica.sales_order_audit_lines VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',1,'CONFIRMED',4,4,false);
INSERT INTO logistica.sales_order_audit_lines VALUES (gen_random_uuid(),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',2,'CONFIRMED',12,12,false);
INSERT INTO integraciones.vw_bsale_sales_order_documents_canonical VALUES ('00000000-0000-0000-0000-000000000001','token',10);
INSERT INTO logistica.sales_order_preparation_commercial_versions(id,company_id,card_id,sequence_no,canonical_bsale_token,historical_bsale_nv_id,current_bsale_nv_id,fingerprint,version_snapshot) VALUES ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'token',93141,10,'old','{"identity":{"canonicalToken":"token","currentBsaleId":93141},"physicalId":93141,"lines":[{"detailId":1,"variantId":1,"sku":"P317","quantity":5,"unitNetValue":730,"lineNetAmount":3650,"lineTaxAmount":694,"lineGrossAmount":4344},{"detailId":2,"variantId":2,"sku":"AUT.","quantity":12,"unitNetValue":3000,"lineNetAmount":36000,"lineTaxAmount":6840,"lineGrossAmount":42840}],"sourceDetails":[{"id":1,"netDiscount":0},{"id":2,"netDiscount":0}],"netAmount":39650,"taxAmount":7534,"totalAmount":47184}');
UPDATE logistica.sales_order_preparation_commercial_versions SET version_snapshot=jsonb_set(version_snapshot,'{sourceDetails,0}', '{"id":"local-row","raw_json":{"id":1,"netDiscount":0}}');
INSERT INTO logistica.sales_order_audit_commercial_verifications VALUES ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',true);

CREATE FUNCTION logistica.fixture_request(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb := '{"identity":{"canonicalToken":"token","currentBsaleId":10},"physicalId":10,"lines":[{"detailId":1,"variantId":1,"sku":"P317","quantity":4,"unitNetValue":730,"lineNetAmount":2920,"lineTaxAmount":555,"lineGrossAmount":3475},{"detailId":2,"variantId":2,"sku":"AUT.","quantity":12,"unitNetValue":3000,"lineNetAmount":36000,"lineTaxAmount":6840,"lineGrossAmount":42840}],"sourceDetails":[{"id":1,"netDiscount":0},{"id":2,"netDiscount":0}],"netAmount":38920,"taxAmount":7395,"totalAmount":46315,"taxEvidence":{"canonicalToken":"token","fetchedAt":"2026-11-10T12:00:00Z","tax":{"id":1,"code":"14","percentage":19,"active":true,"source":"/taxes/1.json"},"previousDocument":{"id":93141,"taxIds":[1],"exemptAmount":0,"taxAmount":7534,"source":"/documents/93141/document_taxes.json"},"currentDocument":{"id":10,"taxIds":[1],"exemptAmount":0,"taxAmount":7395,"source":"/documents/10/document_taxes.json"},"products":[{"variantId":1,"productId":101,"taxIds":[1],"source":"/products/101/product_taxes.json"},{"variantId":2,"productId":102,"taxIds":[1],"source":"/products/102/product_taxes.json"}]}}'; fp text;
BEGIN
 fp := logistica.audit_commercial_snapshot_fingerprint_v1(snapshot);
 INSERT INTO logistica.sales_order_audit_commercial_acceptance_requests(id,company_id,card_id,audit_id,actor_id,previous_version_id,previous_fingerprint,approved_fingerprint,version_fingerprint,version_snapshot,approval_evidence,approved_at,verified_at)
 VALUES (p_id,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','old',fp,'canonical-v2',snapshot,jsonb_build_object('actorId','00000000-0000-0000-0000-000000000004','auditId','00000000-0000-0000-0000-000000000003','fingerprint',fp,'versionFingerprint','canonical-v2','approved',true),now()-interval '1 second',now());
END $$;

CREATE FUNCTION logistica.fixture_accept(p_id uuid, fp text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT logistica.accept_sales_order_audit_commercial_changes_v1('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',p_id,'00000000-0000-0000-0000-000000000004',COALESCE(fp,(SELECT approved_fingerprint FROM logistica.sales_order_audit_commercial_acceptance_requests WHERE id=p_id))) $$;
CREATE FUNCTION logistica.fixture_resign(p_id uuid) RETURNS void LANGUAGE sql AS $$ UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET approved_fingerprint=logistica.audit_commercial_snapshot_fingerprint_v1(version_snapshot), approval_evidence=jsonb_set(approval_evidence,'{fingerprint}',to_jsonb(logistica.audit_commercial_snapshot_fingerprint_v1(version_snapshot))) WHERE id=p_id $$;
SELECT logistica.fixture_request('00000000-0000-0000-0000-000000000006');

DO $$ DECLARE result jsonb; BEGIN
 -- Every failing call is rolled back to its implicit exception savepoint.
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006',repeat('0',64)); RAISE EXCEPTION 'bad fingerprint accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_REQUEST_INVALID' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET previous_fingerprint='stale';
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'stale accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_PREVIOUS_VERSION_STALE' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET previous_fingerprint='old';
 BEGIN PERFORM logistica.accept_sales_order_audit_commercial_changes_v1('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000004',repeat('0',64)); RAISE EXCEPTION 'wrong company accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_AUDIT_NOT_OPEN' THEN RAISE; END IF; END;
 PERFORM set_config('test.permission','no',true);
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'permission denied accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('test.permission','yes',true);
 UPDATE logistica.sales_order_audits SET status='COMPLETED';
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'closed accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_AUDIT_NOT_OPEN' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audits SET status='OPEN', package_count=NULL;
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'no packages accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_PACKAGES_REQUIRED' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audits SET package_count=8;
 UPDATE logistica.sales_order_audit_lines SET audit_quantity=3 WHERE bsale_variant_id=1;
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'bad physical accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_PHYSICAL_LINES_NOT_CONFORMING' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_lines SET audit_quantity=4 WHERE bsale_variant_id=1;
 INSERT INTO logistica.sales_order_preparation_incidents VALUES ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','OPEN');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'commercial incident accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_OPEN_INCIDENTS' THEN RAISE; END IF; END;
 IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_incidents WHERE status='OPEN') THEN RAISE EXCEPTION 'commercial incident modified'; END IF;
 UPDATE logistica.sales_order_preparation_incidents SET status='RESOLVED';
 INSERT INTO logistica.sales_order_audit_incidents VALUES ('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','OPEN');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'physical incident accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_OPEN_INCIDENTS' THEN RAISE; END IF; END;
 IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_incidents WHERE status='OPEN') THEN RAISE EXCEPTION 'physical incident modified'; END IF;
 UPDATE logistica.sales_order_audit_incidents SET status='RESOLVED';
 PERFORM set_config('test.permission','null',true);
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'null permission accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('test.permission','yes',true);
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,quantity}','3');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'modified request accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_REQUEST_INVALID' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,quantity}','4');
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_fingerprint='tampered';
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'modified canonical fingerprint accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_APPROVAL_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_fingerprint='canonical-v2';
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,percentage}','18');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'modified tax evidence accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_REQUEST_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,percentage}','19');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax}','null');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'missing tax accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax}','{"id":1,"code":"14","percentage":19,"active":true,"source":"/taxes/1.json"}');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,percentage}','18');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'wrong rate accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,percentage}','19');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,currentDocument,taxIds}','[1,2]');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'multiple taxes accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,currentDocument,taxIds}','[1]');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,products,0,taxIds}','[2]');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'wrong product tax accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,products,0,taxIds}','[1]');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,previousDocument,exemptAmount}','1');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'exemption accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,previousDocument,exemptAmount}','0');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,variantId}','3');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'changed product accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_PRODUCT_IDENTITY_AMBIGUOUS' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,variantId}','1');
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,source}','"/unverified"');
  PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
  BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'invalid tax source accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID' THEN RAISE; END IF; END;
  UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{taxEvidence,tax,source}','"/taxes/1.json"');
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,lineTaxAmount}','556');
 PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'rounding mismatch accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,lineTaxAmount}','555');
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=version_snapshot #- '{sourceDetails,0,netDiscount}';
 PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'missing discount accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_DISCOUNT_CHANGED' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{sourceDetails,0,netDiscount}','1');
 PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'changed discount accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_DISCOUNT_CHANGED' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(jsonb_set(version_snapshot,'{sourceDetails,0,netDiscount}','0'),'{lines,0,unitNetValue}','120');
 PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000006'); RAISE EXCEPTION 'changed price accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_QUANTITY_OR_PRICE_CHANGED' THEN RAISE; END IF; END;
 UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=jsonb_set(version_snapshot,'{lines,0,unitNetValue}','730');
 PERFORM logistica.fixture_resign('00000000-0000-0000-0000-000000000006');
 result := logistica.fixture_accept('00000000-0000-0000-0000-000000000006');
 IF result->>'status' <> 'ACCEPTED' THEN RAISE EXCEPTION 'acceptance failed'; END IF;
  IF (SELECT count(*) FROM logistica.sales_order_preparation_commercial_versions) <> 2 OR (SELECT count(*) FROM logistica.sales_order_audit_commercial_verifications WHERE is_current) <> 0 THEN RAISE EXCEPTION 'history or invalidation failure'; END IF;
  IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_commercial_versions WHERE sequence_no=2 AND version_snapshot->'taxEvidence'->'tax'->>'percentage'='19' AND applied_actions->0->'historicalTaxRateCertified'='false'::jsonb) THEN RAISE EXCEPTION 'tax evidence history missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_preparation_commercial_versions WHERE id='00000000-0000-0000-0000-000000000005' AND fingerprint='old' AND version_snapshot->'lines'->0->>'quantity'='5') OR NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_lines WHERE audit_quantity=4 AND prepared_quantity_snapshot=4) OR NOT EXISTS (SELECT 1 FROM logistica.sales_order_audits WHERE status='OPEN' AND package_count=8) THEN RAISE EXCEPTION 'physical data or history changed'; END IF;
 INSERT INTO logistica.sales_order_audit_commercial_verifications VALUES ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',true);
 IF logistica.fixture_accept('00000000-0000-0000-0000-000000000006')->>'status' <> 'ALREADY_ACCEPTED' OR NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_commercial_verifications WHERE id='00000000-0000-0000-0000-000000000010' AND is_current) THEN RAISE EXCEPTION 'idempotence failure'; END IF;
END $$;

-- Two independent requests are serialized by the audit/card locks.
DELETE FROM logistica.sales_order_audit_commercial_acceptance_requests;
DELETE FROM logistica.sales_order_preparation_commercial_versions WHERE sequence_no=2;
SELECT logistica.fixture_request('00000000-0000-0000-0000-000000000011');
SELECT logistica.fixture_request('00000000-0000-0000-0000-000000000012');
SELECT dblink_connect('writer', format('dbname=%s port=%s host=%s', current_database(), current_setting('port'), current_setting('unix_socket_directories')));
SELECT dblink_send_query('writer', $q$
 BEGIN;
 SELECT logistica.fixture_accept('00000000-0000-0000-0000-000000000011');
 SELECT pg_advisory_xact_lock(813273);
 SELECT pg_sleep(2);
 COMMIT;
$q$);
DO $$ DECLARE attempts integer := 0; BEGIN
 LOOP
   IF NOT pg_try_advisory_lock(813273) THEN EXIT; END IF;
   PERFORM pg_advisory_unlock(813273); PERFORM pg_sleep(0.02); attempts := attempts + 1;
   IF attempts > 50 THEN RAISE EXCEPTION 'writer did not acquire lock'; END IF;
 END LOOP;
 BEGIN PERFORM logistica.fixture_accept('00000000-0000-0000-0000-000000000012'); RAISE EXCEPTION 'concurrent stale accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_PREVIOUS_VERSION_STALE' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM logistica.sales_order_preparation_commercial_versions) <> 2 THEN RAISE EXCEPTION 'duplicate concurrent version'; END IF;
END $$;
SELECT dblink_disconnect('writer');
