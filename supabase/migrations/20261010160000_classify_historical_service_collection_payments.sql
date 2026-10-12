-- Historical service collection/payment classification only.
-- The explicit movement IDs are intentional: no future classification rule is created.

INSERT INTO comercial.financial_categories (
    company_id,
    parent_id,
    code,
    name,
    direction,
    sort_order,
    affects_cash_flow,
    affects_pnl_directly,
    classification_group,
    semantic_type,
    cash_direction
)
SELECT
    company.id,
    parent.id,
    'EXPENSE_SERVICE_COLLECTION_PAYMENTS',
    'Recaudación y pago de servicios',
    'EXPENSE',
    28,
    true,
    true,
    'OPERATING',
    'EXPENSE_SERVICE_COLLECTION_PAYMENTS',
    'DEBIT'
FROM core.companies AS company
JOIN comercial.financial_categories AS parent
  ON parent.company_id = company.id
 AND parent.code = 'EXPENSE_OPERATING'
WHERE company.id = 'd1000000-0000-0000-0000-000000000001'
ON CONFLICT (company_id, code) DO UPDATE SET
    parent_id = excluded.parent_id,
    name = excluded.name,
    direction = excluded.direction,
    sort_order = excluded.sort_order,
    is_active = true,
    affects_cash_flow = excluded.affects_cash_flow,
    affects_pnl_directly = excluded.affects_pnl_directly,
    classification_group = excluded.classification_group,
    semantic_type = excluded.semantic_type,
    cash_direction = excluded.cash_direction;

CREATE OR REPLACE FUNCTION comercial.financial_expense_recognition_allowed_codes()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'EXPENSE_EXTERNAL_SERVICES',
    'EXPENSE_INSURANCE',
    'EXPENSE_TELECOM',
    'EXPENSE_REIMBURSEMENTS',
    'EXPENSE_SERVIPAG_SERVICES',
    'EXPENSE_SERVICE_COLLECTION_PAYMENTS'
  ]::text[];
$$;

UPDATE comercial.financial_bank_movements AS movement
SET category_id = target.id
FROM comercial.financial_categories AS source
JOIN comercial.financial_categories AS target
  ON target.company_id = source.company_id
 AND target.code = 'EXPENSE_SERVICE_COLLECTION_PAYMENTS'
WHERE movement.company_id = 'd1000000-0000-0000-0000-000000000001'
  AND movement.category_id = source.id
  AND source.code = 'EXPENSE_OPERATING_PENDING'
  AND movement.normalized_description = 'RECAUDACION Y PAGOS DE SERVICIOS'
  AND movement.id IN (
    '6985dcfa-fa79-4159-8bc7-38752b908f16',
    '8b548a18-c5c6-4f6b-92f7-c5869168963a',
    '36095c3d-49bf-432c-aacc-e58df4a2908a',
    '6a763529-8689-4c86-a6e7-f8483afb6efd',
    '11de139a-6107-4150-a89e-01275445e1b5',
    '567c924a-156e-4745-904b-b63c3ae694ed',
    '3eed2768-4e6e-4cb1-bd5c-caf99d6f8c28',
    '470f4e73-9a42-47a0-baa1-1a2b0395346a',
    'b1abb209-3e74-4d18-8a2d-a089177792db',
    'c946d391-2a7e-48bd-8e2c-b590d3a4b91a',
    'b1287fa4-3549-43e7-8728-ef75235a1183',
    'decc0ae4-8868-4a71-bf42-78f44d4c899c',
    '8aba2eaa-22de-44eb-83d0-09680fff3b64'
  );
