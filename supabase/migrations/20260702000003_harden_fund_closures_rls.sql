-- MIGRATION: 20260702000003_harden_fund_closures_rls.sql
-- DESCRIPTION: Remove DELETE policies for fund closure tables to enforce logical deletion via status=CANCELLED

DROP POLICY IF EXISTS "Users can delete route_fund_closures if company access" ON adquisiciones.route_fund_closures;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_items if company access" ON adquisiciones.route_fund_closure_items;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_expenses if company access" ON adquisiciones.route_fund_closure_expenses;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_expense_allocations if comp" ON adquisiciones.route_fund_closure_expense_allocations;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_expense_allocations if company access" ON adquisiciones.route_fund_closure_expense_allocations;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_deposits if company access" ON adquisiciones.route_fund_closure_deposits;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_attachments if company acce" ON adquisiciones.route_fund_closure_attachments;
DROP POLICY IF EXISTS "Users can delete route_fund_closure_attachments if company access" ON adquisiciones.route_fund_closure_attachments;
