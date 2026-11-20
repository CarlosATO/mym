-- Cuentas por Pagar | Bloque 3: Validación de facturas incorporadas.

ALTER TABLE cuentas_por_pagar.invoices
    ADD COLUMN prior_payment_status text NOT NULL DEFAULT 'UNREVIEWED',
    ADD COLUMN discrepancy_status text NOT NULL DEFAULT 'NONE',
    ADD COLUMN discrepancy_resolution_note text;

ALTER TABLE cuentas_por_pagar.invoices
    ADD CONSTRAINT invoices_prior_payment_status_chk
        CHECK (prior_payment_status IN ('UNREVIEWED', 'NO_PRIOR_PAYMENTS', 'PARTIAL_PRIOR_PAYMENTS', 'FULLY_PAID_PRIOR')),
    ADD CONSTRAINT invoices_discrepancy_status_chk
        CHECK (discrepancy_status IN ('NONE', 'UNRESOLVED', 'RESOLVED')),
    ADD CONSTRAINT invoices_discrepancy_resolution_note_chk
        CHECK (discrepancy_status <> 'RESOLVED' OR length(btrim(coalesce(discrepancy_resolution_note, ''))) >= 10),
    ADD CONSTRAINT invoices_tax_breakdown_chk
        CHECK ((net_amount IS NULL AND tax_amount IS NULL)
            OR (net_amount IS NOT NULL AND tax_amount IS NOT NULL AND total_amount IS NOT NULL
                AND round(net_amount + tax_amount, 2) = round(total_amount, 2))),
    ADD CONSTRAINT invoices_prior_payment_balance_chk
        CHECK ((prior_payment_status IN ('UNREVIEWED', 'NO_PRIOR_PAYMENTS')
                AND historical_initial_balance IS NULL
                AND historical_balance_cutoff_date IS NULL)
            OR (prior_payment_status = 'PARTIAL_PRIOR_PAYMENTS'
                AND historical_initial_balance IS NOT NULL
                AND historical_balance_cutoff_date IS NOT NULL
                AND total_amount IS NOT NULL
                AND historical_initial_balance > 0
                AND historical_initial_balance < total_amount)
            OR (prior_payment_status = 'FULLY_PAID_PRIOR'
                AND historical_initial_balance = 0
                AND historical_balance_cutoff_date IS NOT NULL
                AND total_amount IS NOT NULL)),
    ADD CONSTRAINT invoices_validated_complete_chk
        CHECK (validation_status <> 'VALIDATED' OR (
            total_amount IS NOT NULL AND total_amount > 0
            AND due_date IS NOT NULL
            AND prior_payment_status <> 'UNREVIEWED'
            AND discrepancy_status <> 'UNRESOLVED'
        ));

CREATE OR REPLACE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_supplier_company uuid;
    v_supplier_rut text;
    v_doc_type text;
    v_doc_number text;
BEGIN
    NEW.issuer_rut := upper(regexp_replace(NEW.issuer_rut, '[.[:space:]-]', '', 'g'));
    NEW.document_type := upper(btrim(NEW.document_type));
    NEW.document_folio := regexp_replace(btrim(NEW.document_folio), '^0+([0-9])', '\1');
    SELECT company_id, upper(regexp_replace(coalesce(nullif(btrim(rut), ''), nullif(btrim(rut_normalized), '')), '[.[:space:]-]', '', 'g'))
    INTO v_supplier_company, v_supplier_rut FROM adquisiciones.suppliers WHERE id = NEW.supplier_id;
    IF NOT FOUND OR (v_supplier_company IS NOT NULL AND v_supplier_company <> NEW.company_id) THEN
        RAISE EXCEPTION 'Proveedor inexistente o de otra empresa' USING ERRCODE = '23514';
    END IF;
    -- RUT ausente o incompleto no permite verificar identidad, pero no impide la carga.
    IF v_supplier_rut ~ '^[0-9]{7,8}[0-9K]$' AND v_supplier_rut <> NEW.issuer_rut THEN
        RAISE EXCEPTION 'RUT emisor incompatible con el proveedor' USING ERRCODE = '23514';
    END IF;
    IF NEW.receipt_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM logistica.receipt_documents d JOIN logistica.purchase_receipts r ON r.id = d.receipt_id
        JOIN adquisiciones.purchase_orders p ON p.id = r.purchase_order_id
        WHERE d.id = NEW.receipt_document_id AND d.company_id = NEW.company_id AND r.company_id = NEW.company_id
          AND p.company_id = NEW.company_id AND p.supplier_id = NEW.supplier_id
    ) THEN RAISE EXCEPTION 'Documento de recepción incompatible' USING ERRCODE = '23514'; END IF;
    IF NEW.receipt_document_id IS NOT NULL THEN
        SELECT document_type, document_number INTO v_doc_type, v_doc_number
        FROM logistica.receipt_documents WHERE id = NEW.receipt_document_id;
        IF v_doc_type = 'FA' AND (
            NEW.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') OR
            (btrim(v_doc_number) ~ '^[0-9]+$' AND
             regexp_replace(btrim(v_doc_number), '^0+([0-9])', '\1') <> NEW.document_folio)
        ) THEN RAISE EXCEPTION 'Identidad de factura incompatible con documento de recepción' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW.purchase_order_document_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM adquisiciones.purchase_order_documents d JOIN adquisiciones.purchase_orders p ON p.id = d.po_id
        WHERE d.id = NEW.purchase_order_document_id AND d.company_id = NEW.company_id
          AND p.company_id = NEW.company_id AND p.supplier_id = NEW.supplier_id
    ) THEN RAISE EXCEPTION 'Documento de OC incompatible' USING ERRCODE = '23514'; END IF;
    IF NEW.purchase_order_document_id IS NOT NULL THEN
        SELECT document_type, document_number INTO v_doc_type, v_doc_number
        FROM adquisiciones.purchase_order_documents WHERE id = NEW.purchase_order_document_id;
        IF v_doc_type = 'INVOICE' AND (
            NEW.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') OR
            (btrim(v_doc_number) ~ '^[0-9]+$' AND
             regexp_replace(btrim(v_doc_number), '^0+([0-9])', '\1') <> NEW.document_folio)
        ) THEN RAISE EXCEPTION 'Identidad de factura incompatible con documento de OC' USING ERRCODE = '23514'; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
        SELECT 1 FROM cuentas_por_pagar.invoice_receipt_links l
        JOIN logistica.purchase_receipts r ON r.id = l.receipt_id
        WHERE l.invoice_id = NEW.id AND r.document_type = 'FA'
          AND (NEW.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') OR
               (btrim(r.document_number) ~ '^[0-9]+$' AND
                regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') <> NEW.document_folio))
    ) THEN RAISE EXCEPTION 'Identidad incompatible con recepción vinculada' USING ERRCODE = '23514'; END IF;
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Se requiere un usuario autenticado para auditoría' USING ERRCODE = '42501'; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.validation_status <> 'PENDING' THEN RAISE EXCEPTION 'Una factura nueva debe estar pendiente' USING ERRCODE = '23514'; END IF;
        NEW.created_at := now(); NEW.created_by := v_actor;
    ELSE
        NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by;
        IF (NEW.company_id, NEW.supplier_id) IS DISTINCT FROM (OLD.company_id, OLD.supplier_id)
           AND EXISTS (SELECT 1 FROM cuentas_por_pagar.invoice_receipt_links WHERE invoice_id = OLD.id) THEN
            RAISE EXCEPTION 'No se puede cambiar empresa o proveedor con vínculos existentes' USING ERRCODE = '23514';
        END IF;
        IF OLD.validation_status = 'VALIDATED' AND
           (NEW.company_id, NEW.supplier_id, NEW.issuer_rut, NEW.document_type, NEW.document_folio, NEW.issue_date, NEW.due_date, NEW.net_amount, NEW.tax_amount, NEW.total_amount, NEW.historical_initial_balance, NEW.historical_balance_cutoff_date, NEW.origin, NEW.receipt_document_id, NEW.purchase_order_document_id, NEW.prior_payment_status, NEW.discrepancy_status, NEW.discrepancy_resolution_note)
           IS DISTINCT FROM
           (OLD.company_id, OLD.supplier_id, OLD.issuer_rut, OLD.document_type, OLD.document_folio, OLD.issue_date, OLD.due_date, OLD.net_amount, OLD.tax_amount, OLD.total_amount, OLD.historical_initial_balance, OLD.historical_balance_cutoff_date, OLD.origin, OLD.receipt_document_id, OLD.purchase_order_document_id, OLD.prior_payment_status, OLD.discrepancy_status, OLD.discrepancy_resolution_note)
        THEN NEW.validation_status := 'PENDING'; END IF;
    END IF;
    NEW.updated_at := now(); NEW.updated_by := v_actor;
    IF NEW.validation_status = 'VALIDATED' THEN
        IF TG_OP = 'INSERT' OR OLD.validation_status <> 'VALIDATED' THEN
            NEW.validated_at := now(); NEW.validated_by := v_actor;
        ELSE NEW.validated_at := OLD.validated_at; NEW.validated_by := OLD.validated_by; END IF;
    ELSE NEW.validated_at := NULL; NEW.validated_by := NULL; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cuentas_por_pagar.invalidate_linked_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE cuentas_por_pagar.invoices
    SET validation_status = 'PENDING',
        discrepancy_status = CASE
            WHEN total_amount IS NULL THEN 'NONE'
            ELSE 'UNRESOLVED'
        END
    WHERE id = NEW.invoice_id
      AND company_id = NEW.company_id
      AND (validation_status = 'VALIDATED' OR discrepancy_status = 'RESOLVED');
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION cuentas_por_pagar.prepare_invoice(), cuentas_por_pagar.invalidate_linked_invoice() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cxp_invoice_summaries()
RETURNS TABLE (
    id uuid,
    validation_status text,
    issue_date date,
    due_date date,
    net_amount numeric,
    tax_amount numeric,
    total_amount numeric,
    prior_payment_status text,
    historical_initial_balance numeric,
    historical_balance_cutoff_date date,
    discrepancy_status text,
    validated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        i.id,
        i.validation_status,
        i.issue_date,
        i.due_date,
        i.net_amount,
        i.tax_amount,
        i.total_amount,
        i.prior_payment_status,
        i.historical_initial_balance,
        i.historical_balance_cutoff_date,
        i.discrepancy_status,
        i.validated_at
    FROM cuentas_por_pagar.invoices i
    WHERE i.company_id = v_company_id
    ORDER BY i.issue_date DESC, i.created_at DESC, i.id;
END;
$$;

CREATE FUNCTION public.cxp_invoice_detail(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_inv record;
    v_purchase_orders jsonb;
    v_receipts jsonb;
    v_documents jsonb;
    v_reference jsonb;
    v_unlinked_completed_count integer := 0;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_invoice_id IS NULL THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    SELECT
        i.*,
        s.business_name AS supplier_name,
        s.fantasy_name AS supplier_fantasy_name,
        coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), '')) AS supplier_rut,
        s.payment_terms AS supplier_payment_terms,
        s.credit_days AS supplier_credit_days,
        nullif(btrim(concat_ws(' ', u.nombre, u.apellido)), '') AS validated_by_name
    INTO v_inv
    FROM cuentas_por_pagar.invoices i
    JOIN adquisiciones.suppliers s ON s.id = i.supplier_id
    LEFT JOIN portal.users u ON u.id = i.validated_by
    WHERE i.id = p_invoice_id AND i.company_id = v_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    SELECT coalesce(jsonb_agg(po_row ORDER BY po_row.correlative), '[]'::jsonb)
    INTO v_purchase_orders
    FROM (
        SELECT DISTINCT ON (po.id)
            po.id,
            po.correlative,
            po.issue_date,
            po.status,
            po.receipt_status,
            po.payment_terms,
            po.grand_total
        FROM cuentas_por_pagar.invoice_receipt_links l
        LEFT JOIN logistica.purchase_receipts r
            ON r.id = l.receipt_id AND r.company_id = v_company_id
        JOIN adquisiciones.purchase_orders po
            ON po.id = coalesce(r.purchase_order_id, l.purchase_order_id)
           AND po.company_id = v_company_id
        WHERE l.invoice_id = v_inv.id AND l.company_id = v_company_id
        ORDER BY po.id, po.correlative
    ) po_row;

    WITH linked_receipts AS (
        SELECT DISTINCT ON (r.id)
            r.id,
            r.receipt_number,
            r.receiving_type,
            r.status,
            r.received_at,
            r.document_type,
            r.document_number,
            r.document_date,
            r.receipt_total_net,
            r.receipt_total_tax,
            r.receipt_total_gross,
            po.id AS purchase_order_id,
            po.correlative AS purchase_order_correlative
        FROM cuentas_por_pagar.invoice_receipt_links l
        JOIN logistica.purchase_receipts r
            ON r.id = l.receipt_id AND r.company_id = v_company_id
        JOIN adquisiciones.purchase_orders po
            ON po.id = r.purchase_order_id AND po.company_id = v_company_id
        WHERE l.invoice_id = v_inv.id AND l.company_id = v_company_id
        ORDER BY r.id
    ),
    receipt_docs AS (
        SELECT
            d.id,
            d.receipt_id,
            lr.receipt_number,
            d.document_number,
            d.file_name,
            d.mime_type,
            (nullif(btrim(d.storage_path), '') IS NOT NULL
             AND coalesce(d.storage_bucket, 'recepciones') = 'recepciones') AS has_file
        FROM linked_receipts lr
        JOIN logistica.receipt_documents d
            ON d.receipt_id = lr.id AND d.company_id = v_company_id
        WHERE d.document_type = 'FA'
          AND (nullif(btrim(d.document_number), '') IS NULL
               OR (btrim(d.document_number) ~ '^[0-9]+$'
                   AND regexp_replace(btrim(d.document_number), '^0+([0-9])', '\1') = v_inv.document_folio))
    )
    SELECT
        coalesce((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', lr.id,
                    'receipt_number', lr.receipt_number,
                    'receiving_type', lr.receiving_type,
                    'status', lr.status,
                    'received_at', lr.received_at,
                    'document_type', lr.document_type,
                    'document_number', lr.document_number,
                    'document_date', lr.document_date,
                    'receipt_total_net', lr.receipt_total_net,
                    'receipt_total_tax', lr.receipt_total_tax,
                    'receipt_total_gross', lr.receipt_total_gross,
                    'purchase_order_id', lr.purchase_order_id,
                    'purchase_order_correlative', lr.purchase_order_correlative,
                    'documents', coalesce((
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'id', rd.id,
                                'receipt_id', rd.receipt_id,
                                'receipt_number', rd.receipt_number,
                                'document_number', rd.document_number,
                                'file_name', rd.file_name,
                                'mime_type', rd.mime_type,
                                'has_file', rd.has_file
                            )
                            ORDER BY rd.has_file DESC, rd.id
                        )
                        FROM receipt_docs rd
                        WHERE rd.receipt_id = lr.id
                    ), '[]'::jsonb)
                )
                ORDER BY lr.document_date NULLS LAST, lr.received_at, lr.receipt_number
            )
            FROM linked_receipts lr
        ), '[]'::jsonb),
        coalesce((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', dd.id,
                    'receipt_id', dd.receipt_id,
                    'receipt_number', dd.receipt_number,
                    'document_number', dd.document_number,
                    'file_name', dd.file_name,
                    'mime_type', dd.mime_type,
                    'has_file', dd.has_file
                )
                ORDER BY dd.has_file DESC, dd.receipt_number, dd.id
            )
            FROM (
                SELECT DISTINCT ON (rd.id)
                    rd.id,
                    rd.receipt_id,
                    rd.receipt_number,
                    rd.document_number,
                    rd.file_name,
                    rd.mime_type,
                    rd.has_file
                FROM receipt_docs rd
                ORDER BY rd.id
            ) dd
        ), '[]'::jsonb)
    INTO v_receipts, v_documents;

    IF v_inv.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
        SELECT count(*)::integer
        INTO v_unlinked_completed_count
        FROM logistica.purchase_receipts r
        JOIN adquisiciones.purchase_orders p
            ON p.id = r.purchase_order_id AND p.company_id = r.company_id
        JOIN adquisiciones.suppliers s
            ON s.id = p.supplier_id AND (s.company_id IS NULL OR s.company_id = r.company_id)
        WHERE r.company_id = v_company_id
          AND r.status = 'COMPLETED'
          AND r.document_type = 'FA'
          AND upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) = v_inv.issuer_rut
          AND btrim(r.document_number) ~ '^[0-9]+$'
          AND regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') = v_inv.document_folio
          AND NOT EXISTS (
              SELECT 1
              FROM cuentas_por_pagar.invoice_receipt_links l
              WHERE l.invoice_id = v_inv.id
                AND l.company_id = v_company_id
                AND l.receipt_id = r.id
          );
    END IF;

    SELECT jsonb_build_object(
        'linked_receipts_count', count(*) FILTER (WHERE r.status = 'COMPLETED'),
        'cancelled_linked_receipts_count', count(*) FILTER (WHERE r.status <> 'COMPLETED'),
        'unlinked_completed_receipts_count', v_unlinked_completed_count,
        'reference_net_amount', coalesce(sum(r.receipt_total_net) FILTER (WHERE r.status = 'COMPLETED'), 0),
        'reference_tax_amount', coalesce(sum(r.receipt_total_tax) FILTER (WHERE r.status = 'COMPLETED'), 0),
        'reference_gross_amount', coalesce(sum(r.receipt_total_gross) FILTER (WHERE r.status = 'COMPLETED'), 0),
        'reference_gross_rounded', round(coalesce(sum(r.receipt_total_gross) FILTER (WHERE r.status = 'COMPLETED'), 0), 0),
        'receipt_document_dates', coalesce(
            array_agg(DISTINCT r.document_date ORDER BY r.document_date)
                FILTER (WHERE r.status = 'COMPLETED' AND r.document_date IS NOT NULL),
            ARRAY[]::date[]
        ),
        'missing_receipt_dates_count', count(*) FILTER (WHERE r.status = 'COMPLETED' AND r.document_date IS NULL)
    )
    INTO v_reference
    FROM cuentas_por_pagar.invoice_receipt_links l
    JOIN logistica.purchase_receipts r
        ON r.id = l.receipt_id AND r.company_id = v_company_id
    WHERE l.invoice_id = v_inv.id AND l.company_id = v_company_id;

    RETURN jsonb_build_object(
        'invoice', jsonb_build_object(
            'id', v_inv.id,
            'company_id', v_inv.company_id,
            'supplier_id', v_inv.supplier_id,
            'issuer_rut', v_inv.issuer_rut,
            'document_type', v_inv.document_type,
            'document_folio', v_inv.document_folio,
            'issue_date', v_inv.issue_date,
            'due_date', v_inv.due_date,
            'net_amount', v_inv.net_amount,
            'tax_amount', v_inv.tax_amount,
            'total_amount', v_inv.total_amount,
            'prior_payment_status', v_inv.prior_payment_status,
            'historical_initial_balance', v_inv.historical_initial_balance,
            'historical_balance_cutoff_date', v_inv.historical_balance_cutoff_date,
            'discrepancy_status', v_inv.discrepancy_status,
            'discrepancy_resolution_note', v_inv.discrepancy_resolution_note,
            'origin', v_inv.origin,
            'validation_status', v_inv.validation_status,
            'validated_at', v_inv.validated_at,
            'validated_by', v_inv.validated_by,
            'validated_by_name', v_inv.validated_by_name
        ),
        'supplier', jsonb_build_object(
            'id', v_inv.supplier_id,
            'business_name', v_inv.supplier_name,
            'fantasy_name', v_inv.supplier_fantasy_name,
            'rut', v_inv.supplier_rut,
            'payment_terms', v_inv.supplier_payment_terms,
            'credit_days', v_inv.supplier_credit_days
        ),
        'purchase_orders', v_purchase_orders,
        'receipts', v_receipts,
        'documents', v_documents,
        'reference', v_reference
    );
END;
$$;

CREATE FUNCTION public.cxp_receipt_document_for_invoice(p_invoice_id uuid, p_document_id uuid)
RETURNS TABLE (
    id uuid,
    document_number text,
    storage_bucket text,
    storage_path text,
    file_name text,
    mime_type text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_invoice_id IS NULL OR p_document_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        d.id,
        d.document_number::text,
        d.storage_bucket::text,
        d.storage_path::text,
        d.file_name::text,
        d.mime_type::text
    FROM cuentas_por_pagar.invoices i
    JOIN logistica.receipt_documents d
        ON d.id = p_document_id AND d.company_id = v_company_id
    WHERE i.id = p_invoice_id
      AND i.company_id = v_company_id
      AND d.document_type = 'FA'
      AND (
          d.id = i.receipt_document_id
          OR EXISTS (
              SELECT 1
              FROM cuentas_por_pagar.invoice_receipt_links l
              JOIN logistica.purchase_receipts r
                  ON r.id = l.receipt_id AND r.company_id = v_company_id
              WHERE l.invoice_id = i.id
                AND l.company_id = v_company_id
                AND l.receipt_id = d.receipt_id
                AND r.status = 'COMPLETED'
                AND (nullif(btrim(d.document_number), '') IS NULL
                     OR (btrim(d.document_number) ~ '^[0-9]+$'
                         AND regexp_replace(btrim(d.document_number), '^0+([0-9])', '\1') = i.document_folio))
          )
      );
END;
$$;

CREATE FUNCTION public.cxp_save_invoice_validation(
    p_invoice_id uuid,
    p_issue_date date,
    p_due_date date,
    p_net_amount numeric,
    p_tax_amount numeric,
    p_total_amount numeric,
    p_prior_payment_status text,
    p_historical_initial_balance numeric,
    p_historical_balance_cutoff_date date,
    p_resolve_discrepancy boolean DEFAULT false,
    p_discrepancy_resolution_note text DEFAULT NULL,
    p_confirm_validation boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_inv cuentas_por_pagar.invoices%ROWTYPE;
    v_updated cuentas_por_pagar.invoices%ROWTYPE;
    v_balance numeric(18,2);
    v_cutoff date;
    v_note text;
    v_completed_count integer := 0;
    v_non_completed_count integer := 0;
    v_unlinked_completed_count integer := 0;
    v_ref_gross_amount numeric := 0;
    v_ref_gross_rounded numeric := 0;
    v_distinct_dates integer := 0;
    v_missing_dates integer := 0;
    v_single_ref_date date;
    v_has_amount_discrepancy boolean := false;
    v_has_date_discrepancy boolean := false;
    v_has_any_discrepancy boolean := false;
    v_discrepancy_status text;
    v_target_status text;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_inv
    FROM cuentas_por_pagar.invoices
    WHERE id = p_invoice_id AND company_id = v_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001';
    END IF;

    IF v_inv.validation_status <> 'PENDING' THEN
        RAISE EXCEPTION 'Solo se pueden editar o validar facturas en estado PENDING' USING ERRCODE = 'P0001';
    END IF;

    IF p_issue_date IS NULL THEN
        RAISE EXCEPTION 'La fecha de emisión es obligatoria' USING ERRCODE = 'P0001';
    END IF;

    IF p_due_date IS NOT NULL AND p_due_date < p_issue_date THEN
        RAISE EXCEPTION 'La fecha de vencimiento no puede ser anterior a la emisión' USING ERRCODE = 'P0001';
    END IF;

    IF p_total_amount IS NOT NULL AND p_total_amount <= 0 THEN
        RAISE EXCEPTION 'El monto total real debe ser mayor a 0' USING ERRCODE = 'P0001';
    END IF;

    IF (p_net_amount IS NULL) <> (p_tax_amount IS NULL) THEN
        RAISE EXCEPTION 'Debe informar tanto el neto como el IVA, o dejar ambos vacíos' USING ERRCODE = 'P0001';
    END IF;

    IF p_net_amount IS NOT NULL AND p_tax_amount IS NOT NULL THEN
        IF p_net_amount < 0 OR p_tax_amount < 0 THEN
            RAISE EXCEPTION 'Neto e IVA no pueden ser negativos' USING ERRCODE = 'P0001';
        END IF;
        IF p_total_amount IS NULL OR round(p_net_amount + p_tax_amount, 2) <> round(p_total_amount, 2) THEN
            RAISE EXCEPTION 'La suma de neto más IVA debe coincidir con el monto total real' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_prior_payment_status NOT IN ('UNREVIEWED', 'NO_PRIOR_PAYMENTS', 'PARTIAL_PRIOR_PAYMENTS', 'FULLY_PAID_PRIOR') THEN
        RAISE EXCEPTION 'Situación de pagos anteriores inválida' USING ERRCODE = 'P0001';
    END IF;

    IF p_prior_payment_status IN ('UNREVIEWED', 'NO_PRIOR_PAYMENTS') THEN
        IF p_historical_initial_balance IS NOT NULL OR p_historical_balance_cutoff_date IS NOT NULL THEN
            RAISE EXCEPTION 'No corresponde registrar saldo de apertura para la situación seleccionada' USING ERRCODE = 'P0001';
        END IF;
        v_balance := NULL;
        v_cutoff := NULL;
    ELSIF p_prior_payment_status = 'PARTIAL_PRIOR_PAYMENTS' THEN
        IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
            RAISE EXCEPTION 'Debe registrar el monto total real antes de definir un saldo inicial parcial' USING ERRCODE = 'P0001';
        END IF;
        IF p_historical_initial_balance IS NULL OR p_historical_initial_balance <= 0 OR p_historical_initial_balance >= p_total_amount THEN
            RAISE EXCEPTION 'El saldo de apertura parcial debe ser mayor a 0 y menor al monto total de la factura' USING ERRCODE = 'P0001';
        END IF;
        IF p_historical_balance_cutoff_date IS NULL OR p_historical_balance_cutoff_date < p_issue_date THEN
            RAISE EXCEPTION 'La fecha de corte del saldo inicial es obligatoria y no puede ser anterior a la emisión' USING ERRCODE = 'P0001';
        END IF;
        v_balance := round(p_historical_initial_balance, 2);
        v_cutoff := p_historical_balance_cutoff_date;
    ELSE
        -- FULLY_PAID_PRIOR
        IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
            RAISE EXCEPTION 'Debe registrar el monto total real antes de marcar la factura como pagada con anterioridad' USING ERRCODE = 'P0001';
        END IF;
        IF coalesce(p_historical_initial_balance, 0) <> 0 THEN
            RAISE EXCEPTION 'Una factura pagada totalmente con anterioridad debe tener saldo de apertura igual a 0' USING ERRCODE = 'P0001';
        END IF;
        IF p_historical_balance_cutoff_date IS NULL OR p_historical_balance_cutoff_date < p_issue_date THEN
            RAISE EXCEPTION 'La fecha de corte del saldo inicial es obligatoria y no puede ser anterior a la emisión' USING ERRCODE = 'P0001';
        END IF;
        v_balance := 0;
        v_cutoff := p_historical_balance_cutoff_date;
    END IF;

    SELECT
        count(*) FILTER (WHERE r.status = 'COMPLETED')::integer,
        count(*) FILTER (WHERE r.status <> 'COMPLETED')::integer,
        coalesce(sum(r.receipt_total_gross) FILTER (WHERE r.status = 'COMPLETED'), 0),
        round(coalesce(sum(r.receipt_total_gross) FILTER (WHERE r.status = 'COMPLETED'), 0), 0),
        count(DISTINCT r.document_date) FILTER (WHERE r.status = 'COMPLETED' AND r.document_date IS NOT NULL)::integer,
        count(*) FILTER (WHERE r.status = 'COMPLETED' AND r.document_date IS NULL)::integer,
        min(r.document_date) FILTER (WHERE r.status = 'COMPLETED')
    INTO
        v_completed_count,
        v_non_completed_count,
        v_ref_gross_amount,
        v_ref_gross_rounded,
        v_distinct_dates,
        v_missing_dates,
        v_single_ref_date
    FROM cuentas_por_pagar.invoice_receipt_links l
    JOIN logistica.purchase_receipts r
        ON r.id = l.receipt_id AND r.company_id = v_company_id
    WHERE l.invoice_id = v_inv.id AND l.company_id = v_company_id;

    IF v_inv.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
        SELECT count(*)::integer
        INTO v_unlinked_completed_count
        FROM logistica.purchase_receipts r
        JOIN adquisiciones.purchase_orders p
            ON p.id = r.purchase_order_id AND p.company_id = r.company_id
        JOIN adquisiciones.suppliers s
            ON s.id = p.supplier_id AND (s.company_id IS NULL OR s.company_id = r.company_id)
        WHERE r.company_id = v_company_id
          AND r.status = 'COMPLETED'
          AND r.document_type = 'FA'
          AND upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) = v_inv.issuer_rut
          AND btrim(r.document_number) ~ '^[0-9]+$'
          AND regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') = v_inv.document_folio
          AND NOT EXISTS (
              SELECT 1
              FROM cuentas_por_pagar.invoice_receipt_links l
              WHERE l.invoice_id = v_inv.id
                AND l.company_id = v_company_id
                AND l.receipt_id = r.id
          );
    END IF;

    v_has_amount_discrepancy := (
        p_total_amount IS NOT NULL
        AND v_completed_count > 0
        AND round(p_total_amount, 2) <> v_ref_gross_rounded
    );
    v_has_date_discrepancy := (
        v_completed_count > 0
        AND (v_missing_dates > 0 OR v_distinct_dates <> 1 OR p_issue_date IS DISTINCT FROM v_single_ref_date)
    );
    v_has_any_discrepancy := v_has_amount_discrepancy OR v_has_date_discrepancy;

    v_note := nullif(btrim(coalesce(p_discrepancy_resolution_note, '')), '');

    IF NOT v_has_any_discrepancy THEN
        v_discrepancy_status := 'NONE';
    ELSIF coalesce(p_resolve_discrepancy, false) THEN
        IF length(coalesce(v_note, '')) < 10 THEN
            RAISE EXCEPTION 'Para resolver una discrepancia debe ingresar una justificación de al menos 10 caracteres' USING ERRCODE = 'P0001';
        END IF;
        v_discrepancy_status := 'RESOLVED';
    ELSE
        v_discrepancy_status := 'UNRESOLVED';
    END IF;

    IF coalesce(p_confirm_validation, false) THEN
        IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
            RAISE EXCEPTION 'Debe ingresar el monto total real de la factura para validar' USING ERRCODE = 'P0001';
        END IF;
        IF p_due_date IS NULL THEN
            RAISE EXCEPTION 'La fecha de vencimiento es obligatoria para confirmar la validación' USING ERRCODE = 'P0001';
        END IF;
        IF p_prior_payment_status = 'UNREVIEWED' THEN
            RAISE EXCEPTION 'Debe revisar y registrar la situación de pagos anteriores antes de validar' USING ERRCODE = 'P0001';
        END IF;
        IF v_inv.origin = 'RECEIPT' THEN
            IF v_completed_count = 0 THEN
                RAISE EXCEPTION 'La factura no tiene recepciones completadas vinculadas' USING ERRCODE = 'P0001';
            END IF;
            IF v_non_completed_count > 0 THEN
                RAISE EXCEPTION 'Existen recepciones vinculadas anuladas o incompletas' USING ERRCODE = 'P0001';
            END IF;
            IF v_unlinked_completed_count > 0 THEN
                RAISE EXCEPTION 'Existen nuevas recepciones completadas para este folio que aún no están incorporadas' USING ERRCODE = 'P0001';
            END IF;
        END IF;
        IF v_discrepancy_status = 'UNRESOLVED' THEN
            RAISE EXCEPTION 'Existen diferencias sin resolver respecto a las recepciones vinculadas; la factura debe conservar estado PENDING' USING ERRCODE = 'P0001';
        END IF;
        v_target_status := 'VALIDATED';
    ELSE
        v_target_status := 'PENDING';
    END IF;

    UPDATE cuentas_por_pagar.invoices
    SET
        issue_date = p_issue_date,
        due_date = p_due_date,
        net_amount = CASE WHEN p_net_amount IS NOT NULL THEN round(p_net_amount, 2) ELSE NULL END,
        tax_amount = CASE WHEN p_tax_amount IS NOT NULL THEN round(p_tax_amount, 2) ELSE NULL END,
        total_amount = CASE WHEN p_total_amount IS NOT NULL THEN round(p_total_amount, 2) ELSE NULL END,
        prior_payment_status = p_prior_payment_status,
        historical_initial_balance = v_balance,
        historical_balance_cutoff_date = v_cutoff,
        discrepancy_status = v_discrepancy_status,
        discrepancy_resolution_note = v_note,
        validation_status = v_target_status
    WHERE id = v_inv.id AND company_id = v_company_id
    RETURNING * INTO v_updated;

    RETURN jsonb_build_object(
        'id', v_updated.id,
        'validation_status', v_updated.validation_status,
        'issue_date', v_updated.issue_date,
        'due_date', v_updated.due_date,
        'net_amount', v_updated.net_amount,
        'tax_amount', v_updated.tax_amount,
        'total_amount', v_updated.total_amount,
        'prior_payment_status', v_updated.prior_payment_status,
        'historical_initial_balance', v_updated.historical_initial_balance,
        'historical_balance_cutoff_date', v_updated.historical_balance_cutoff_date,
        'discrepancy_status', v_updated.discrepancy_status,
        'discrepancy_resolution_note', v_updated.discrepancy_resolution_note,
        'validated_at', v_updated.validated_at,
        'validated_by', v_updated.validated_by,
        'reference_gross_amount', v_ref_gross_amount,
        'reference_gross_rounded', v_ref_gross_rounded,
        'amount_difference', CASE WHEN v_updated.total_amount IS NOT NULL THEN round(v_updated.total_amount - v_ref_gross_rounded, 2) ELSE NULL END,
        'has_amount_discrepancy', v_has_amount_discrepancy,
        'has_date_discrepancy', v_has_date_discrepancy
    );
END;
$$;

REVOKE ALL ON FUNCTION
    public.cxp_invoice_summaries(),
    public.cxp_invoice_detail(uuid),
    public.cxp_receipt_document_for_invoice(uuid, uuid),
    public.cxp_save_invoice_validation(uuid, date, date, numeric, numeric, numeric, text, numeric, date, boolean, text, boolean)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.cxp_invoice_summaries(),
    public.cxp_invoice_detail(uuid),
    public.cxp_receipt_document_for_invoice(uuid, uuid),
    public.cxp_save_invoice_validation(uuid, date, date, numeric, numeric, numeric, text, numeric, date, boolean, text, boolean)
TO authenticated;

NOTIFY pgrst, 'reload schema';
