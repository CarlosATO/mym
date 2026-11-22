-- Vencimientos CxP: correcciones previas a incorporación y auditoría.
CREATE TABLE cuentas_por_pagar.pending_due_dates (
    company_id uuid NOT NULL,
    issuer_rut text NOT NULL,
    document_type text NOT NULL CHECK (document_type = 'FA'),
    document_folio text NOT NULL,
    supplier_id uuid NOT NULL,
    due_date date,
    updated_by uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, issuer_rut, document_type, document_folio),
    CHECK (company_id = 'd1000000-0000-0000-0000-000000000001'::uuid)
);

CREATE TABLE cuentas_por_pagar.due_date_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id uuid NOT NULL,
    issuer_rut text NOT NULL,
    document_type text NOT NULL,
    document_folio text NOT NULL,
    supplier_id uuid NOT NULL,
    invoice_id uuid,
    old_due_date date,
    new_due_date date,
    actor_id uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    transaction_id bigint NOT NULL DEFAULT txid_current(),
    allow_validated boolean NOT NULL DEFAULT false,
    authorization_used boolean NOT NULL DEFAULT false
);
REVOKE ALL ON cuentas_por_pagar.pending_due_dates, cuentas_por_pagar.due_date_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE cuentas_por_pagar.due_date_audit_id_seq FROM PUBLIC, anon, authenticated;

-- No se interpreta texto ambiguo: solo un número explícito, opcionalmente seguido de «días».
CREATE FUNCTION cuentas_por_pagar.explicit_credit_days(p_terms text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT CASE WHEN btrim(coalesce(p_terms, '')) ~* '^[0-9]{1,4}([[:space:]]+d[ií]as?)?$'
        THEN CASE WHEN substring(btrim(p_terms) FROM '^[0-9]+')::integer <= 3650
            THEN substring(btrim(p_terms) FROM '^[0-9]+')::integer END END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.explicit_credit_days(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.cxp_receipt_due_dates()
RETURNS TABLE (candidate_id uuid, invoice_id uuid, due_date date, suggested_due_date date, due_date_source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_company constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
BEGIN
    IF NOT coalesce(cuentas_por_pagar.can_access(v_company), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH candidates AS (SELECT * FROM public.cxp_receipt_candidates()),
    terms AS (
        SELECT c.candidate_id,
            count(DISTINCT p.id) FILTER (WHERE nullif(btrim(p.payment_terms), '') IS NOT NULL
                AND cuentas_por_pagar.explicit_credit_days(p.payment_terms) IS NULL) AS ambiguous,
            count(DISTINCT cuentas_por_pagar.explicit_credit_days(p.payment_terms)) AS explicit_count,
            min(cuentas_por_pagar.explicit_credit_days(p.payment_terms)) AS explicit_days
        FROM candidates c
        JOIN logistica.purchase_receipts r ON r.id = ANY(c.receipt_ids) AND r.company_id = v_company
        JOIN adquisiciones.purchase_orders p ON p.id = r.purchase_order_id AND p.company_id = v_company AND p.supplier_id = c.supplier_id
        GROUP BY c.candidate_id
    ), resolved AS (
        SELECT c.*, i.due_date AS invoice_due, d.due_date AS pending_due,
            d.company_id IS NOT NULL AS has_pending,
            CASE WHEN c.issue_date IS NULL OR (c.invoice_id IS NOT NULL AND i.id IS NULL)
                OR (c.invoice_id IS NULL AND c.blocked_reason IS NOT NULL) OR t.ambiguous > 0 OR t.explicit_count > 1 THEN NULL
                WHEN t.explicit_count = 1 THEN c.issue_date + t.explicit_days
                WHEN s.credit_days BETWEEN 1 AND 3650 THEN c.issue_date + s.credit_days
                ELSE NULL END AS suggested,
            CASE WHEN c.issue_date IS NULL OR (c.invoice_id IS NOT NULL AND i.id IS NULL)
                OR (c.invoice_id IS NULL AND c.blocked_reason IS NOT NULL) OR t.ambiguous > 0 OR t.explicit_count > 1 THEN NULL
                WHEN t.explicit_count = 1 THEN 'PURCHASE_ORDER'
                WHEN s.credit_days BETWEEN 1 AND 3650 THEN 'SUPPLIER' ELSE NULL END AS suggestion_source
        FROM candidates c
        LEFT JOIN terms t ON t.candidate_id = c.candidate_id
        LEFT JOIN adquisiciones.suppliers s ON s.id = c.supplier_id AND (s.company_id IS NULL OR s.company_id = v_company)
        LEFT JOIN cuentas_por_pagar.invoices i ON i.id = c.invoice_id AND i.company_id = v_company AND i.supplier_id = c.supplier_id
            AND i.issuer_rut = c.issuer_rut AND i.document_folio = c.folio
        LEFT JOIN cuentas_por_pagar.pending_due_dates d ON d.company_id = v_company AND d.issuer_rut = c.issuer_rut
            AND d.document_type = 'FA' AND d.document_folio = c.folio AND d.supplier_id = c.supplier_id
    )
    SELECT r.candidate_id, r.invoice_id,
        CASE WHEN r.invoice_id IS NOT NULL AND r.invoice_due IS NOT NULL THEN r.invoice_due
             WHEN r.has_pending THEN r.pending_due ELSE r.suggested END,
        r.suggested,
        CASE WHEN r.invoice_id IS NOT NULL AND r.invoice_due IS NOT NULL THEN 'SAVED'
             WHEN r.has_pending THEN 'MANUAL'
             ELSE r.suggestion_source END
    FROM resolved r ORDER BY r.candidate_id;
END;
$$;

-- La auditoría se crea antes del UPDATE y prueba la autorización de esa única modificación.
CREATE FUNCTION cuentas_por_pagar.is_audited_due_only(p_old cuentas_por_pagar.invoices, p_new cuentas_por_pagar.invoices)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF (to_jsonb(p_old) - 'due_date') IS DISTINCT FROM (to_jsonb(p_new) - 'due_date')
       OR p_old.due_date IS NOT DISTINCT FROM p_new.due_date THEN RETURN false; END IF;
    UPDATE cuentas_por_pagar.due_date_audit a SET authorization_used = true
    WHERE a.id = (SELECT b.id FROM cuentas_por_pagar.due_date_audit b
        WHERE b.invoice_id = p_old.id AND b.company_id = p_old.company_id
          AND b.actor_id = auth.uid() AND b.transaction_id = txid_current()
          AND b.allow_validated AND NOT b.authorization_used
          AND b.old_due_date IS NOT DISTINCT FROM p_old.due_date
          AND b.new_due_date IS NOT DISTINCT FROM p_new.due_date
        ORDER BY b.id DESC LIMIT 1);
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.is_audited_due_only(cuentas_por_pagar.invoices, cuentas_por_pagar.invoices) FROM PUBLIC, anon, authenticated;

-- Conserva todo el código original de prepare_invoice, salvo esta excepción estricta.
DO $$
DECLARE v_definition text; v_updated text; v_marker constant text := 'IF OLD.validation_status = ''VALIDATED'' AND';
BEGIN
    SELECT pg_get_functiondef('cuentas_por_pagar.prepare_invoice()'::regprocedure) INTO v_definition;
    IF (length(v_definition) - length(replace(v_definition, v_marker, ''))) / length(v_marker) <> 1 THEN
        RAISE EXCEPTION 'No se pudo localizar de forma inequívoca prepare_invoice';
    END IF;
    v_updated := replace(v_definition, v_marker,
        'IF OLD.validation_status = ''VALIDATED'' AND NOT cuentas_por_pagar.is_audited_due_only(OLD, NEW) AND');
    EXECUTE v_updated;
END;
$$;

-- Al crear la factura se aplica la corrección de identidad, también si su valor es NULL.
CREATE FUNCTION cuentas_por_pagar.apply_pending_due_date() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_due date;
BEGIN
    IF NEW.origin <> 'RECEIPT' OR NEW.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN RETURN NEW; END IF;
    SELECT d.due_date INTO v_due FROM cuentas_por_pagar.pending_due_dates d
    WHERE d.company_id = NEW.company_id AND d.issuer_rut = NEW.issuer_rut AND d.document_type = 'FA'
      AND d.document_folio = NEW.document_folio AND d.supplier_id = NEW.supplier_id;
    IF FOUND THEN NEW.due_date := v_due; END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.apply_pending_due_date() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER aaa_cxp_pending_due_date BEFORE INSERT ON cuentas_por_pagar.invoices
FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.apply_pending_due_date();

-- Mantiene coherentes las correcciones hechas por los flujos existentes de validación.
CREATE FUNCTION cuentas_por_pagar.audit_invoice_due_date() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_actor uuid := auth.uid();
BEGIN
    IF NEW.due_date IS NOT DISTINCT FROM OLD.due_date THEN RETURN NEW; END IF;
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Se requiere usuario para auditoría' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM cuentas_por_pagar.due_date_audit a
        WHERE a.invoice_id = OLD.id AND a.company_id = OLD.company_id AND a.actor_id = v_actor
          AND a.transaction_id = txid_current() AND a.old_due_date IS NOT DISTINCT FROM OLD.due_date
          AND a.new_due_date IS NOT DISTINCT FROM NEW.due_date) THEN
        INSERT INTO cuentas_por_pagar.due_date_audit(company_id, issuer_rut, document_type, document_folio, supplier_id, invoice_id, old_due_date, new_due_date, actor_id)
        VALUES (NEW.company_id, NEW.issuer_rut, NEW.document_type, NEW.document_folio, NEW.supplier_id, NEW.id, OLD.due_date, NEW.due_date, v_actor);
    END IF;
    IF NEW.origin = 'RECEIPT' AND NEW.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
        INSERT INTO cuentas_por_pagar.pending_due_dates(company_id, issuer_rut, document_type, document_folio, supplier_id, due_date, updated_by)
        VALUES (NEW.company_id, NEW.issuer_rut, 'FA', NEW.document_folio, NEW.supplier_id, NEW.due_date, v_actor)
        ON CONFLICT (company_id, issuer_rut, document_type, document_folio) DO UPDATE
          SET due_date = EXCLUDED.due_date, updated_by = EXCLUDED.updated_by, updated_at = now()
          WHERE cuentas_por_pagar.pending_due_dates.supplier_id = EXCLUDED.supplier_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'El proveedor de la corrección no coincide' USING ERRCODE = 'P0001'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION cuentas_por_pagar.audit_invoice_due_date() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER cxp_audit_invoice_due_date AFTER UPDATE OF due_date ON cuentas_por_pagar.invoices
FOR EACH ROW EXECUTE FUNCTION cuentas_por_pagar.audit_invoice_due_date();

CREATE FUNCTION public.cxp_set_due_date(p_candidate_id uuid, p_invoice_id uuid, p_due_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    v_company constant uuid := 'd1000000-0000-0000-0000-000000000001'::uuid;
    v_actor uuid := auth.uid();
    v_candidate record;
    v_invoice cuentas_por_pagar.invoices%ROWTYPE;
    v_old date;
    v_updated cuentas_por_pagar.invoices%ROWTYPE;
    v_lock_identity text;
BEGIN
    IF v_actor IS NULL OR NOT coalesce(cuentas_por_pagar.can_access(v_company), false) THEN
        RAISE EXCEPTION 'Acceso a Cuentas por Pagar denegado' USING ERRCODE = '42501';
    END IF;
    IF (p_candidate_id IS NULL) = (p_invoice_id IS NULL) THEN
        RAISE EXCEPTION 'Indique una sola factura o candidato' USING ERRCODE = 'P0001';
    END IF;
    IF p_candidate_id IS NOT NULL THEN
        SELECT * INTO v_candidate FROM public.cxp_receipt_candidates() WHERE candidate_id = p_candidate_id;
        IF NOT FOUND OR v_candidate.issuer_rut IS NULL OR v_candidate.folio IS NULL OR v_candidate.supplier_id IS NULL THEN
            RAISE EXCEPTION 'Identidad de factura incompleta o inexistente' USING ERRCODE = 'P0001';
        END IF;
        v_lock_identity := v_candidate.issuer_rut || ':' || v_candidate.folio;
        PERFORM pg_advisory_xact_lock(hashtextextended('cxp:' || v_lock_identity, 0));
        SELECT * INTO v_candidate FROM public.cxp_receipt_candidates() WHERE candidate_id = p_candidate_id;
        IF NOT FOUND OR v_candidate.issuer_rut || ':' || v_candidate.folio IS DISTINCT FROM v_lock_identity THEN
            RAISE EXCEPTION 'El candidato cambió; actualice la bandeja' USING ERRCODE = 'P0001';
        END IF;
        IF v_candidate.invoice_id IS NOT NULL THEN
            p_invoice_id := v_candidate.invoice_id;
        ELSE
            IF v_candidate.blocked_reason IS NOT NULL THEN RAISE EXCEPTION 'Identidad no incorporable: %', v_candidate.blocked_reason USING ERRCODE = 'P0001'; END IF;
            IF p_due_date IS NOT NULL AND (v_candidate.issue_date IS NULL OR p_due_date < v_candidate.issue_date) THEN
                RAISE EXCEPTION 'Vencimiento anterior a la emisión o emisión desconocida' USING ERRCODE = 'P0001';
            END IF;
            SELECT x.due_date INTO v_old FROM public.cxp_receipt_due_dates() x WHERE x.candidate_id = p_candidate_id;
            INSERT INTO cuentas_por_pagar.due_date_audit(company_id, issuer_rut, document_type, document_folio, supplier_id, old_due_date, new_due_date, actor_id)
            VALUES (v_company, v_candidate.issuer_rut, 'FA', v_candidate.folio, v_candidate.supplier_id, v_old, p_due_date, v_actor);
            INSERT INTO cuentas_por_pagar.pending_due_dates(company_id, issuer_rut, document_type, document_folio, supplier_id, due_date, updated_by)
            VALUES (v_company, v_candidate.issuer_rut, 'FA', v_candidate.folio, v_candidate.supplier_id, p_due_date, v_actor)
            ON CONFLICT (company_id, issuer_rut, document_type, document_folio) DO UPDATE
                SET due_date = EXCLUDED.due_date, updated_by = EXCLUDED.updated_by, updated_at = now()
                WHERE cuentas_por_pagar.pending_due_dates.supplier_id = EXCLUDED.supplier_id;
            IF NOT FOUND THEN RAISE EXCEPTION 'El proveedor de la corrección no coincide' USING ERRCODE = 'P0001'; END IF;
            RETURN jsonb_build_object('candidate_id', p_candidate_id, 'invoice_id', NULL, 'due_date', p_due_date);
        END IF;
    END IF;
    SELECT * INTO v_invoice FROM cuentas_por_pagar.invoices WHERE id = p_invoice_id AND company_id = v_company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Factura no encontrada' USING ERRCODE = 'P0001'; END IF;
    IF p_candidate_id IS NOT NULL THEN
        IF v_invoice.supplier_id <> v_candidate.supplier_id OR v_invoice.issuer_rut <> v_candidate.issuer_rut
            OR v_invoice.document_folio <> v_candidate.folio OR v_invoice.document_type NOT IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
            RAISE EXCEPTION 'Identidad de factura incompatible' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    IF p_due_date IS NOT NULL AND p_due_date < v_invoice.issue_date THEN
        RAISE EXCEPTION 'El vencimiento no puede ser anterior a la emisión' USING ERRCODE = 'P0001';
    END IF;
    IF v_invoice.validation_status = 'VALIDATED' AND p_due_date IS NULL THEN
        RAISE EXCEPTION 'Una factura validada requiere vencimiento' USING ERRCODE = 'P0001';
    END IF;
    IF v_invoice.due_date IS DISTINCT FROM p_due_date THEN
        INSERT INTO cuentas_por_pagar.due_date_audit(company_id, issuer_rut, document_type, document_folio, supplier_id, invoice_id, old_due_date, new_due_date, actor_id, allow_validated)
        VALUES (v_company, v_invoice.issuer_rut, v_invoice.document_type, v_invoice.document_folio, v_invoice.supplier_id, v_invoice.id, v_invoice.due_date, p_due_date, v_actor, v_invoice.validation_status = 'VALIDATED');
        UPDATE cuentas_por_pagar.invoices SET due_date = p_due_date WHERE id = v_invoice.id AND company_id = v_company RETURNING * INTO v_updated;
    ELSE
        v_updated := v_invoice;
        -- Registrar la elección explícita de dejar vacío un vencimiento sugerido.
        IF v_invoice.origin = 'RECEIPT' AND p_due_date IS NULL THEN
            SELECT x.due_date INTO v_old FROM public.cxp_receipt_due_dates() x WHERE x.invoice_id = v_invoice.id LIMIT 1;
            IF v_old IS DISTINCT FROM p_due_date THEN
                INSERT INTO cuentas_por_pagar.due_date_audit(company_id, issuer_rut, document_type, document_folio, supplier_id, invoice_id, old_due_date, new_due_date, actor_id)
                VALUES (v_company, v_invoice.issuer_rut, v_invoice.document_type, v_invoice.document_folio, v_invoice.supplier_id, v_invoice.id, v_old, p_due_date, v_actor);
            END IF;
        END IF;
    END IF;
    IF v_invoice.origin = 'RECEIPT' AND v_invoice.document_type IN ('FA', 'FACTURA', 'INVOICE', '33', '34') THEN
        INSERT INTO cuentas_por_pagar.pending_due_dates(company_id, issuer_rut, document_type, document_folio, supplier_id, due_date, updated_by)
        VALUES (v_company, v_invoice.issuer_rut, 'FA', v_invoice.document_folio, v_invoice.supplier_id, p_due_date, v_actor)
        ON CONFLICT (company_id, issuer_rut, document_type, document_folio) DO UPDATE
            SET due_date = EXCLUDED.due_date, updated_by = EXCLUDED.updated_by, updated_at = now()
            WHERE cuentas_por_pagar.pending_due_dates.supplier_id = EXCLUDED.supplier_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'El proveedor de la corrección no coincide' USING ERRCODE = 'P0001'; END IF;
    END IF;
    RETURN jsonb_build_object('candidate_id', p_candidate_id, 'invoice_id', v_invoice.id, 'due_date', v_updated.due_date, 'validation_status', v_updated.validation_status);
END;
$$;

REVOKE ALL ON FUNCTION public.cxp_receipt_due_dates(), public.cxp_set_due_date(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cxp_receipt_due_dates(), public.cxp_set_due_date(uuid, uuid, date) TO authenticated;
NOTIFY pgrst, 'reload schema';
