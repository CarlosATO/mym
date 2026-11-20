-- Cuentas por pagar: estructura independiente, inicialmente solo Caylo.
CREATE SCHEMA cuentas_por_pagar;
REVOKE ALL ON SCHEMA cuentas_por_pagar FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA cuentas_por_pagar TO authenticated, service_role;

CREATE TABLE cuentas_por_pagar.invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    supplier_id uuid NOT NULL REFERENCES adquisiciones.suppliers(id),
    issuer_rut text NOT NULL,
    document_type text NOT NULL,
    document_folio text NOT NULL,
    issue_date date NOT NULL,
    due_date date,
    net_amount numeric(18,2),
    tax_amount numeric(18,2),
    total_amount numeric(18,2),
    historical_initial_balance numeric(18,2),
    historical_balance_cutoff_date date,
    origin text NOT NULL CHECK (origin IN ('MANUAL', 'RECEIPT', 'HISTORICAL_IMPORT')),
    validation_status text NOT NULL DEFAULT 'PENDING' CHECK (validation_status IN ('PENDING', 'VALIDATED', 'REJECTED')),
    receipt_document_id uuid REFERENCES logistica.receipt_documents(id),
    purchase_order_document_id uuid REFERENCES adquisiciones.purchase_order_documents(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid NOT NULL REFERENCES portal.users(id),
    validated_at timestamptz,
    validated_by uuid REFERENCES portal.users(id),
    UNIQUE (id, company_id),
    UNIQUE (company_id, issuer_rut, document_type, document_folio),
    CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid),
    CHECK (issuer_rut ~ '^[0-9]{1,8}[0-9K]$'),
    CHECK (document_type ~ '^[A-Z0-9_]+$'),
    CHECK (document_folio ~ '^(0|[1-9][0-9]*)$'),
    CHECK (due_date IS NULL OR due_date >= issue_date),
    CHECK (net_amount IS NULL OR net_amount >= 0),
    CHECK (tax_amount IS NULL OR tax_amount >= 0),
    CHECK (total_amount IS NULL OR total_amount >= 0),
    CHECK ((historical_initial_balance IS NULL AND historical_balance_cutoff_date IS NULL)
        OR (historical_initial_balance IS NOT NULL AND historical_balance_cutoff_date IS NOT NULL
            AND historical_balance_cutoff_date >= issue_date AND total_amount IS NOT NULL
            AND historical_initial_balance >= 0 AND historical_initial_balance <= total_amount)),
    CHECK (validation_status <> 'VALIDATED' OR total_amount IS NOT NULL),
    CHECK ((validation_status = 'VALIDATED') = (validated_at IS NOT NULL AND validated_by IS NOT NULL)),
    CHECK (validation_status = 'VALIDATED' OR (validated_at IS NULL AND validated_by IS NULL))
);

CREATE TABLE cuentas_por_pagar.invoice_receipt_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    receipt_id uuid REFERENCES logistica.purchase_receipts(id),
    purchase_order_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    FOREIGN KEY (invoice_id, company_id) REFERENCES cuentas_por_pagar.invoices(id, company_id),
    FOREIGN KEY (purchase_order_id, company_id) REFERENCES adquisiciones.purchase_orders(id, company_id),
    CHECK (num_nonnulls(receipt_id, purchase_order_id) = 1)
);
CREATE UNIQUE INDEX invoice_receipt_links_receipt_uidx ON cuentas_por_pagar.invoice_receipt_links(invoice_id, receipt_id) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_receipt_links_po_uidx ON cuentas_por_pagar.invoice_receipt_links(invoice_id, purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX invoices_supplier_idx ON cuentas_por_pagar.invoices(company_id, supplier_id);

-- El acceso requiere usuario y rol activos y acceso explícito a Caylo.
CREATE FUNCTION cuentas_por_pagar.can_access(p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT p_company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
       AND core.has_company_access(auth.uid(), p_company_id)
       AND EXISTS (SELECT 1 FROM portal.users u JOIN portal.roles r ON r.id = u.role_id
                   WHERE u.id = auth.uid() AND u.is_active = true AND r.is_active = true
                     AND r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS'));
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.can_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cuentas_por_pagar.can_access(uuid) TO authenticated, service_role;

-- Normaliza identidad y conserva la autoría de la validación; cualquier cambio
-- posterior de datos devuelve la factura a pendiente para nueva revisión.
CREATE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger
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
           (NEW.company_id, NEW.supplier_id, NEW.issuer_rut, NEW.document_type, NEW.document_folio, NEW.issue_date, NEW.due_date, NEW.net_amount, NEW.tax_amount, NEW.total_amount, NEW.historical_initial_balance, NEW.historical_balance_cutoff_date, NEW.origin, NEW.receipt_document_id, NEW.purchase_order_document_id)
           IS DISTINCT FROM
           (OLD.company_id, OLD.supplier_id, OLD.issuer_rut, OLD.document_type, OLD.document_folio, OLD.issue_date, OLD.due_date, OLD.net_amount, OLD.tax_amount, OLD.total_amount, OLD.historical_initial_balance, OLD.historical_balance_cutoff_date, OLD.origin, OLD.receipt_document_id, OLD.purchase_order_document_id)
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
CREATE TRIGGER prepare_invoice BEFORE INSERT OR UPDATE ON cuentas_por_pagar.invoices FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prepare_invoice();

CREATE FUNCTION cuentas_por_pagar.prepare_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_invoice cuentas_por_pagar.invoices%ROWTYPE;
BEGIN
    -- Serializa la modificación de vínculos con la validación de la factura.
    SELECT * INTO v_invoice FROM cuentas_por_pagar.invoices WHERE id = NEW.invoice_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Factura incompatible' USING ERRCODE = '23503'; END IF;
    IF NEW.receipt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM logistica.purchase_receipts r JOIN adquisiciones.purchase_orders p ON p.id = r.purchase_order_id
        WHERE r.id = NEW.receipt_id AND r.company_id = NEW.company_id AND p.company_id = NEW.company_id AND p.supplier_id = v_invoice.supplier_id
    ) THEN RAISE EXCEPTION 'Recepción incompatible' USING ERRCODE = '23514'; END IF;
    IF NEW.receipt_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM logistica.purchase_receipts r
        WHERE r.id = NEW.receipt_id AND r.document_type = 'FA'
          AND (v_invoice.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') OR
               (btrim(r.document_number) ~ '^[0-9]+$' AND
                regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') <> v_invoice.document_folio))
    ) THEN RAISE EXCEPTION 'Identidad de factura incompatible con recepción' USING ERRCODE = '23514'; END IF;
    IF NEW.purchase_order_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM adquisiciones.purchase_orders p WHERE p.id = NEW.purchase_order_id AND p.company_id = NEW.company_id AND p.supplier_id = v_invoice.supplier_id
    ) THEN RAISE EXCEPTION 'OC incompatible' USING ERRCODE = '23514'; END IF;
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Se requiere un usuario autenticado para auditoría' USING ERRCODE = '42501'; END IF;
    NEW.created_by := auth.uid(); NEW.created_at := now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER prepare_link BEFORE INSERT ON cuentas_por_pagar.invoice_receipt_links FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.prepare_link();

-- La inserción es el único cambio permitido a vínculos. Registrar cada inserción
-- y toda transición de factura en el historial de auditoría transversal existente.
CREATE FUNCTION cuentas_por_pagar.audit_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    INSERT INTO portal.audit_logs (schema_name, module_code, table_name, record_id, action, old_data, new_data, performed_by, event_type)
    VALUES ('cuentas_por_pagar', 'CUENTAS_POR_PAGAR', TG_TABLE_NAME, NEW.id, TG_OP,
            CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
            to_jsonb(NEW), auth.uid(), TG_TABLE_NAME || '_' || TG_OP);
    RETURN NEW;
END;
$$;
CREATE TRIGGER audit_invoice AFTER INSERT OR UPDATE ON cuentas_por_pagar.invoices FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_change();
CREATE TRIGGER audit_link AFTER INSERT ON cuentas_por_pagar.invoice_receipt_links FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_change();

CREATE FUNCTION cuentas_por_pagar.invalidate_linked_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE cuentas_por_pagar.invoices SET validation_status = 'PENDING'
    WHERE id = NEW.invoice_id AND company_id = NEW.company_id AND validation_status = 'VALIDATED';
    RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_linked_invoice AFTER INSERT ON cuentas_por_pagar.invoice_receipt_links FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.invalidate_linked_invoice();
REVOKE ALL ON FUNCTION cuentas_por_pagar.prepare_invoice(), cuentas_por_pagar.prepare_link(), cuentas_por_pagar.audit_change(), cuentas_por_pagar.invalidate_linked_invoice() FROM PUBLIC, anon, authenticated;

ALTER TABLE cuentas_por_pagar.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuentas_por_pagar.invoice_receipt_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_read ON cuentas_por_pagar.invoices FOR SELECT TO authenticated USING (cuentas_por_pagar.can_access(company_id));
CREATE POLICY invoices_insert ON cuentas_por_pagar.invoices FOR INSERT TO authenticated WITH CHECK (cuentas_por_pagar.can_access(company_id));
CREATE POLICY invoices_update ON cuentas_por_pagar.invoices FOR UPDATE TO authenticated USING (cuentas_por_pagar.can_access(company_id)) WITH CHECK (cuentas_por_pagar.can_access(company_id));
CREATE POLICY links_read ON cuentas_por_pagar.invoice_receipt_links FOR SELECT TO authenticated USING (cuentas_por_pagar.can_access(company_id));
CREATE POLICY links_insert ON cuentas_por_pagar.invoice_receipt_links FOR INSERT TO authenticated WITH CHECK (cuentas_por_pagar.can_access(company_id));
REVOKE ALL ON ALL TABLES IN SCHEMA cuentas_por_pagar FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON cuentas_por_pagar.invoices TO authenticated;
GRANT SELECT, INSERT ON cuentas_por_pagar.invoice_receipt_links TO authenticated;
GRANT SELECT, INSERT, UPDATE ON cuentas_por_pagar.invoices TO service_role;
GRANT SELECT, INSERT ON cuentas_por_pagar.invoice_receipt_links TO service_role;
