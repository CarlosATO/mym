-- Run only against an empty, disposable PostgreSQL instance.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA core; CREATE SCHEMA logistica; CREATE SCHEMA integraciones; CREATE SCHEMA portal;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION core.has_company_access(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION core.has_permission_for_company(uuid,uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION portal.is_super_usuario(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.superuser', true), '') = 'true' $$;
CREATE TABLE logistica.sales_order_audits(id uuid, company_id uuid, card_id uuid, status text, locked_by_user_id uuid, prepared_by_user_id_snapshot uuid, assigned_auditor_user_id uuid, package_count integer, completed_at timestamptz, locked_at timestamptz, updated_at timestamptz);
CREATE TABLE logistica.sales_order_preparation_cards(id uuid, company_id uuid, status text, canonical_bsale_token text, current_bsale_nv_id bigint, last_moved_by uuid, last_moved_at timestamptz, updated_at timestamptz);
CREATE TABLE logistica.sales_order_audit_commercial_verifications(id uuid, company_id uuid, card_id uuid, audit_id uuid, is_current boolean, verified_at timestamptz, status text, fingerprint text, snapshot jsonb, differences jsonb, current_bsale_nv_id bigint, canonical_bsale_token text);
CREATE TABLE logistica.sales_order_audit_lines(company_id uuid, audit_id uuid, line_status text);
CREATE TABLE logistica.sales_order_audit_incidents(id uuid, company_id uuid, audit_id uuid, status text, incident_type text);
CREATE FUNCTION logistica.audit_incident_has_required_evidence(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE TABLE logistica.sales_order_audit_attachments(company_id uuid, audit_id uuid, attachment_type text);
CREATE TABLE logistica.sales_order_preparation_movements(company_id uuid, card_id uuid, from_status text, to_status text, moved_by uuid, movement_source text, observation text, metadata jsonb);
CREATE TABLE portal.users(id uuid, nombre text, apellido text);
CREATE TABLE integraciones.vw_bsale_sales_order_documents_canonical(company_id uuid, canonical_bsale_token text, current_bsale_id bigint);
\ir ../supabase/migrations/20261110120000_logistica_finalize_audit_commercial_guard.sql

INSERT INTO logistica.sales_order_audits(id,company_id,card_id,status,locked_by_user_id,assigned_auditor_user_id,package_count)
VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','OPEN','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',1);
INSERT INTO logistica.sales_order_preparation_cards(id,company_id,status,canonical_bsale_token,current_bsale_nv_id)
VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','IN_AUDIT','token',123);
INSERT INTO integraciones.vw_bsale_sales_order_documents_canonical VALUES ('00000000-0000-0000-0000-000000000002','token',123);
INSERT INTO logistica.sales_order_audit_lines VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','CONFIRMED');

DO $$
DECLARE result jsonb; blocked boolean; scenario text;
BEGIN
  FOREACH scenario IN ARRAY ARRAY['missing','blocked','incidents','other_audit','invalidated','wrong_company','differences','pending_line','no_packages','open_incident','self_audit_denied','self_audit_superuser','valid'] LOOP
    DELETE FROM logistica.sales_order_audit_commercial_verifications;
    UPDATE logistica.sales_order_audits SET status='OPEN', locked_by_user_id='00000000-0000-0000-0000-000000000001', package_count=CASE WHEN scenario='no_packages' THEN 0 ELSE 1 END;
    UPDATE logistica.sales_order_audits SET prepared_by_user_id_snapshot=CASE WHEN scenario IN ('self_audit_denied','self_audit_superuser') THEN '00000000-0000-0000-0000-000000000001'::uuid ELSE NULL END;
    PERFORM set_config('test.superuser', CASE WHEN scenario='self_audit_superuser' THEN 'true' ELSE 'false' END, true);
    UPDATE logistica.sales_order_preparation_cards SET status='IN_AUDIT';
    UPDATE logistica.sales_order_audit_lines SET line_status=CASE WHEN scenario='pending_line' THEN 'PENDING' ELSE 'CONFIRMED' END;
    DELETE FROM logistica.sales_order_audit_incidents;
    IF scenario='open_incident' THEN INSERT INTO logistica.sales_order_audit_incidents(company_id,audit_id,status) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','OPEN'); END IF;
    IF scenario <> 'missing' THEN
      INSERT INTO logistica.sales_order_audit_commercial_verifications VALUES (
        '00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004',
        CASE WHEN scenario='other_audit' THEN '00000000-0000-0000-0000-000000000006'::uuid ELSE '00000000-0000-0000-0000-000000000003'::uuid END,
        scenario <> 'invalidated', now(), CASE WHEN scenario='blocked' THEN 'BLOCKED' WHEN scenario='incidents' THEN 'INCIDENTS' ELSE 'READY_TO_INVOICE' END,
        repeat('a',64), jsonb_build_object('identity',jsonb_build_object('companyId',CASE WHEN scenario='wrong_company' THEN 'other' ELSE '00000000-0000-0000-0000-000000000002' END),
          'cardId','00000000-0000-0000-0000-000000000004','auditId','00000000-0000-0000-0000-000000000003','status','READY_TO_INVOICE',
          'comparison',jsonb_build_object('status','READY_TO_INVOICE','differences','[]'::jsonb),
          'currentVersion',jsonb_build_object('physicalId',123,'identity',jsonb_build_object('canonicalToken','token','currentBsaleId',123))),
        CASE WHEN scenario='differences' THEN '[{}]'::jsonb ELSE '[]'::jsonb END,123,'token');
    END IF;
    blocked := false;
    BEGIN
      result := logistica.finalize_sales_order_audit('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003');
    EXCEPTION WHEN raise_exception THEN blocked := true;
    END;
    IF scenario IN ('valid','self_audit_superuser') THEN
      IF blocked OR result->>'audit_status' <> 'COMPLETED' THEN RAISE EXCEPTION 'valid scenario failed'; END IF;
    ELSIF NOT blocked THEN RAISE EXCEPTION 'scenario % unexpectedly passed', scenario;
    END IF;
    RAISE NOTICE 'passed: %', scenario;
  END LOOP;
END $$;
