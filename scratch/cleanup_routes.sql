-- Limpieza Controlada de Producción (Guías y Rendiciones de Ruta)
-- Empresa objetivo: MYM (d1000000-0000-0000-0000-000000000001)

BEGIN;

-- 1. Eliminar hijos de Cierres de Fondos
DELETE FROM adquisiciones.route_fund_closure_attachments
WHERE fund_closure_id IN (
    SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

DELETE FROM adquisiciones.route_fund_closure_expense_allocations
WHERE expense_id IN (
    SELECT id FROM adquisiciones.route_fund_closure_expenses 
    WHERE fund_closure_id IN (
        SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
    )
);

DELETE FROM adquisiciones.route_fund_closure_expenses
WHERE fund_closure_id IN (
    SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

DELETE FROM adquisiciones.route_fund_closure_deposits
WHERE fund_closure_id IN (
    SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

DELETE FROM adquisiciones.route_fund_closure_items
WHERE fund_closure_id IN (
    SELECT id FROM adquisiciones.route_fund_closures WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

-- 2. Eliminar Cierres de Fondos
DELETE FROM adquisiciones.route_fund_closures
WHERE company_id = 'd1000000-0000-0000-0000-000000000001';

-- 3. Eliminar hijos de Rendiciones de Ruta
DELETE FROM adquisiciones.route_settlement_item_attachments
WHERE settlement_item_id IN (
    SELECT id FROM adquisiciones.route_settlement_items 
    WHERE settlement_id IN (
        SELECT id FROM adquisiciones.route_settlements WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
    )
);

DELETE FROM adquisiciones.route_settlement_items
WHERE settlement_id IN (
    SELECT id FROM adquisiciones.route_settlements WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

-- 4. Eliminar Rendiciones de Ruta
DELETE FROM adquisiciones.route_settlements
WHERE company_id = 'd1000000-0000-0000-0000-000000000001';

-- 5. Eliminar hijos de Guías de Ruta
DELETE FROM logistica.route_guide_items
WHERE route_guide_id IN (
    SELECT id FROM logistica.route_guides WHERE company_id = 'd1000000-0000-0000-0000-000000000001'
);

-- 6. Eliminar Guías de Ruta
DELETE FROM logistica.route_guides
WHERE company_id = 'd1000000-0000-0000-0000-000000000001';

-- 7. Resetear correlativos para 2026
UPDATE logistica.route_guide_counters
SET last_sequence = 0, updated_at = now()
WHERE company_id = 'd1000000-0000-0000-0000-000000000001' AND guide_year = 2026;

UPDATE adquisiciones.route_settlement_counters
SET last_sequence = 0, updated_at = now()
WHERE company_id = 'd1000000-0000-0000-0000-000000000001' AND settlement_year = 2026;

UPDATE adquisiciones.route_fund_closure_counters
SET last_sequence = 0, updated_at = now()
WHERE company_id = 'd1000000-0000-0000-0000-000000000001' AND closure_year = 2026;

COMMIT;
