-- Cuentas por Pagar | Ingreso de Servicios (sin OC ni recepción de Bodega).

ALTER TABLE cuentas_por_pagar.invoices
    ADD COLUMN purchase_type text NOT NULL DEFAULT 'PRODUCTS',
    ADD COLUMN service_description text,
    ADD COLUMN service_delivery_status text,
    ADD COLUMN attachment_storage_bucket text,
    ADD COLUMN attachment_storage_path text,
    ADD COLUMN attachment_file_name text,
    ADD COLUMN attachment_mime_type text;

ALTER TABLE cuentas_por_pagar.invoices
    ADD CONSTRAINT invoices_purchase_type_chk
        CHECK (purchase_type IN ('PRODUCTS', 'SERVICES')),
    ADD CONSTRAINT invoices_service_fields_chk
        CHECK ((purchase_type = 'PRODUCTS' AND service_delivery_status IS NULL)
            OR (purchase_type = 'SERVICES'
                AND service_delivery_status IN ('DELIVERED', 'PENDING')
                AND length(btrim(coalesce(service_description, ''))) >= 3
                AND attachment_storage_bucket = 'cuentas-por-pagar'
                AND nullif(btrim(attachment_storage_path), '') IS NOT NULL
                AND nullif(btrim(attachment_file_name), '') IS NOT NULL
                AND attachment_mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))),
    ADD CONSTRAINT invoices_attachment_fields_chk
        CHECK ((attachment_storage_path IS NULL
                AND attachment_storage_bucket IS NULL
                AND attachment_file_name IS NULL
                AND attachment_mime_type IS NULL)
            OR (nullif(btrim(attachment_storage_path), '') IS NOT NULL
                AND nullif(btrim(attachment_file_name), '') IS NOT NULL
                AND attachment_storage_bucket = 'cuentas-por-pagar'
                AND attachment_storage_path LIKE 'd1000000-0000-0000-0000-000000000001/%'
                AND attachment_storage_path NOT LIKE '%..%'
                AND attachment_storage_path NOT LIKE '%//%'
                AND attachment_mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')));

-- Bucket privado de respaldos directos de Cuentas por Pagar (solo en entornos con Storage).
DO $$
BEGIN
    IF to_regclass('storage.buckets') IS NOT NULL THEN
        INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        VALUES (
            'cuentas-por-pagar',
            'cuentas-por-pagar',
            false,
            20971520,
            ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
        )
        ON CONFLICT (id) DO UPDATE
        SET public = EXCLUDED.public,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
    END IF;

    IF to_regclass('storage.objects') IS NOT NULL THEN
        DROP POLICY IF EXISTS cxp_storage_select ON storage.objects;
        CREATE POLICY cxp_storage_select ON storage.objects
            FOR SELECT TO authenticated
            USING (
                bucket_id = 'cuentas-por-pagar'
                AND name LIKE 'd1000000-0000-0000-0000-000000000001/%'
                AND coalesce(cuentas_por_pagar.can_access('d1000000-0000-0000-0000-000000000001'::uuid), false)
            );

        DROP POLICY IF EXISTS cxp_storage_insert ON storage.objects;
        CREATE POLICY cxp_storage_insert ON storage.objects
            FOR INSERT TO authenticated
            WITH CHECK (
                bucket_id = 'cuentas-por-pagar'
                AND name LIKE 'd1000000-0000-0000-0000-000000000001/%'
                AND coalesce(cuentas_por_pagar.can_access('d1000000-0000-0000-0000-000000000001'::uuid), false)
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION cuentas_por_pagar.prepare_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_supplier_company uuid;
    v_supplier_rut text;
    v_doc_type text;
    v_doc_number text;
    v_storage_exists boolean;
BEGIN
    NEW.issuer_rut := upper(regexp_replace(NEW.issuer_rut, '[.[:space:]-]', '', 'g'));
    NEW.document_type := upper(btrim(NEW.document_type));
    NEW.document_folio := regexp_replace(btrim(NEW.document_folio), '^0+([0-9])', '\1');
    SELECT company_id, upper(regexp_replace(coalesce(nullif(btrim(rut), ''), nullif(btrim(rut_normalized), '')), '[.[:space:]-]', '', 'g'))
    INTO v_supplier_company, v_supplier_rut FROM adquisiciones.suppliers WHERE id = NEW.supplier_id;
    IF NOT FOUND OR (v_supplier_company IS NOT NULL AND v_supplier_company <> NEW.company_id) THEN
        RAISE EXCEPTION 'Proveedor inexistente o de otra empresa' USING ERRCODE = '23514';
    END IF;
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
    IF NEW.purchase_type = 'SERVICES' AND (TG_OP = 'INSERT' OR NEW.attachment_storage_path IS DISTINCT FROM OLD.attachment_storage_path) THEN
        IF nullif(btrim(coalesce(NEW.attachment_storage_path, '')), '') IS NULL THEN
            RAISE EXCEPTION 'Una factura de servicios requiere archivo de respaldo' USING ERRCODE = '23514';
        END IF;
        IF to_regclass('storage.objects') IS NULL THEN
            RAISE EXCEPTION 'Almacenamiento privado no disponible para validar respaldo' USING ERRCODE = '23514';
        END IF;
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''cuentas-por-pagar'' AND o.name = $1)'
            INTO v_storage_exists
            USING NEW.attachment_storage_path;
        IF NOT coalesce(v_storage_exists, false) THEN
            RAISE EXCEPTION 'El archivo de respaldo no existe en el almacenamiento privado' USING ERRCODE = '23514';
        END IF;
    END IF;
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
           (NEW.company_id, NEW.supplier_id, NEW.issuer_rut, NEW.document_type, NEW.document_folio, NEW.issue_date, NEW.due_date, NEW.net_amount, NEW.tax_amount, NEW.total_amount, NEW.historical_initial_balance, NEW.historical_balance_cutoff_date, NEW.origin, NEW.receipt_document_id, NEW.purchase_order_document_id, NEW.prior_payment_status, NEW.discrepancy_status, NEW.discrepancy_resolution_note, NEW.purchase_type, NEW.service_description, NEW.service_delivery_status, NEW.attachment_storage_bucket, NEW.attachment_storage_path, NEW.attachment_file_name, NEW.attachment_mime_type)
           IS DISTINCT FROM
           (OLD.company_id, OLD.supplier_id, OLD.issuer_rut, OLD.document_type, OLD.document_folio, OLD.issue_date, OLD.due_date, OLD.net_amount, OLD.tax_amount, OLD.total_amount, OLD.historical_initial_balance, OLD.historical_balance_cutoff_date, OLD.origin, OLD.receipt_document_id, OLD.purchase_order_document_id, OLD.prior_payment_status, OLD.discrepancy_status, OLD.discrepancy_resolution_note, OLD.purchase_type, OLD.service_description, OLD.service_delivery_status, OLD.attachment_storage_bucket, OLD.attachment_storage_path, OLD.attachment_file_name, OLD.attachment_mime_type)
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

REVOKE ALL ON FUNCTION cuentas_por_pagar.prepare_invoice() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cxp_service_suppliers()
RETURNS TABLE (
    id uuid,
    business_name text,
    fantasy_name text,
    rut text,
    payment_terms text,
    credit_days integer
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
        s.id,
        s.business_name::text,
        s.fantasy_name::text,
        coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''))::text,
        s.payment_terms::text,
        s.credit_days
    FROM adquisiciones.suppliers s
    WHERE (s.company_id IS NULL OR s.company_id = v_company_id)
      AND s.supplier_kind = 'REAL'
      AND coalesce(s.is_active, true) = true
      AND coalesce(s.status, 'ACTIVE') = 'ACTIVE'
    ORDER BY s.business_name;
END;
$$;

CREATE FUNCTION cuentas_por_pagar.is_valid_chilean_rut(p_normalized_rut text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
    v_body text;
    v_dv text;
    v_sum integer := 0;
    v_mul integer := 2;
    v_idx integer;
    v_rem integer;
    v_expected text;
BEGIN
    IF p_normalized_rut !~ '^[0-9]{7,8}[0-9K]$' THEN
        RETURN false;
    END IF;
    v_body := left(p_normalized_rut, length(p_normalized_rut) - 1);
    v_dv := right(p_normalized_rut, 1);
    FOR v_idx IN REVERSE length(v_body)..1 LOOP
        v_sum := v_sum + (substring(v_body FROM v_idx FOR 1))::integer * v_mul;
        v_mul := CASE WHEN v_mul = 7 THEN 2 ELSE v_mul + 1 END;
    END LOOP;
    v_rem := 11 - (v_sum % 11);
    v_expected := CASE
        WHEN v_rem = 11 THEN '0'
        WHEN v_rem = 10 THEN 'K'
        ELSE v_rem::text
    END;
    RETURN v_dv = v_expected;
END;
$$;

REVOKE ALL ON FUNCTION cuentas_por_pagar.is_valid_chilean_rut(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cxp_create_service_supplier(
    p_rut text,
    p_business_name text,
    p_contact_email text DEFAULT NULL,
    p_contact_phone text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_rut_normalized text;
    v_body text;
    v_dv text;
    v_rut_formatted text;
    v_business_name text;
    v_email text;
    v_phone text;
    v_existing_company uuid;
    v_inserted record;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    v_rut_normalized := upper(regexp_replace(coalesce(p_rut, ''), '[.[:space:]-]', '', 'g'));
    IF NOT cuentas_por_pagar.is_valid_chilean_rut(v_rut_normalized) THEN
        RAISE EXCEPTION 'El RUT ingresado no es un RUT chileno válido' USING ERRCODE = 'P0001';
    END IF;

    v_business_name := nullif(btrim(coalesce(p_business_name, '')), '');
    IF v_business_name IS NULL OR length(v_business_name) < 2 THEN
        RAISE EXCEPTION 'La razón social es obligatoria' USING ERRCODE = 'P0001';
    END IF;
    IF length(v_business_name) > 200 THEN
        RAISE EXCEPTION 'La razón social no puede superar los 200 caracteres' USING ERRCODE = 'P0001';
    END IF;

    v_email := nullif(btrim(coalesce(p_contact_email, '')), '');
    IF v_email IS NOT NULL AND v_email !~* '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
        RAISE EXCEPTION 'Correo electrónico inválido' USING ERRCODE = 'P0001';
    END IF;
    IF length(coalesce(v_email, '')) > 150 THEN
        RAISE EXCEPTION 'El correo electrónico es demasiado largo' USING ERRCODE = 'P0001';
    END IF;

    v_phone := nullif(btrim(coalesce(p_contact_phone, '')), '');
    IF length(coalesce(v_phone, '')) > 50 THEN
        RAISE EXCEPTION 'El teléfono no puede superar los 50 caracteres' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('cxp:supplier:' || v_rut_normalized, 0));

    SELECT s.company_id INTO v_existing_company
    FROM adquisiciones.suppliers s
    WHERE (s.company_id IS NULL OR s.company_id = v_company_id)
      AND (
          upper(regexp_replace(coalesce(s.rut_normalized, ''), '[.[:space:]-]', '', 'g')) = v_rut_normalized
          OR upper(regexp_replace(coalesce(s.rut, ''), '[.[:space:]-]', '', 'g')) = v_rut_normalized
      )
    LIMIT 1;

    IF FOUND THEN
        IF v_existing_company IS NULL THEN
            RAISE EXCEPTION 'Ya existe un proveedor global registrado con este RUT en el catálogo' USING ERRCODE = 'P0001';
        ELSE
            RAISE EXCEPTION 'Ya existe un proveedor registrado con este RUT en el catálogo maestro' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM adquisiciones.suppliers s
        WHERE (s.company_id IS NULL OR s.company_id = v_company_id)
          AND lower(btrim(s.business_name)) = lower(v_business_name)
    ) THEN
        RAISE EXCEPTION 'Ya existe un proveedor registrado con la razón social "%"', v_business_name USING ERRCODE = 'P0001';
    END IF;

    v_body := left(v_rut_normalized, length(v_rut_normalized) - 1);
    v_dv := right(v_rut_normalized, 1);
    v_rut_formatted := regexp_replace(v_body, '(\d)(?=(\d{3})+$)', '\1.', 'g') || '-' || v_dv;

    INSERT INTO adquisiciones.suppliers (
        company_id,
        rut,
        rut_normalized,
        business_name,
        contact_email,
        contact_phone,
        supplier_kind,
        source,
        status,
        is_active,
        credit_days,
        discount_percent,
        created_by,
        updated_by
    )
    VALUES (
        v_company_id,
        v_rut_formatted,
        v_rut_normalized,
        v_business_name,
        v_email,
        v_phone,
        'REAL',
        'MANUAL',
        'ACTIVE',
        true,
        0,
        0,
        v_actor,
        v_actor
    )
    RETURNING id, business_name, fantasy_name, rut, payment_terms, credit_days
    INTO v_inserted;

    RETURN jsonb_build_object(
        'id', v_inserted.id,
        'business_name', v_inserted.business_name,
        'fantasy_name', v_inserted.fantasy_name,
        'rut', v_inserted.rut,
        'payment_terms', v_inserted.payment_terms,
        'credit_days', v_inserted.credit_days
    );
END;
$$;

CREATE FUNCTION public.cxp_create_service_invoice(
    p_supplier_id uuid,
    p_document_folio text,
    p_service_description text,
    p_issue_date date,
    p_due_date date,
    p_net_amount numeric,
    p_tax_amount numeric,
    p_total_amount numeric,
    p_service_delivery_status text,
    p_attachment_storage_path text,
    p_attachment_file_name text,
    p_attachment_mime_type text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company_id constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_supplier record;
    v_rut text;
    v_folio text;
    v_description text;
    v_attach_path text;
    v_attach_bucket text;
    v_attach_name text;
    v_attach_mime text;
    v_storage_exists boolean;
    v_existing_receipt_type text;
    v_inserted cuentas_por_pagar.invoices%ROWTYPE;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company_id), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;

    IF p_supplier_id IS NULL THEN
        RAISE EXCEPTION 'Debe seleccionar un proveedor del catálogo' USING ERRCODE = 'P0001';
    END IF;

    SELECT
        s.id,
        s.company_id,
        s.business_name,
        upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) AS normalized_rut
    INTO v_supplier
    FROM adquisiciones.suppliers s
    WHERE s.id = p_supplier_id
      AND (s.company_id IS NULL OR s.company_id = v_company_id)
      AND s.supplier_kind = 'REAL'
      AND coalesce(s.is_active, true) = true
      AND coalesce(s.status, 'ACTIVE') = 'ACTIVE';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Proveedor inexistente o sin acceso para Caylo' USING ERRCODE = 'P0001';
    END IF;

    v_rut := v_supplier.normalized_rut;
    IF v_rut !~ '^[0-9]{7,8}[0-9K]$' THEN
        RAISE EXCEPTION 'El proveedor seleccionado no tiene un RUT válido registrado' USING ERRCODE = 'P0001';
    END IF;

    IF p_document_folio IS NULL OR btrim(p_document_folio) !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'El folio debe contener solo dígitos numéricos' USING ERRCODE = 'P0001';
    END IF;
    v_folio := regexp_replace(btrim(p_document_folio), '^0+([0-9])', '\1');

    v_description := nullif(btrim(coalesce(p_service_description, '')), '');
    IF length(coalesce(v_description, '')) < 3 THEN
        RAISE EXCEPTION 'La descripción del servicio es obligatoria (mínimo 3 caracteres)' USING ERRCODE = 'P0001';
    END IF;

    IF p_issue_date IS NULL THEN
        RAISE EXCEPTION 'La fecha de emisión es obligatoria' USING ERRCODE = 'P0001';
    END IF;
    IF p_due_date IS NULL THEN
        RAISE EXCEPTION 'La fecha de vencimiento es obligatoria' USING ERRCODE = 'P0001';
    END IF;
    IF p_due_date < p_issue_date THEN
        RAISE EXCEPTION 'La fecha de vencimiento no puede ser anterior a la emisión' USING ERRCODE = 'P0001';
    END IF;

    IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
        RAISE EXCEPTION 'El monto total debe ser mayor a 0' USING ERRCODE = 'P0001';
    END IF;
    IF p_net_amount IS NULL OR p_tax_amount IS NULL OR p_net_amount < 0 OR p_tax_amount < 0 THEN
        RAISE EXCEPTION 'Neto e IVA son obligatorios y no pueden ser negativos' USING ERRCODE = 'P0001';
    END IF;
    IF round(p_net_amount + p_tax_amount, 2) <> round(p_total_amount, 2) THEN
        RAISE EXCEPTION 'La suma de neto más IVA debe coincidir exactamente con el total' USING ERRCODE = 'P0001';
    END IF;

    IF p_service_delivery_status NOT IN ('DELIVERED', 'PENDING') THEN
        RAISE EXCEPTION 'Estado de prestación inválido' USING ERRCODE = 'P0001';
    END IF;

    v_attach_path := nullif(btrim(coalesce(p_attachment_storage_path, '')), '');
    IF v_attach_path IS NULL THEN
        RAISE EXCEPTION 'Debe adjuntar un PDF o imagen de respaldo para registrar la factura de servicio' USING ERRCODE = 'P0001';
    END IF;

    v_attach_mime := nullif(btrim(coalesce(p_attachment_mime_type, '')), '');
    v_attach_name := nullif(btrim(coalesce(p_attachment_file_name, '')), '');
    IF v_attach_name IS NULL THEN
        RAISE EXCEPTION 'El nombre del archivo de respaldo es obligatorio' USING ERRCODE = 'P0001';
    END IF;
    IF v_attach_path NOT LIKE 'd1000000-0000-0000-0000-000000000001/%'
       OR v_attach_path LIKE '%..%'
       OR v_attach_path LIKE '%//%' THEN
        RAISE EXCEPTION 'Ruta de adjunto inválida' USING ERRCODE = 'P0001';
    END IF;
    IF v_attach_mime IS NULL OR v_attach_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') THEN
        RAISE EXCEPTION 'Tipo de archivo adjunto no permitido' USING ERRCODE = 'P0001';
    END IF;

    IF to_regclass('storage.objects') IS NULL THEN
        RAISE EXCEPTION 'Almacenamiento privado no disponible para verificar el respaldo' USING ERRCODE = 'P0001';
    END IF;

    EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''cuentas-por-pagar'' AND o.name = $1)'
        INTO v_storage_exists
        USING v_attach_path;

    IF NOT coalesce(v_storage_exists, false) THEN
        RAISE EXCEPTION 'El archivo de respaldo no existe en el almacenamiento privado' USING ERRCODE = 'P0001';
    END IF;

    v_attach_bucket := 'cuentas-por-pagar';

    PERFORM pg_advisory_xact_lock(hashtextextended('cxp:' || v_rut || ':' || v_folio, 0));

    IF EXISTS (
        SELECT 1
        FROM cuentas_por_pagar.invoices i
        WHERE i.company_id = v_company_id
          AND i.issuer_rut = v_rut
          AND i.document_folio = v_folio
          AND i.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34')
    ) THEN
        RAISE EXCEPTION 'Ya existe una factura registrada en Cuentas por Pagar para este RUT y folio' USING ERRCODE = 'P0001';
    END IF;

    SELECT r.receiving_type INTO v_existing_receipt_type
    FROM logistica.purchase_receipts r
    JOIN adquisiciones.purchase_orders p
        ON p.id = r.purchase_order_id AND p.company_id = r.company_id
    JOIN adquisiciones.suppliers s
        ON s.id = p.supplier_id AND (s.company_id IS NULL OR s.company_id = r.company_id)
    WHERE r.company_id = v_company_id
      AND r.status = 'COMPLETED'
      AND r.document_type = 'FA'
      AND upper(regexp_replace(coalesce(nullif(btrim(s.rut), ''), nullif(btrim(s.rut_normalized), ''), ''), '[.[:space:]-]', '', 'g')) = v_rut
      AND btrim(r.document_number) ~ '^[0-9]+$'
      AND regexp_replace(btrim(r.document_number), '^0+([0-9])', '\1') = v_folio
    LIMIT 1;

    IF FOUND THEN
        IF v_existing_receipt_type = 'OFFICE' THEN
            RAISE EXCEPTION 'Esta factura ya fue registrada anteriormente como recepción de oficina para este RUT y folio' USING ERRCODE = 'P0001';
        ELSE
            RAISE EXCEPTION 'Esta factura ya existe en recepciones de Bodega para este RUT y folio' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO cuentas_por_pagar.invoices (
        company_id,
        supplier_id,
        issuer_rut,
        document_type,
        document_folio,
        issue_date,
        due_date,
        net_amount,
        tax_amount,
        total_amount,
        origin,
        validation_status,
        prior_payment_status,
        discrepancy_status,
        purchase_type,
        service_description,
        service_delivery_status,
        attachment_storage_bucket,
        attachment_storage_path,
        attachment_file_name,
        attachment_mime_type
    )
    VALUES (
        v_company_id,
        p_supplier_id,
        v_rut,
        'FA',
        v_folio,
        p_issue_date,
        p_due_date,
        round(p_net_amount, 2),
        round(p_tax_amount, 2),
        round(p_total_amount, 2),
        'MANUAL',
        'PENDING',
        'UNREVIEWED',
        'NONE',
        'SERVICES',
        v_description,
        p_service_delivery_status,
        v_attach_bucket,
        v_attach_path,
        v_attach_name,
        v_attach_mime
    )
    RETURNING * INTO v_inserted;

    RETURN jsonb_build_object(
        'id', v_inserted.id,
        'issuer_rut', v_inserted.issuer_rut,
        'supplier_id', v_inserted.supplier_id,
        'supplier_name', v_supplier.business_name,
        'document_folio', v_inserted.document_folio,
        'issue_date', v_inserted.issue_date,
        'due_date', v_inserted.due_date,
        'net_amount', v_inserted.net_amount,
        'tax_amount', v_inserted.tax_amount,
        'total_amount', v_inserted.total_amount,
        'purchase_type', v_inserted.purchase_type,
        'service_description', v_inserted.service_description,
        'service_delivery_status', v_inserted.service_delivery_status,
        'validation_status', v_inserted.validation_status,
        'has_document', v_inserted.attachment_storage_path IS NOT NULL
    );
END;
$$;

CREATE FUNCTION public.cxp_service_invoices()
RETURNS TABLE (
    id uuid,
    issuer_rut text,
    supplier_id uuid,
    supplier_name text,
    folio text,
    issue_date date,
    due_date date,
    net_amount numeric,
    tax_amount numeric,
    total_amount numeric,
    service_description text,
    service_delivery_status text,
    has_document boolean,
    validation_status text,
    prior_payment_status text,
    historical_initial_balance numeric,
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
        i.issuer_rut,
        i.supplier_id,
        s.business_name::text,
        i.document_folio,
        i.issue_date,
        i.due_date,
        i.net_amount,
        i.tax_amount,
        i.total_amount,
        i.service_description,
        i.service_delivery_status,
        (i.attachment_storage_path IS NOT NULL) AS has_document,
        i.validation_status,
        i.prior_payment_status,
        i.historical_initial_balance,
        i.discrepancy_status,
        i.validated_at
    FROM cuentas_por_pagar.invoices i
    JOIN adquisiciones.suppliers s ON s.id = i.supplier_id
    WHERE i.company_id = v_company_id
      AND i.purchase_type = 'SERVICES'
    ORDER BY i.issue_date DESC, i.created_at DESC, i.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cxp_invoice_detail(p_invoice_id uuid)
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

    IF v_inv.attachment_storage_path IS NOT NULL THEN
        v_documents := v_documents || jsonb_build_array(
            jsonb_build_object(
                'id', v_inv.id,
                'receipt_id', NULL,
                'receipt_number', 'Factura directa',
                'document_number', v_inv.document_folio,
                'file_name', v_inv.attachment_file_name,
                'mime_type', v_inv.attachment_mime_type,
                'has_file', true
            )
        );
    END IF;

    IF v_inv.origin = 'RECEIPT' AND v_inv.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
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
          AND r.receiving_type = 'WAREHOUSE'
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
            'purchase_type', v_inv.purchase_type,
            'service_description', v_inv.service_description,
            'service_delivery_status', v_inv.service_delivery_status,
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

CREATE OR REPLACE FUNCTION public.cxp_receipt_document_for_invoice(p_invoice_id uuid, p_document_id uuid)
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

    IF p_document_id = p_invoice_id THEN
        RETURN QUERY
        SELECT
            i.id,
            i.document_folio::text,
            i.attachment_storage_bucket::text,
            i.attachment_storage_path::text,
            i.attachment_file_name::text,
            i.attachment_mime_type::text
        FROM cuentas_por_pagar.invoices i
        WHERE i.id = p_invoice_id
          AND i.company_id = v_company_id
          AND i.attachment_storage_path IS NOT NULL;
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

REVOKE ALL ON FUNCTION
    public.cxp_service_suppliers(),
    public.cxp_create_service_supplier(text, text, text, text),
    public.cxp_create_service_invoice(uuid, text, text, date, date, numeric, numeric, numeric, text, text, text, text),
    public.cxp_service_invoices(),
    public.cxp_invoice_detail(uuid),
    public.cxp_receipt_document_for_invoice(uuid, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.cxp_service_suppliers(),
    public.cxp_create_service_supplier(text, text, text, text),
    public.cxp_create_service_invoice(uuid, text, text, date, date, numeric, numeric, numeric, text, text, text, text),
    public.cxp_service_invoices(),
    public.cxp_invoice_detail(uuid),
    public.cxp_receipt_document_for_invoice(uuid, uuid)
TO authenticated;

NOTIFY pgrst, 'reload schema';
