-- Cuentas por Pagar: depuración de elegibilidad en bandeja e incorporación.
-- Muestra y permite incorporar exclusivamente facturas FA de recepciones de productos
-- (bodega, OC activa no cancelada y con recepción total o parcial), conservando FA sin PDF adjunto.

CREATE OR REPLACE FUNCTION public.cxp_receipt_candidates()
RETURNS TABLE (
  candidate_id uuid, issuer_rut text, supplier_id uuid, supplier_name text,
  folio text, issue_date date, purchase_orders text[], receipt_ids uuid[],
  reference_amount numeric, has_document boolean, invoice_id uuid,
  invoice_status text, blocked_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT coalesce(cuentas_por_pagar.can_access('d1000000-0000-0000-0000-000000000001'::uuid), false) THEN
    RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT r.id, p.id po_id, p.correlative, s.id sid, s.business_name,
      upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) rut,
      CASE WHEN btrim(r.document_number) ~ '^[0-9]+$' THEN regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') END fol,
      r.document_date doc_date, r.receipt_total_gross amount,
      EXISTS (SELECT 1 FROM logistica.receipt_documents d
        WHERE d.receipt_id = r.id AND d.company_id = r.company_id AND d.document_type = 'FA'
          AND (nullif(btrim(d.document_number), '') IS NULL OR
               (btrim(d.document_number) ~ '^[0-9]+$' AND
                regexp_replace(btrim(d.document_number), '^0+([0-9])', '\1') = regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1')))
          AND (nullif(btrim(d.storage_path), '') IS NOT NULL OR nullif(btrim(d.file_url), '') IS NOT NULL)) has_file
    FROM logistica.purchase_receipts r
    JOIN adquisiciones.purchase_orders p ON p.id = r.purchase_order_id AND p.company_id = r.company_id
    JOIN adquisiciones.suppliers s ON s.id = p.supplier_id AND (s.company_id IS NULL OR s.company_id = r.company_id)
    WHERE r.company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
      AND r.status = 'COMPLETED'
      AND r.document_type = 'FA'
      AND nullif(btrim(r.document_number), '') IS NOT NULL
      AND r.receiving_type = 'WAREHOUSE'
      AND coalesce(p.is_active, true) = true
      AND coalesce(p.po_type, 'PRODUCTOS') <> 'SERVICIOS'
      AND p.status NOT IN ('CANCELADA', 'RECHAZADA', 'BORRADOR')
      AND p.receipt_status IN ('RECEPCION_TOTAL', 'RECEPCION_PARCIAL')
  ), grouped AS (
    SELECT (array_agg(b.id ORDER BY b.id))[1] cid, b.rut, b.fol,
      (array_agg(b.sid ORDER BY b.sid))[1] sid, min(b.business_name) supplier,
      min(b.doc_date) dt, count(DISTINCT b.sid) suppliers, count(DISTINCT b.doc_date) dates,
      count(*) FILTER (WHERE b.doc_date IS NULL) missing_dates,
      array_agg(DISTINCT b.correlative::text ORDER BY b.correlative::text) pos,
      array_agg(b.id ORDER BY b.id) receipts, sum(b.amount) amount,
      bool_or(b.has_file) has_file
    FROM base b
    GROUP BY b.rut, b.fol,
      CASE WHEN b.rut !~ '^[0-9]{7,8}[0-9K]$' OR b.fol IS NULL THEN b.id END
  )
  SELECT g.cid, nullif(g.rut,''), g.sid, g.supplier, g.fol, g.dt, g.pos, g.receipts,
    g.amount, g.has_file, inv.id, inv.validation_status,
    CASE WHEN g.rut !~ '^[0-9]{7,8}[0-9K]$' THEN 'Proveedor sin RUT válido'
         WHEN g.fol IS NULL THEN 'Folio ausente o no numérico'
         WHEN g.suppliers <> 1 THEN 'RUT asociado a distintos proveedores'
         WHEN g.dates <> 1 OR g.missing_dates > 0 THEN 'Fecha de emisión ausente o inconsistente'
         WHEN inv.matches > 1 THEN 'Existen facturas con identidades equivalentes'
         WHEN inv.id IS NOT NULL AND inv.supplier_id <> g.sid THEN 'La factura existente tiene otro proveedor'
         WHEN inv.id IS NOT NULL AND inv.validation_status <> 'PENDING' THEN 'La factura existente no está pendiente'
         ELSE NULL END
  FROM grouped g
  LEFT JOIN LATERAL (
    SELECT (array_agg(i.id ORDER BY i.id))[1] id,
           (array_agg(i.validation_status ORDER BY i.id))[1] validation_status,
           (array_agg(i.supplier_id ORDER BY i.id))[1] supplier_id, count(*) matches
    FROM cuentas_por_pagar.invoices i
    WHERE i.company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
      AND i.issuer_rut = g.rut AND i.document_folio = g.fol
      AND i.document_type IN ('FA','FACTURA','INVOICE','33','34')
  ) inv ON true
  ORDER BY g.dt DESC NULLS LAST, g.supplier, g.fol, g.cid;
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_receipt_candidates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_receipt_candidates() TO authenticated;
NOTIFY pgrst, 'reload schema';
