-- Both manual commercial drafts and traditional creation use this generator.
-- The transaction lock is held until the generated number has been inserted
-- and committed (or rolled back), and is scoped to the company.
CREATE OR REPLACE FUNCTION adquisiciones.generate_po_correlative(p_company_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, adquisiciones AS $$
DECLARE
  v_year text := to_char(CURRENT_DATE, 'YYYY');
  v_seq integer;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'La empresa es obligatoria para generar el correlativo';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('adquisiciones.po.correlative:' || p_company_id::text, 0));
  SELECT COALESCE(MAX(SUBSTRING(correlative FROM 'OC-' || v_year || '-(\d{6})')::integer), 0) + 1
    INTO v_seq
    FROM adquisiciones.purchase_orders
    WHERE company_id = p_company_id AND correlative LIKE 'OC-' || v_year || '-%';
  IF v_seq > 999999 THEN
    RAISE EXCEPTION 'Se agotaron los correlativos de órdenes de compra para el año %', v_year;
  END IF;
  RETURN 'OC-' || v_year || '-' || lpad(v_seq::text, 6, '0');
END;
$$;

-- Fail the migration if duplicates exist; never silently alter historical OCs.
ALTER TABLE adquisiciones.purchase_orders
  ADD CONSTRAINT purchase_orders_company_correlative_key UNIQUE (company_id, correlative);
