-- Política de DELETE para que el usuario pueda reemplazar su reporte (solo el suyo)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'adquisiciones'
      AND tablename = 'sales_analysis_reports'
      AND policyname = 'Users can delete their own sales reports'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Users can delete their own sales reports"
        ON adquisiciones.sales_analysis_reports
        FOR DELETE
        USING (core.has_company_access(auth.uid(), company_id));
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'adquisiciones'
      AND tablename = 'sales_analysis_items'
      AND policyname = 'Users can delete sales report items in their companies'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "Users can delete sales report items in their companies"
        ON adquisiciones.sales_analysis_items
        FOR DELETE
        USING (
            EXISTS (
                SELECT 1 FROM adquisiciones.sales_analysis_reports r
                WHERE r.id = report_id AND core.has_company_access(auth.uid(), r.company_id)
            )
        );
    $policy$;
  END IF;
END $$;