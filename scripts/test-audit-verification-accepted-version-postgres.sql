-- Only run against a disposable empty PostgreSQL database.
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth; CREATE SCHEMA core; CREATE SCHEMA logistica; CREATE SCHEMA integraciones;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('test.actor', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role', true) $$;
CREATE FUNCTION core.has_company_access(uuid, uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.allowed', true) = 'yes' $$;
CREATE FUNCTION core.has_permission_for_company(uuid, uuid, text) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.allowed', true) = 'yes' $$;
CREATE TABLE logistica.sales_order_audits (id uuid PRIMARY KEY, company_id uuid, card_id uuid, status text);
CREATE TABLE logistica.sales_order_preparation_cards (id uuid PRIMARY KEY, company_id uuid, status text, canonical_bsale_token text, current_bsale_nv_id bigint, updated_at timestamptz);
CREATE TABLE logistica.sales_order_preparation_commercial_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, card_id uuid, sequence_no integer, version_snapshot jsonb);
CREATE TABLE logistica.sales_order_audit_commercial_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, card_id uuid, audit_id uuid,
  status text, canonical_bsale_token text, current_bsale_nv_id bigint, reason text, fingerprint text,
  snapshot jsonb, differences jsonb, is_current boolean DEFAULT true, verified_at timestamptz DEFAULT now()
);
CREATE TABLE integraciones.vw_bsale_sales_order_documents_canonical (company_id uuid, canonical_bsale_token text, current_bsale_id bigint);
\i supabase/migrations/20261110130000_logistica_audit_verification_accepted_version_guard.sql
SELECT set_config('test.role', 'authenticated', false), set_config('test.actor', '00000000-0000-0000-0000-000000000004', false), set_config('test.allowed', 'yes', false);
INSERT INTO logistica.sales_order_audits VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'OPEN');
INSERT INTO logistica.sales_order_preparation_cards VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'IN_AUDIT', 'token', 10, now());
INSERT INTO integraciones.vw_bsale_sales_order_documents_canonical VALUES ('00000000-0000-0000-0000-000000000001', 'token', 10);
INSERT INTO logistica.sales_order_preparation_commercial_versions (company_id, card_id, sequence_no, version_snapshot) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 1, '{"version":1}');
CREATE FUNCTION logistica.test_verify(ref jsonb, fp text DEFAULT repeat('a', 64), result_status text DEFAULT 'READY_TO_INVOICE') RETURNS jsonb LANGUAGE sql AS $$
 SELECT logistica.record_sales_order_audit_commercial_verification_v1(
 '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003',
 result_status, 10, 'token', 'test', fp,
 jsonb_build_object('cardId','00000000-0000-0000-0000-000000000002','auditId','00000000-0000-0000-0000-000000000003',
 'status',result_status,'acceptedVersion',ref,'comparison',jsonb_build_object('status',result_status,'differences',CASE WHEN result_status = 'INCIDENTS' THEN '[{"x":1}]'::jsonb ELSE '[]'::jsonb END),
 'currentVersion',jsonb_build_object('physicalId',10,'identity',jsonb_build_object('canonicalToken','token','currentBsaleId',10))),
 CASE WHEN result_status = 'INCIDENTS' THEN '[{"x":1}]'::jsonb ELSE '[]'::jsonb END) $$;
DO $$ DECLARE a jsonb; b jsonb; BEGIN
 a := logistica.test_verify('{"version":1}'); b := logistica.test_verify('{"version":1}');
 IF a->>'id' IS DISTINCT FROM b->>'id' THEN RAISE EXCEPTION 'idempotence failure'; END IF;
 INSERT INTO logistica.sales_order_preparation_commercial_versions (company_id, card_id, sequence_no, version_snapshot) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 2, '{"version":2}');
 BEGIN PERFORM logistica.test_verify('{"version":1}', repeat('b',64)); RAISE EXCEPTION 'stale accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_COMMERCIAL_ACCEPTED_VERSION_STALE' THEN RAISE; END IF; END;
 IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_commercial_verifications WHERE id = (a->>'id')::uuid AND is_current) THEN RAISE EXCEPTION 'stale invalidated current'; END IF;
 PERFORM logistica.test_verify('{"version":2}', repeat('c',64), 'INCIDENTS');
 PERFORM logistica.test_verify('{"version":2}', repeat('d',64), 'BLOCKED');
 PERFORM set_config('test.allowed','no',true);
 BEGIN PERFORM logistica.test_verify('{"version":2}'); RAISE EXCEPTION 'unauthorized accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('test.allowed','yes',true);
 UPDATE logistica.sales_order_audits SET status = 'COMPLETED';
 BEGIN PERFORM logistica.test_verify('{"version":2}'); RAISE EXCEPTION 'closed accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_COMMERCIAL_AUDIT_NOT_OPEN' THEN RAISE; END IF; END;
END $$;

-- A second session appends a version while holding the same audit/card locks.
-- The verification must wait, see the committed version, and reject its old reference.
CREATE EXTENSION dblink;
UPDATE logistica.sales_order_audits SET status = 'OPEN';
SELECT dblink_connect('writer', format('dbname=%s port=%s host=%s', current_database(), current_setting('port'), current_setting('unix_socket_directories')));
SELECT dblink_send_query('writer', $query$
 BEGIN;
 SELECT pg_advisory_xact_lock(813272);
 SELECT id FROM logistica.sales_order_audits WHERE id='00000000-0000-0000-0000-000000000003' FOR UPDATE;
 SELECT id FROM logistica.sales_order_preparation_cards WHERE id='00000000-0000-0000-0000-000000000002' FOR UPDATE;
 INSERT INTO logistica.sales_order_preparation_commercial_versions (company_id,card_id,sequence_no,version_snapshot)
 VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',3,'{"version":3}');
 SELECT pg_sleep(2);
 COMMIT;
$query$);
DO $$ DECLARE attempts integer := 0; before_id uuid; BEGIN
 LOOP
   IF NOT pg_try_advisory_lock(813272) THEN EXIT; END IF;
   PERFORM pg_advisory_unlock(813272);
   PERFORM pg_sleep(0.02);
   attempts := attempts + 1;
   IF attempts > 50 THEN RAISE EXCEPTION 'writer did not acquire lock'; END IF;
 END LOOP;
 SELECT id INTO before_id FROM logistica.sales_order_audit_commercial_verifications WHERE is_current;
 BEGIN PERFORM logistica.test_verify('{"version":2}', repeat('e',64)); RAISE EXCEPTION 'concurrent stale accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_COMMERCIAL_ACCEPTED_VERSION_STALE' THEN RAISE; END IF; END;
 IF NOT EXISTS (SELECT 1 FROM logistica.sales_order_audit_commercial_verifications WHERE id = before_id AND is_current) THEN RAISE EXCEPTION 'concurrent stale invalidated current'; END IF;
END $$;
SELECT dblink_disconnect('writer');
