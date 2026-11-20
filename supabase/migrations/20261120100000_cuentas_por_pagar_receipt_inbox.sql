-- Bandeja de facturas de recepción; los importes de recepción son solo referencia.
INSERT INTO portal.modules (code, name, description, icon, route, sort_order)
VALUES ('cuentas_por_pagar', 'Cuentas por Pagar', 'Facturas de proveedores', 'FileText', '/dashboard/cuentas-por-pagar', 10)
ON CONFLICT (code) DO NOTHING;
INSERT INTO portal.permissions (code, name, description, module_id)
SELECT 'module.cuentas_por_pagar.view', 'Ver Cuentas por Pagar', 'Consultar e incorporar facturas de proveedores', id
FROM portal.modules WHERE code = 'cuentas_por_pagar'
ON CONFLICT (code) DO NOTHING;
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS') AND p.code = 'module.cuentas_por_pagar.view'
ON CONFLICT DO NOTHING;

-- Solo devuelve recepciones completadas FA; no requiere documento adjunto.
CREATE FUNCTION public.cxp_receipt_candidates()
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
    WHERE r.company_id = 'd1000000-0000-0000-0000-000000000001'::uuid AND r.status = 'COMPLETED' AND r.document_type = 'FA'
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

CREATE FUNCTION public.cxp_incorporate_receipts(p_candidate_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c record; v_invoice uuid; v_count integer := 0; v_existing integer;
BEGIN
  IF NOT coalesce(cuentas_por_pagar.can_access('d1000000-0000-0000-0000-000000000001'::uuid), false) THEN
    RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
  END IF;
  IF p_candidate_ids IS NULL OR cardinality(p_candidate_ids) = 0 OR cardinality(p_candidate_ids) > 100
     OR array_position(p_candidate_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Seleccione entre 1 y 100 facturas';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_candidate_ids) x) <> cardinality(p_candidate_ids) THEN
    RAISE EXCEPTION 'Selección duplicada';
  END IF;
  FOR c IN SELECT * FROM public.cxp_receipt_candidates() WHERE candidate_id = ANY(p_candidate_ids) ORDER BY issuer_rut, folio, candidate_id LOOP
    v_count := v_count + 1;
    IF c.blocked_reason IS NOT NULL THEN RAISE EXCEPTION 'Factura no incorporable: %', c.blocked_reason; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('cxp:' || c.issuer_rut || ':' || c.folio, 0));
    SELECT count(*), (array_agg(i.id ORDER BY i.id))[1] INTO v_existing, v_invoice
    FROM cuentas_por_pagar.invoices i WHERE i.company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
      AND i.issuer_rut = c.issuer_rut AND i.document_folio = c.folio AND i.document_type IN ('FA','FACTURA','INVOICE','33','34');
    IF v_existing > 1 THEN RAISE EXCEPTION 'Identidad documental ambigua'; END IF;
    IF v_invoice IS NULL THEN
      INSERT INTO cuentas_por_pagar.invoices(company_id, supplier_id, issuer_rut, document_type, document_folio, issue_date, origin)
      VALUES ('d1000000-0000-0000-0000-000000000001', c.supplier_id, c.issuer_rut, 'FA', c.folio, c.issue_date, 'RECEIPT')
      ON CONFLICT (company_id, issuer_rut, document_type, document_folio) DO NOTHING RETURNING id INTO v_invoice;
      IF v_invoice IS NULL THEN
        SELECT id INTO v_invoice FROM cuentas_por_pagar.invoices WHERE company_id='d1000000-0000-0000-0000-000000000001'::uuid
          AND issuer_rut=c.issuer_rut AND document_type='FA' AND document_folio=c.folio;
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cuentas_por_pagar.invoices WHERE id=v_invoice AND supplier_id=c.supplier_id AND validation_status='PENDING') THEN
      RAISE EXCEPTION 'La factura existente no está disponible para incorporar';
    END IF;
    INSERT INTO cuentas_por_pagar.invoice_receipt_links(company_id, invoice_id, receipt_id)
    SELECT 'd1000000-0000-0000-0000-000000000001'::uuid, v_invoice, rid FROM unnest(c.receipt_ids) rid
    ON CONFLICT (invoice_id, receipt_id) WHERE receipt_id IS NOT NULL DO NOTHING;
  END LOOP;
  IF v_count <> cardinality(p_candidate_ids) THEN RAISE EXCEPTION 'La selección cambió; actualice la bandeja'; END IF;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.cxp_receipt_candidates(), public.cxp_incorporate_receipts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_receipt_candidates(), public.cxp_incorporate_receipts(uuid[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
