-- One-shot QA purge. This migration is intentionally not reusable by the app.
-- Targeted only by the current settlement UUID, never by settlement_number.
BEGIN;

CREATE TEMP TABLE qa_rr_purge_snapshot (payload jsonb) ON COMMIT DROP;

DO $$
DECLARE
    v_settlement_id uuid := 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
    v_guide_id uuid := '24a8be95-f0b3-4dc9-a2b2-c5fd78d35592';
    v_company_id uuid := 'd1000000-0000-0000-0000-000000000001';
BEGIN
    IF (SELECT count(*) FROM adquisiciones.route_settlements
        WHERE id = v_settlement_id
          AND company_id = v_company_id
          AND route_guide_id = v_guide_id
          AND settlement_number = 'RR-2026-000001') <> 1 THEN
        RAISE EXCEPTION 'QA purge precondition failed: target settlement mismatch';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_settlements
        WHERE company_id = v_company_id
          AND settlement_year = 2026
          AND settlement_sequence > 1
    ) THEN
        RAISE EXCEPTION 'QA purge precondition failed: later settlement exists';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closure_items i
        WHERE i.route_settlement_id = v_settlement_id
           OR i.route_settlement_item_id IN (
               SELECT id FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id
           )
    ) OR EXISTS (
        SELECT 1
        FROM adquisiciones.route_fund_closure_expense_allocations a
        WHERE a.route_settlement_item_id IN (
            SELECT id FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id
        )
    ) THEN
        RAISE EXCEPTION 'QA purge precondition failed: fund closure dependency exists';
    END IF;
END $$;

INSERT INTO qa_rr_purge_snapshot (payload)
SELECT jsonb_build_object(
    'settlement_id', s.id,
    'guide_id', s.route_guide_id,
    'company_id', s.company_id,
    'settlement_number', s.settlement_number,
    'items', COALESCE((
        SELECT jsonb_agg(to_jsonb(i) ORDER BY i.created_at, i.id)
        FROM adquisiciones.route_settlement_items i
        WHERE i.settlement_id = s.id
    ), '[]'::jsonb),
    'payments', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id)
        FROM adquisiciones.route_settlement_payments p
        WHERE p.settlement_id = s.id
    ), '[]'::jsonb),
    'allocations', COALESCE((
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id)
        FROM adquisiciones.route_settlement_payment_allocations a
        WHERE a.settlement_id = s.id
    ), '[]'::jsonb),
    'expenses', COALESCE((
        SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at, e.id)
        FROM adquisiciones.route_fund_closure_expenses e
        WHERE e.route_settlement_id = s.id
    ), '[]'::jsonb),
    'expense_attachments', COALESCE((
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at, a.id)
        FROM adquisiciones.route_fund_closure_attachments a
        WHERE a.expense_id IN (
            SELECT e.id
            FROM adquisiciones.route_fund_closure_expenses e
            WHERE e.route_settlement_id = s.id
        )
    ), '[]'::jsonb),
    'storage_paths', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('bucket_id', o.bucket_id, 'name', o.name) ORDER BY o.name)
        FROM storage.objects o
        WHERE o.bucket_id = 'rendicion-rutas'
          AND o.name LIKE 'd1000000-0000-0000-0000-000000000001/rendicion-rutas/' || s.id::text || '/%'
    ), '[]'::jsonb),
    'audit_logs', COALESCE((
        SELECT jsonb_agg(to_jsonb(al) ORDER BY al.performed_at, al.id)
        FROM portal.audit_logs al
        WHERE al.record_id = s.id
           OR al.record_id IN (SELECT p.id FROM adquisiciones.route_settlement_payments p WHERE p.settlement_id = s.id)
    ), '[]'::jsonb),
    'reason', 'QA reset por corrección universo CASH/CHECK',
    'purge_migration', '20260826030000_purge_qa_rr_2026_000001',
    'purge_actor', 'supabase migration / controlled QA purge',
    'purge_started_at', now()
)
FROM adquisiciones.route_settlements s
WHERE s.id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';

-- These are the two protection triggers only. They are re-enabled before commit.
ALTER TABLE adquisiciones.route_settlement_payments
    DISABLE TRIGGER prevent_route_settlement_payment_delete;
ALTER TABLE adquisiciones.route_settlement_payment_allocations
    DISABLE TRIGGER prevent_route_settlement_payment_allocation_delete;

DELETE FROM portal.audit_logs
WHERE record_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe'
   OR record_id IN (
       SELECT id FROM adquisiciones.route_settlement_payments
       WHERE settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe'
   );

DELETE FROM adquisiciones.route_fund_closure_attachments
WHERE expense_id IN (
    SELECT id FROM adquisiciones.route_fund_closure_expenses
    WHERE route_settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe'
);
DELETE FROM adquisiciones.route_fund_closure_expense_allocations
WHERE expense_id IN (
    SELECT id FROM adquisiciones.route_fund_closure_expenses
    WHERE route_settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe'
);
DELETE FROM adquisiciones.route_fund_closure_expenses
WHERE route_settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
DELETE FROM adquisiciones.route_settlement_payment_allocations
WHERE settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
DELETE FROM adquisiciones.route_settlement_payments
WHERE settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
DELETE FROM adquisiciones.route_settlement_item_attachments
WHERE settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
DELETE FROM adquisiciones.route_settlement_items
WHERE settlement_id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';
DELETE FROM adquisiciones.route_settlements
WHERE id = 'b1a2a10c-93c5-4866-a845-dea3927a79fe';

DELETE FROM adquisiciones.route_settlement_counters
WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
  AND settlement_year = 2026;

ALTER TABLE adquisiciones.route_settlement_payments
    ENABLE TRIGGER prevent_route_settlement_payment_delete;
ALTER TABLE adquisiciones.route_settlement_payment_allocations
    ENABLE TRIGGER prevent_route_settlement_payment_allocation_delete;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'adquisiciones.route_settlement_payments'::regclass
          AND tgname = 'prevent_route_settlement_payment_delete'
          AND tgenabled <> 'O'
    ) OR EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'adquisiciones.route_settlement_payment_allocations'::regclass
          AND tgname = 'prevent_route_settlement_payment_allocation_delete'
          AND tgenabled <> 'O'
    ) THEN
        RAISE EXCEPTION 'QA purge failed: DELETE protection trigger was not re-enabled';
    END IF;
END $$;

-- Preserve auditable evidence without retaining the deleted settlement/payment
-- audit rows. Historical rows for other entities with the same number are untouched.
INSERT INTO portal.audit_logs (
    schema_name, module_code, table_name, record_id, action, new_data,
    performed_by, event_type, severity
)
SELECT
    'adquisiciones', 'ADQUISICIONES', 'route_settlements',
    'b1a2a10c-93c5-4866-a845-dea3927a79fe', 'QA_PURGE',
    payload, NULL, 'ROUTE_SETTLEMENT_QA_PURGED', 'INFO'
FROM qa_rr_purge_snapshot;

COMMIT;
