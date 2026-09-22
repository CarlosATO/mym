-- MERMAS: enforce the worker-account charge for every internal sale.

CREATE OR REPLACE FUNCTION mermas.create_internal_sale_worker_charge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, rrhh, mermas
AS $$
BEGIN
  INSERT INTO rrhh.worker_account_charges (
    company_id, employee_id, source_type, source_id, document_type,
    document_number, document_date, amount, status, metadata, created_by
  ) VALUES (
    NEW.company_id, NEW.employee_id, 'MERMA', NEW.id::text, 'VIT',
    NEW.sale_number, NEW.created_at, NEW.total_amount,
    CASE WHEN NEW.status = 'REVERSED' THEN 'REVERSED' ELSE 'ACTIVE' END,
    jsonb_build_object(
      'internal_sale_id', NEW.id,
      'sale_number', NEW.sale_number,
      'total', NEW.total_amount,
      'origin', 'MERMA'
    ),
    NEW.created_by
  )
  ON CONFLICT (company_id, source_type, source_id) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_internal_sale_worker_charge() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_mermas_internal_sales_worker_charge ON mermas.internal_sales;
CREATE TRIGGER trg_mermas_internal_sales_worker_charge
AFTER INSERT ON mermas.internal_sales
FOR EACH ROW
EXECUTE FUNCTION mermas.create_internal_sale_worker_charge();

INSERT INTO rrhh.worker_account_charges (
  company_id, employee_id, source_type, source_id, document_type,
  document_number, document_date, amount, status, metadata, created_at, created_by
)
SELECT
  s.company_id, s.employee_id, 'MERMA', s.id::text, 'VIT',
  s.sale_number, s.created_at, s.total_amount,
  CASE WHEN s.status = 'REVERSED' THEN 'REVERSED' ELSE 'ACTIVE' END,
  jsonb_build_object(
    'internal_sale_id', s.id,
    'sale_number', s.sale_number,
    'total', s.total_amount,
    'origin', 'MERMA'
  ),
  s.created_at, s.created_by
FROM mermas.internal_sales s
LEFT JOIN rrhh.worker_account_charges c
  ON c.company_id = s.company_id
  AND c.source_type = 'MERMA'
  AND c.source_id = s.id::text
WHERE c.id IS NULL
ON CONFLICT (company_id, source_type, source_id) DO NOTHING;
