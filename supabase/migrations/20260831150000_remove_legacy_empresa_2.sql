-- Retiro definitivo de la empresa legacy de pruebas "EMPRESA 2".
--
-- Las migraciones históricas que originalmente la sembraron se conservan
-- intactas. Esta migración garantiza que un rebuild completo termine sin
-- esa empresa ni sus datos técnicos asociados.

BEGIN;

DO $$
DECLARE
  v_company_id constant uuid := 'd2000000-0000-0000-0000-000000000002';
BEGIN
  -- Datos de integración legacy que no tienen ON DELETE CASCADE hacia companies.
  DELETE FROM integraciones.bsale_stock_current
  WHERE company_id = v_company_id;

  DELETE FROM integraciones.bsale_variants
  WHERE company_id = v_company_id;

  DELETE FROM integraciones.bsale_products
  WHERE company_id = v_company_id;

  DELETE FROM integraciones.bsale_product_types
  WHERE company_id = v_company_id;

  DELETE FROM integraciones.bsale_sync_runs
  WHERE company_id = v_company_id;

  -- Accesos heredados creados por la migración multiempresa original.
  DELETE FROM core.user_company_access
  WHERE company_id = v_company_id;

  -- Las relaciones con ON DELETE CASCADE se limpian al retirar la empresa.
  DELETE FROM core.companies
  WHERE id = v_company_id;

  IF EXISTS (
    SELECT 1
    FROM core.companies
    WHERE id = v_company_id
  ) THEN
    RAISE EXCEPTION 'LEGACY_COMPANY_CLEANUP_FAILED';
  END IF;
END
$$;

COMMIT;
