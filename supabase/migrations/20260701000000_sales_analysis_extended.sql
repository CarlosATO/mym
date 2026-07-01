-- MIGRATION: 20260701000000_sales_analysis_extended.sql
-- Extiende las tablas existentes de análisis de ventas con métricas analíticas en JSONB
-- IMPORTANTE: Solo modifica tablas del schema "adquisiciones" creadas en la migración anterior.
-- NO toca ningún otro proceso, tabla o schema del sistema.

-- Agregar columna JSONB de métricas a los items (para guardar alertas, cobertura, etc.)
ALTER TABLE adquisiciones.sales_analysis_items
  ADD COLUMN IF NOT EXISTS alert_type text DEFAULT 'Normal',
  ADD COLUMN IF NOT EXISTS priority text DEFAULT 'Normal',
  ADD COLUMN IF NOT EXISTS metrics jsonb;

-- Agregar columna JSONB de diagnóstico al reporte maestro
ALTER TABLE adquisiciones.sales_analysis_reports
  ADD COLUMN IF NOT EXISTS diagnostics jsonb;

-- Índice para búsqueda por alerta
CREATE INDEX IF NOT EXISTS idx_sales_analysis_items_alert
  ON adquisiciones.sales_analysis_items(alert_type);

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
END $$;
