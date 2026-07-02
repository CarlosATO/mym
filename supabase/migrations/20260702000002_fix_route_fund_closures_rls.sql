-- MIGRATION: 20260702000002_fix_route_fund_closures_rls.sql
-- DESCRIPTION: Añade las políticas de INSERT, UPDATE y DELETE para las tablas del módulo de cierre de fondos.

-- route_fund_closures
CREATE POLICY "Users can insert route_fund_closures if company access" ON adquisiciones.route_fund_closures FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closures if company access" ON adquisiciones.route_fund_closures FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closures if company access" ON adquisiciones.route_fund_closures FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- route_fund_closure_items
CREATE POLICY "Users can insert route_fund_closure_items if company access" ON adquisiciones.route_fund_closure_items FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closure_items if company access" ON adquisiciones.route_fund_closure_items FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closure_items if company access" ON adquisiciones.route_fund_closure_items FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- route_fund_closure_expenses
CREATE POLICY "Users can insert route_fund_closure_expenses if company access" ON adquisiciones.route_fund_closure_expenses FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closure_expenses if company access" ON adquisiciones.route_fund_closure_expenses FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closure_expenses if company access" ON adquisiciones.route_fund_closure_expenses FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- route_fund_closure_expense_allocations
CREATE POLICY "Users can insert route_fund_closure_expense_allocations if company access" ON adquisiciones.route_fund_closure_expense_allocations FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closure_expense_allocations if company access" ON adquisiciones.route_fund_closure_expense_allocations FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closure_expense_allocations if company access" ON adquisiciones.route_fund_closure_expense_allocations FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- route_fund_closure_deposits
CREATE POLICY "Users can insert route_fund_closure_deposits if company access" ON adquisiciones.route_fund_closure_deposits FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closure_deposits if company access" ON adquisiciones.route_fund_closure_deposits FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closure_deposits if company access" ON adquisiciones.route_fund_closure_deposits FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- route_fund_closure_attachments
CREATE POLICY "Users can insert route_fund_closure_attachments if company access" ON adquisiciones.route_fund_closure_attachments FOR INSERT WITH CHECK (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can update route_fund_closure_attachments if company access" ON adquisiciones.route_fund_closure_attachments FOR UPDATE USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can delete route_fund_closure_attachments if company access" ON adquisiciones.route_fund_closure_attachments FOR DELETE USING (core.has_company_access(auth.uid(), company_id));

-- Storage Bucket Policies para 'rendicion-rutas' (si aplica para subir adjuntos)
-- Como la política del Storage bucket probablemente ya estaba creada antes, si el bucket no tiene RLS que nos bloquee el upload, o si requiere políticas:
-- Ya existe una política para rendicion-rutas si el sistema de rendición base funciona.
