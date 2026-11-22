-- Respaldo de bandeja: consulta de solo lectura, también antes de incorporar.
CREATE FUNCTION cuentas_por_pagar.inbox_documents(p_candidate_id uuid, p_service_invoice_id uuid)
RETURNS TABLE (
    candidate_key text, id uuid, document_number text, file_name text,
    mime_type text, storage_bucket text, storage_path text, has_file boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;
    IF p_candidate_id IS NOT NULL AND p_service_invoice_id IS NOT NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT c.* FROM public.cxp_receipt_candidates() c
        WHERE p_service_invoice_id IS NULL
          AND (p_candidate_id IS NULL OR c.candidate_id = p_candidate_id)
    ), receipt_files AS (
        SELECT DISTINCT c.candidate_id::text AS candidate_key, d.id,
            d.document_number::text, d.file_name::text, d.mime_type::text,
            coalesce(d.storage_bucket, 'recepciones')::text AS storage_bucket, d.storage_path::text
        FROM candidates c
        JOIN logistica.purchase_receipts r ON r.company_id = v_company AND (
            (c.invoice_id IS NULL AND r.id = ANY(c.receipt_ids)) OR
            (c.invoice_id IS NOT NULL AND (
                EXISTS (SELECT 1 FROM cuentas_por_pagar.invoice_receipt_links l
                    WHERE l.invoice_id = c.invoice_id AND l.company_id = v_company AND l.receipt_id = r.id)
                OR EXISTS (SELECT 1 FROM cuentas_por_pagar.invoices direct_invoice
                    JOIN logistica.receipt_documents direct_doc ON direct_doc.id = direct_invoice.receipt_document_id
                        AND direct_doc.company_id = v_company AND direct_doc.receipt_id = r.id
                    WHERE direct_invoice.id = c.invoice_id AND direct_invoice.company_id = v_company)
            ))
        )
        JOIN adquisiciones.purchase_orders p ON p.id = r.purchase_order_id AND p.company_id = v_company AND p.supplier_id = c.supplier_id
        JOIN adquisiciones.suppliers s ON s.id = p.supplier_id AND (s.company_id IS NULL OR s.company_id = v_company)
        JOIN logistica.receipt_documents d ON d.receipt_id = r.id AND d.company_id = v_company AND d.document_type = 'FA'
        LEFT JOIN cuentas_por_pagar.invoices i ON i.id = c.invoice_id AND i.company_id = v_company
        WHERE r.status = 'COMPLETED' AND r.document_type = 'FA' AND r.receiving_type = 'WAREHOUSE'
          AND c.issuer_rut ~ '^[0-9]{7,8}[0-9K]$' AND c.folio IS NOT NULL
          AND upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) = c.issuer_rut
          AND btrim(r.document_number) ~ '^[0-9]+$'
          AND regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') = c.folio
          AND (nullif(btrim(d.document_number), '') IS NULL OR
               (btrim(d.document_number) ~ '^[0-9]+$' AND regexp_replace(btrim(d.document_number), '^0+([0-9])', '\1') = c.folio))
          AND (c.invoice_id IS NULL OR (
              i.id IS NOT NULL AND i.supplier_id = c.supplier_id AND i.issuer_rut = c.issuer_rut
              AND i.document_folio = c.folio AND i.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34')
              AND (d.id = i.receipt_document_id OR EXISTS (SELECT 1 FROM cuentas_por_pagar.invoice_receipt_links l
                  WHERE l.invoice_id = i.id AND l.company_id = v_company AND l.receipt_id = r.id))
          ))
    ), service_files AS (
        SELECT ('service:' || i.id::text) AS candidate_key, i.id,
            i.document_folio::text AS document_number, i.attachment_file_name::text AS file_name,
            i.attachment_mime_type::text AS mime_type, i.attachment_storage_bucket::text AS storage_bucket,
            i.attachment_storage_path::text AS storage_path
        FROM cuentas_por_pagar.invoices i
        JOIN adquisiciones.suppliers s ON s.id = i.supplier_id AND (s.company_id IS NULL OR s.company_id = v_company)
        WHERE p_candidate_id IS NULL AND (p_service_invoice_id IS NULL OR i.id = p_service_invoice_id)
          AND i.company_id = v_company AND i.purchase_type = 'SERVICES'
          AND i.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34')
          AND i.document_folio ~ '^[0-9]+$' AND i.issuer_rut ~ '^[0-9]{7,8}[0-9K]$'
          AND (nullif(btrim(i.attachment_storage_path), '') IS NOT NULL
               OR nullif(btrim(i.attachment_file_name), '') IS NOT NULL
               OR nullif(btrim(i.attachment_mime_type), '') IS NOT NULL)
    ), files AS (
        SELECT * FROM receipt_files UNION ALL SELECT * FROM service_files
    )
    SELECT f.candidate_key, f.id, f.document_number, f.file_name, f.mime_type, f.storage_bucket, f.storage_path,
        coalesce(
            f.storage_bucket = CASE WHEN f.candidate_key LIKE 'service:%' THEN 'cuentas-por-pagar' ELSE 'recepciones' END
            AND f.storage_path LIKE v_company::text || '/%'
            AND position('..' IN f.storage_path) = 0 AND position('//' IN f.storage_path) = 0
            AND (f.mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') OR
                (nullif(f.mime_type, '') IS NULL AND lower(coalesce(nullif(f.file_name, ''), f.storage_path)) ~ '\.(pdf|jpe?g|png|webp)$'))
            AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = f.storage_bucket AND o.name = f.storage_path), false)
    FROM files f
    ORDER BY 1, 2;
END;
$$;

-- La consulta masiva solo revela disponibilidad agregada, nunca rutas ni nombres.
CREATE FUNCTION public.cxp_inbox_document_status()
RETURNS TABLE (candidate_key text, has_file boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT f.candidate_key, bool_or(f.has_file)
    FROM cuentas_por_pagar.inbox_documents(NULL, NULL) f GROUP BY f.candidate_key ORDER BY f.candidate_key;
$$;

-- El listado requiere una única identidad y no expone rutas de almacenamiento.
CREATE FUNCTION public.cxp_inbox_documents(p_candidate_id uuid, p_service_invoice_id uuid)
RETURNS TABLE (id uuid, document_number text, file_name text, mime_type text, has_file boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT f.id, f.document_number, f.file_name, f.mime_type, f.has_file
    FROM cuentas_por_pagar.inbox_documents(p_candidate_id, p_service_invoice_id) f
    WHERE (p_candidate_id IS NULL) <> (p_service_invoice_id IS NULL);
$$;

-- Se revela la ruta solo para el documento solicitado y si sigue vinculado y disponible.
CREATE FUNCTION public.cxp_inbox_document_storage(p_candidate_id uuid, p_service_invoice_id uuid, p_document_id uuid)
RETURNS TABLE (id uuid, file_name text, mime_type text, storage_bucket text, storage_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT f.id, f.file_name, f.mime_type, f.storage_bucket, f.storage_path
    FROM cuentas_por_pagar.inbox_documents(p_candidate_id, p_service_invoice_id) f
    WHERE (p_candidate_id IS NULL) <> (p_service_invoice_id IS NULL)
      AND f.id = p_document_id AND f.has_file;
$$;

REVOKE ALL ON FUNCTION cuentas_por_pagar.inbox_documents(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cxp_inbox_document_status(), public.cxp_inbox_documents(uuid, uuid),
    public.cxp_inbox_document_storage(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_inbox_document_status(), public.cxp_inbox_documents(uuid, uuid),
    public.cxp_inbox_document_storage(uuid, uuid, uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
