\set ON_ERROR_STOP on
-- Ejecutar únicamente en una base PostgreSQL desechable y vacía.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA integraciones; CREATE SCHEMA logistica;
CREATE TABLE integraciones.bsale_documents (company_id uuid, bsale_id bigint, number int, document_type_id int, state int, total_amount numeric, raw_json jsonb);
CREATE TABLE integraciones.bsale_document_references (company_id uuid, bsale_document_id bigint, referenced_document_id bigint, referenced_document_number text, referenced_document_type_id bigint, referenced_document_type text, reference_code text);
CREATE TABLE integraciones.bsale_document_details (company_id uuid, bsale_document_id bigint, variant_id int, quantity numeric, net_amount numeric, total_amount numeric);
CREATE TABLE logistica.attempts (company_id uuid, bsale_invoice_id bigint, confirmed_at timestamptz, created_at timestamptz);
CREATE VIEW logistica.vw_sales_order_preparation_board WITH (security_invoker=true) AS
SELECT eligible.bsale_id FROM (VALUES ('00000000-0000-0000-0000-000000000001'::uuid)) c(company_id)
LEFT JOIN LATERAL (
 SELECT d.bsale_id FROM logistica.attempts a JOIN integraciones.bsale_documents d
 ON d.company_id = a.company_id AND d.bsale_id = a.bsale_invoice_id
 WHERE a.company_id = c.company_id ORDER BY a.confirmed_at DESC NULLS LAST, a.created_at DESC LIMIT 1
) eligible ON true WHERE eligible.bsale_id IS NOT NULL;
CREATE FUNCTION logistica.get_route_invoice_draft_rows(p_company_id uuid, p_ids bigint[]) RETURNS bigint
LANGUAGE plpgsql AS $$ DECLARE result bigint; BEGIN
 SELECT count(*) INTO result FROM integraciones.bsale_documents d WHERE d.company_id = p_company_id
 AND d.bsale_id = ANY(p_ids) AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'; RETURN result;
END $$;
CREATE FUNCTION logistica.get_route_invoice_selection_candidates(p_company_id uuid) RETURNS bigint
LANGUAGE plpgsql AS $$ DECLARE result bigint; BEGIN
 SELECT count(*) INTO result FROM integraciones.bsale_documents d WHERE d.company_id = p_company_id
 AND d.document_type_id = 5 AND coalesce(d.raw_json->>'cancellationStatus', '0') = '0'; RETURN result;
END $$;
\ir ../supabase/migrations/20261114120000_logistica_full_credit_note_route_eligibility.sql

INSERT INTO integraciones.bsale_documents VALUES
 ('00000000-0000-0000-0000-000000000001',92551,24758,5,0,5598,'{}'),
 ('00000000-0000-0000-0000-000000000001',93369,4456,2,0,5598,'{}'),
 ('00000000-0000-0000-0000-000000000001',92552,24759,5,0,5598,'{}');
INSERT INTO logistica.attempts VALUES ('00000000-0000-0000-0000-000000000001',92551,now(),now());
INSERT INTO integraciones.bsale_document_references VALUES ('00000000-0000-0000-0000-000000000001',93369,NULL,'24758',33,NULL,'1');
INSERT INTO integraciones.bsale_document_details VALUES
 ('00000000-0000-0000-0000-000000000001',92551,1,1,2000,2380),
 ('00000000-0000-0000-0000-000000000001',92551,2,1,2704,3218),
 ('00000000-0000-0000-0000-000000000001',93369,1,1,2000,2380),
 ('00000000-0000-0000-0000-000000000001',93369,2,1,2704,3218);
DO $$ DECLARE c uuid := '00000000-0000-0000-0000-000000000001'; BEGIN
 IF NOT logistica.invoice_fully_cancelled_by_credit_note(c,92551) THEN RAISE EXCEPTION 'full cancellation missed'; END IF;
 IF EXISTS (SELECT 1 FROM logistica.vw_sales_order_preparation_board) THEN RAISE EXCEPTION 'board still shows invoice'; END IF;
 IF logistica.get_route_invoice_draft_rows(c,ARRAY[92551,92552]::bigint[]) <> 1 OR logistica.get_route_invoice_selection_candidates(c) <> 1 THEN RAISE EXCEPTION 'selection incorrect'; END IF;
 INSERT INTO logistica.attempts VALUES (c,92552,now() - interval '1 day',now());
 IF (SELECT bsale_id FROM logistica.vw_sales_order_preparation_board) IS DISTINCT FROM 92552 THEN RAISE EXCEPTION 'valid alternative hidden'; END IF;
 DELETE FROM logistica.attempts WHERE bsale_invoice_id = 92552;
 UPDATE integraciones.bsale_document_details SET quantity = 0.5 WHERE bsale_document_id = 93369 AND variant_id = 1;
 IF logistica.invoice_fully_cancelled_by_credit_note(c,92551) THEN RAISE EXCEPTION 'partial excluded'; END IF;
 IF NOT EXISTS (SELECT 1 FROM logistica.vw_sales_order_preparation_board) THEN RAISE EXCEPTION 'partial hidden'; END IF;
 UPDATE integraciones.bsale_document_details SET quantity = 1 WHERE bsale_document_id = 93369 AND variant_id = 1;
 UPDATE integraciones.bsale_document_references SET reference_code = '3';
 IF logistica.invoice_fully_cancelled_by_credit_note(c,92551) THEN RAISE EXCEPTION 'price correction excluded'; END IF;
 UPDATE integraciones.bsale_document_references SET reference_code = '1';
 UPDATE integraciones.bsale_document_references SET referenced_document_id = 92552;
 IF logistica.invoice_fully_cancelled_by_credit_note(c,92551) OR logistica.invoice_fully_cancelled_by_credit_note(c,92552) THEN RAISE EXCEPTION 'conflicting reference excluded'; END IF;
 UPDATE integraciones.bsale_document_references SET referenced_document_id = NULL;
 INSERT INTO integraciones.bsale_documents VALUES (c,99999,24758,5,0,5598,'{}');
 IF logistica.invoice_fully_cancelled_by_credit_note(c,92551) THEN RAISE EXCEPTION 'ambiguous folio excluded'; END IF;
 DELETE FROM integraciones.bsale_documents WHERE bsale_id = 99999;
 UPDATE integraciones.bsale_documents SET state = 1 WHERE bsale_id = 93369;
 IF logistica.invoice_fully_cancelled_by_credit_note(c,92551) THEN RAISE EXCEPTION 'cancelled credit note excluded invoice'; END IF;
END $$;
