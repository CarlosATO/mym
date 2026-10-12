-- Historical Caylo Servipag classification only.
-- The explicit movement IDs are intentional: this is not an automatic rule and
-- must never classify future Servipag operations automatically.

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
    'EXPENSE_SERVIPAG_SERVICES',
    'Servicios Servipag',
    'EXPENSE',
    27,
    true,
    true,
    'OPERATING',
    'EXPENSE_SERVIPAG_SERVICES',
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
    'EXPENSE_SERVIPAG_SERVICES'
  ]::text[];
$$;

UPDATE comercial.financial_bank_movements AS movement
SET category_id = target.id
FROM comercial.financial_categories AS source
JOIN comercial.financial_categories AS target
  ON target.company_id = source.company_id
 AND target.code = 'EXPENSE_SERVIPAG_SERVICES'
WHERE movement.company_id = 'd1000000-0000-0000-0000-000000000001'
  AND movement.category_id = source.id
  AND source.code = 'EXPENSE_OPERATING_PENDING'
  AND movement.normalized_description = 'PAGO EN SERVIPAG COM'
  AND movement.id IN (
    '673d5eb5-a16b-4f1c-abd5-dc3f4cf4ef8b',
    '1caceda4-c025-48e1-9974-b96ac5b89c37',
    'a17f1394-d086-4f3e-9e2c-0fabac205fe4',
    'd6be73fb-2940-47a8-9ea9-f617bbcb5ab4',
    'e031a56b-c34d-4848-bfa0-51e73b5246d0',
    'bed1f2cf-0c61-4ea7-916b-a81984002ee8',
    '002ae0b2-9bcd-4eec-b834-0af6c86864ac',
    'd948643d-ccac-408e-81f5-21feaaea688e',
    '71ab9fa6-b5ed-40a8-8287-e4376e8615d7',
    '81df7877-572b-46b2-9ab3-90a774643425',
    'b103271a-9d56-42cc-b783-f544464d5147',
    'e84d5ca1-72b5-495a-a5c1-8d8a6c2d928f',
    'd313afa2-eb89-4b0c-925d-8c24d38deac8',
    'b9bdd4c2-ed37-49cf-bb3a-2759d9e53814',
    'e096301a-1ea9-4c7c-90e1-87cc7cc9243f',
    '24fb472e-414c-4770-b8f5-3a49935754bf',
    '50b30197-92fa-4926-a520-35f681be2f52',
    '6291dae1-56a6-445b-8322-b95dcc9fc096',
    '5ef225b6-0017-4bc4-bdfb-29e3f8032ad6',
    '359219cf-af05-48e6-977f-965921655428'
  );
