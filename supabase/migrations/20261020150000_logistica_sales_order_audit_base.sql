-- ============================================================================
-- Auditoría de Notas de Venta · Base funcional y de datos
--
-- Tres capas independientes:
--   SOLICITADO  -> snapshot inmutable desde Preparación
--   PREPARADO   -> snapshot inmutable desde Preparación
--   AUDITADO    -> registro nuevo, independiente, sin límite superior
--
-- Esta migración NO modifica Preparación, NO modifica Bsale y NO implementa
-- el drawer de UI ni el estado final posterior a IN_AUDIT.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Permisos funcionales
--    Se registran sin asignación masiva de roles. Mientras no exista un rol de
--    auditor explícito, sólo system.admin accede por el bypass canónico.
-- ============================================================================
INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
    'logistica.audit.manage',
    'Gestionar Auditoría de Notas de Venta',
    'Permite tomar y registrar la auditoría física de una Nota de Venta.',
    m.id,
    true
FROM portal.modules AS m
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT
    'logistica.audit.authorize_exception',
    'Autorizar Excepciones de Auditoría',
    'Permite tomar la auditoría de otro usuario y autorizar excepciones operativas.',
    m.id,
    true
FROM portal.modules AS m
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    module_id = EXCLUDED.module_id,
    is_active = true;

-- ============================================================================
-- 2. Sesión de Auditoría
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.sales_order_audits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
    bsale_nv_id bigint NOT NULL,
    bsale_nv_folio text,
    cycle_no integer NOT NULL DEFAULT 1 CHECK (cycle_no >= 1),
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    assigned_auditor_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    locked_by_user_id uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    locked_at timestamptz,
    prepared_by_user_id_snapshot uuid,
    package_count integer CHECK (package_count IS NULL OR package_count >= 0),
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_audits_cycle_key
        UNIQUE (company_id, card_id, cycle_no),
    CONSTRAINT sales_order_audits_lock_consistency CHECK (
        (locked_by_user_id IS NULL AND locked_at IS NULL)
        OR (locked_by_user_id IS NOT NULL AND locked_at IS NOT NULL)
    ),
    CONSTRAINT sales_order_audits_not_preparer CHECK (
        (assigned_auditor_user_id IS NULL
            OR prepared_by_user_id_snapshot IS NULL
            OR assigned_auditor_user_id <> prepared_by_user_id_snapshot)
        AND (locked_by_user_id IS NULL
            OR prepared_by_user_id_snapshot IS NULL
            OR locked_by_user_id <> prepared_by_user_id_snapshot)
    ),
    CONSTRAINT sales_order_audits_completed_consistency CHECK (
        (status = 'OPEN' AND completed_at IS NULL)
        OR (status = 'CLOSED' AND completed_at IS NOT NULL)
    )
);

-- Una sola sesión activa por tarjeta. El ciclo queda preparado para futuras
-- reauditorías sin habilitarlas todavía.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_audits_active_card
    ON logistica.sales_order_audits (company_id, card_id)
    WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_sales_order_audits_card
    ON logistica.sales_order_audits (company_id, card_id, cycle_no);

CREATE INDEX IF NOT EXISTS idx_sales_order_audits_auditor
    ON logistica.sales_order_audits (company_id, assigned_auditor_user_id, status);

-- ============================================================================
-- 3. Snapshot de líneas de Auditoría
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.sales_order_audit_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id) ON DELETE CASCADE,
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
    preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT,
    bsale_detail_id bigint NOT NULL,
    bsale_variant_id bigint,
    sku text,
    product_name text NOT NULL,
    requested_quantity_snapshot numeric NOT NULL CHECK (requested_quantity_snapshot >= 0),
    prepared_quantity_snapshot numeric NOT NULL CHECK (prepared_quantity_snapshot >= 0),
    excluded_from_dispatch_snapshot boolean NOT NULL DEFAULT false,
    audit_quantity numeric CHECK (audit_quantity IS NULL OR audit_quantity >= 0),
    line_status text NOT NULL DEFAULT 'PENDING'
        CHECK (line_status IN ('PENDING', 'CONFIRMED', 'INCIDENT')),
    confirmed_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_audit_lines_audit_line_key
        UNIQUE (company_id, audit_id, preparation_line_id),
    CONSTRAINT sales_order_audit_lines_audit_detail_key
        UNIQUE (company_id, audit_id, bsale_detail_id),
    CONSTRAINT sales_order_audit_lines_status_consistency CHECK (
        (line_status = 'PENDING'
            AND audit_quantity IS NULL
            AND confirmed_by IS NULL
            AND confirmed_at IS NULL)
        OR (line_status IN ('CONFIRMED', 'INCIDENT')
            AND audit_quantity IS NOT NULL
            AND confirmed_by IS NOT NULL
            AND confirmed_at IS NOT NULL)
    ),
    -- INCIDENT puede coexistir con audit_quantity = prepared_quantity_snapshot
    -- cuando existe una incidencia física manual (WRONG_PRODUCT, DAMAGED_PRODUCT,
    -- PRODUCT_NOT_FOUND u OTHER). La única implicación segura es CONFIRMED -> igualdad.
    CONSTRAINT sales_order_audit_lines_confirmed_matches CHECK (
        line_status <> 'CONFIRMED'
        OR audit_quantity = prepared_quantity_snapshot
    )
);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_lines_audit
    ON logistica.sales_order_audit_lines (company_id, audit_id, bsale_detail_id);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_lines_prep
    ON logistica.sales_order_audit_lines (company_id, preparation_line_id);

-- ============================================================================
-- 4. Incidencias de Auditoría (independientes de Preparación)
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.sales_order_audit_incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id) ON DELETE CASCADE,
    audit_line_id uuid NOT NULL REFERENCES logistica.sales_order_audit_lines(id) ON DELETE CASCADE,
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
    preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT,
    requested_quantity_snapshot numeric NOT NULL CHECK (requested_quantity_snapshot >= 0),
    prepared_quantity_snapshot numeric NOT NULL CHECK (prepared_quantity_snapshot >= 0),
    audit_quantity numeric NOT NULL CHECK (audit_quantity >= 0),
    difference_vs_prepared numeric NOT NULL,
    incident_type text NOT NULL CHECK (incident_type IN (
        'QUANTITY_LOWER_THAN_PREPARED',
        'QUANTITY_GREATER_THAN_PREPARED',
        'WRONG_PRODUCT',
        'DAMAGED_PRODUCT',
        'PRODUCT_NOT_FOUND',
        'OTHER'
    )),
    observation text,
    status text NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'RESOLVED', 'SUPERSEDED')),
    detected_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    detected_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_audit_incidents_difference CHECK (
        difference_vs_prepared = audit_quantity - prepared_quantity_snapshot
    ),
    CONSTRAINT sales_order_audit_incidents_lower_sign CHECK (
        incident_type <> 'QUANTITY_LOWER_THAN_PREPARED'
        OR difference_vs_prepared < 0
    ),
    CONSTRAINT sales_order_audit_incidents_greater_sign CHECK (
        incident_type <> 'QUANTITY_GREATER_THAN_PREPARED'
        OR difference_vs_prepared > 0
    ),
    CONSTRAINT sales_order_audit_incidents_other_observation CHECK (
        incident_type <> 'OTHER'
        OR btrim(coalesce(observation, '')) <> ''
    ),
    CONSTRAINT sales_order_audit_incidents_product_not_found_zero CHECK (
        incident_type <> 'PRODUCT_NOT_FOUND'
        OR audit_quantity = 0
    )
);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_incidents_audit
    ON logistica.sales_order_audit_incidents (company_id, audit_id, status);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_incidents_line
    ON logistica.sales_order_audit_incidents (company_id, audit_line_id, status);

-- Una sola incidencia OPEN por línea. Las anteriores se conservan como
-- SUPERSEDED para mantener el historial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_audit_incidents_open_line
    ON logistica.sales_order_audit_incidents (company_id, audit_line_id)
    WHERE status = 'OPEN';

-- ============================================================================
-- 5. Adjuntos de Auditoría (evidencia por incidencia y foto global)
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.sales_order_audit_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id) ON DELETE CASCADE,
    audit_line_id uuid REFERENCES logistica.sales_order_audit_lines(id) ON DELETE CASCADE,
    incident_id uuid REFERENCES logistica.sales_order_audit_incidents(id) ON DELETE CASCADE,
    attachment_type text NOT NULL
        CHECK (attachment_type IN ('INCIDENT_EVIDENCE', 'GLOBAL_DISPATCH_PHOTO')),
    storage_bucket text NOT NULL DEFAULT 'audit-evidence',
    storage_path text NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL
        CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
    file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 10485760),
    uploaded_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_audit_attachments_context CHECK (
        (attachment_type = 'INCIDENT_EVIDENCE'
            AND incident_id IS NOT NULL
            AND audit_line_id IS NOT NULL)
        OR (attachment_type = 'GLOBAL_DISPATCH_PHOTO'
            AND incident_id IS NULL
            AND audit_line_id IS NULL)
    ),
    CONSTRAINT sales_order_audit_attachments_company_path CHECK (
        storage_path LIKE company_id::text || '/%'
    ),
    CONSTRAINT sales_order_audit_attachments_path_key
        UNIQUE (company_id, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_attachments_audit
    ON logistica.sales_order_audit_attachments (company_id, audit_id, attachment_type);

CREATE INDEX IF NOT EXISTS idx_sales_order_audit_attachments_incident
    ON logistica.sales_order_audit_attachments (company_id, incident_id)
    WHERE incident_id IS NOT NULL;

-- Una sola foto global por sesión de auditoría.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_audit_attachments_global
    ON logistica.sales_order_audit_attachments (company_id, audit_id)
    WHERE attachment_type = 'GLOBAL_DISPATCH_PHOTO';

-- ============================================================================
-- 6. RLS y grants
-- ============================================================================
ALTER TABLE logistica.sales_order_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_audit_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_audit_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_audit_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_order_audits_select ON logistica.sales_order_audits;
CREATE POLICY sales_order_audits_select
    ON logistica.sales_order_audits FOR SELECT TO authenticated
    USING (
        core.has_company_access(auth.uid(), company_id)
        AND core.has_permission_for_company(auth.uid(), company_id, 'logistica.audit.manage')
    );
DROP POLICY IF EXISTS sales_order_audits_service ON logistica.sales_order_audits;
CREATE POLICY sales_order_audits_service
    ON logistica.sales_order_audits FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_order_audit_lines_select ON logistica.sales_order_audit_lines;
CREATE POLICY sales_order_audit_lines_select
    ON logistica.sales_order_audit_lines FOR SELECT TO authenticated
    USING (
        core.has_company_access(auth.uid(), company_id)
        AND core.has_permission_for_company(auth.uid(), company_id, 'logistica.audit.manage')
    );
DROP POLICY IF EXISTS sales_order_audit_lines_service ON logistica.sales_order_audit_lines;
CREATE POLICY sales_order_audit_lines_service
    ON logistica.sales_order_audit_lines FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_order_audit_incidents_select ON logistica.sales_order_audit_incidents;
CREATE POLICY sales_order_audit_incidents_select
    ON logistica.sales_order_audit_incidents FOR SELECT TO authenticated
    USING (
        core.has_company_access(auth.uid(), company_id)
        AND core.has_permission_for_company(auth.uid(), company_id, 'logistica.audit.manage')
    );
DROP POLICY IF EXISTS sales_order_audit_incidents_service ON logistica.sales_order_audit_incidents;
CREATE POLICY sales_order_audit_incidents_service
    ON logistica.sales_order_audit_incidents FOR ALL TO service_role
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_order_audit_attachments_select ON logistica.sales_order_audit_attachments;
CREATE POLICY sales_order_audit_attachments_select
    ON logistica.sales_order_audit_attachments FOR SELECT TO authenticated
    USING (
        core.has_company_access(auth.uid(), company_id)
        AND core.has_permission_for_company(auth.uid(), company_id, 'logistica.audit.manage')
    );
DROP POLICY IF EXISTS sales_order_audit_attachments_service ON logistica.sales_order_audit_attachments;
CREATE POLICY sales_order_audit_attachments_service
    ON logistica.sales_order_audit_attachments FOR ALL TO service_role
    USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE logistica.sales_order_audits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE logistica.sales_order_audit_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE logistica.sales_order_audit_incidents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE logistica.sales_order_audit_attachments FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE logistica.sales_order_audits TO authenticated;
GRANT SELECT ON TABLE logistica.sales_order_audit_lines TO authenticated;
GRANT SELECT ON TABLE logistica.sales_order_audit_incidents TO authenticated;
GRANT SELECT ON TABLE logistica.sales_order_audit_attachments TO authenticated;

GRANT ALL ON TABLE logistica.sales_order_audits TO service_role;
GRANT ALL ON TABLE logistica.sales_order_audit_lines TO service_role;
GRANT ALL ON TABLE logistica.sales_order_audit_incidents TO service_role;
GRANT ALL ON TABLE logistica.sales_order_audit_attachments TO service_role;

-- ============================================================================
-- 7. Storage privado para evidencia de Auditoría
--    Path: {company_id}/{card_id}/{audit_id}/{archivo}
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'audit-evidence',
    'audit-evidence',
    false,
    10485760,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']::text[]
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION logistica.is_audit_evidence_path_allowed(p_object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v_actor_id uuid;
    v_company_id uuid;
    v_card_id uuid;
    v_audit_id uuid;
BEGIN
    v_actor_id := auth.uid();

    IF v_actor_id IS NULL OR p_object_name IS NULL OR btrim(p_object_name) = '' THEN
        RETURN false;
    END IF;

    IF p_object_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+\.(jpg|jpeg|png|webp|heic)$' THEN
        RETURN false;
    END IF;

    BEGIN
        v_company_id := split_part(p_object_name, '/', 1)::uuid;
        v_card_id := split_part(p_object_name, '/', 2)::uuid;
        v_audit_id := split_part(p_object_name, '/', 3)::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;

    IF NOT core.has_company_access(v_actor_id, v_company_id) THEN
        RETURN false;
    END IF;

    IF NOT core.has_permission_for_company(v_actor_id, v_company_id, 'logistica.audit.manage') THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM logistica.sales_order_audits a
        WHERE a.company_id = v_company_id
          AND a.card_id = v_card_id
          AND a.id = v_audit_id
          AND a.status = 'OPEN'
    );
END;
$$;

ALTER FUNCTION logistica.is_audit_evidence_path_allowed(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION logistica.is_audit_evidence_path_allowed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION logistica.is_audit_evidence_path_allowed(text) TO authenticated;

DROP POLICY IF EXISTS audit_evidence_select ON storage.objects;
CREATE POLICY audit_evidence_select ON storage.objects FOR SELECT TO authenticated
USING (
    bucket_id = 'audit-evidence'
    AND logistica.is_audit_evidence_path_allowed(name)
);

DROP POLICY IF EXISTS audit_evidence_insert ON storage.objects;
CREATE POLICY audit_evidence_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'audit-evidence'
    AND owner = auth.uid()
    AND logistica.is_audit_evidence_path_allowed(name)
);

DROP POLICY IF EXISTS audit_evidence_delete ON storage.objects;
CREATE POLICY audit_evidence_delete ON storage.objects FOR DELETE TO authenticated
USING (
    bucket_id = 'audit-evidence'
    AND logistica.is_audit_evidence_path_allowed(name)
);

-- ============================================================================
-- 8. Materialización idempotente del snapshot
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_audit_snapshot(
    p_company_id uuid,
    p_card_id uuid,
    p_actor_id uuid,
    p_cycle_no integer DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_audit_id uuid;
    v_line_count integer;
    v_pending integer;
BEGIN
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'Actor de auditoría requerido.';
    END IF;
    IF p_cycle_no IS NULL OR p_cycle_no < 1 THEN
        RAISE EXCEPTION 'Ciclo de auditoría inválido.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada para la empresa.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría.';
    END IF;

    SELECT count(*) INTO v_pending
    FROM logistica.sales_order_preparation_lines
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND prepared_quantity IS NULL;

    IF v_pending > 0 THEN
        RAISE EXCEPTION 'La preparación tiene % líneas sin cantidad preparada.', v_pending;
    END IF;

    INSERT INTO logistica.sales_order_audits (
        company_id, card_id, bsale_nv_id, bsale_nv_folio, cycle_no, status,
        prepared_by_user_id_snapshot, created_by
    ) VALUES (
        p_company_id, p_card_id, v_card.bsale_nv_id, v_card.bsale_nv_folio,
        p_cycle_no, 'OPEN', v_card.assigned_user_id, p_actor_id
    )
    ON CONFLICT (company_id, card_id, cycle_no) DO NOTHING;

    SELECT id INTO v_audit_id
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND cycle_no = p_cycle_no;

    IF v_audit_id IS NULL THEN
        RAISE EXCEPTION 'No se pudo crear la sesión de auditoría.';
    END IF;

    INSERT INTO logistica.sales_order_audit_lines (
        company_id, audit_id, card_id, preparation_line_id,
        bsale_detail_id, bsale_variant_id, sku, product_name,
        requested_quantity_snapshot, prepared_quantity_snapshot,
        excluded_from_dispatch_snapshot
    )
    SELECT
        pl.company_id, v_audit_id, pl.card_id, pl.id,
        pl.bsale_detail_id, pl.bsale_variant_id, pl.sku, pl.product_name,
        pl.requested_quantity, pl.prepared_quantity,
        pl.excluded_from_dispatch
    FROM logistica.sales_order_preparation_lines pl
    WHERE pl.company_id = p_company_id
      AND pl.card_id = p_card_id
    ON CONFLICT (company_id, audit_id, preparation_line_id) DO NOTHING;

    SELECT count(*) INTO v_line_count
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id AND audit_id = v_audit_id;

    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'La tarjeta no tiene líneas de preparación para auditar.';
    END IF;

    RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION logistica.materialize_sales_order_audit_snapshot(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.materialize_sales_order_audit_snapshot(uuid, uuid, uuid, integer) TO service_role;

-- ============================================================================
-- 9. Toma atómica de Auditoría
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.take_sales_order_audit(
    p_company_id uuid,
    p_card_id uuid,
    p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_audit_id uuid;
    v_actor_name text;
    v_preparer_name text;
    v_event text;
    v_line_count integer;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tarjeta no encontrada.';
    END IF;
    IF v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'Solo se puede auditar una tarjeta En auditoría.';
    END IF;
    IF v_card.assigned_user_id = v_actor THEN
        RAISE EXCEPTION 'No puedes auditar una preparación realizada por ti.';
    END IF;

    v_audit_id := logistica.materialize_sales_order_audit_snapshot(
        p_company_id, p_card_id, v_actor, 1
    );

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = v_audit_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;
    IF v_audit.prepared_by_user_id_snapshot = v_actor THEN
        RAISE EXCEPTION 'No puedes auditar una preparación realizada por ti.';
    END IF;

    IF v_audit.locked_by_user_id = v_actor THEN
        v_event := 'AUDIT_LOCK_ALREADY_OWNED';
    ELSIF v_audit.locked_by_user_id IS NOT NULL THEN
        IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.authorize_exception') THEN
            RAISE EXCEPTION 'Esta auditoría está siendo realizada por otro usuario.';
        END IF;
        IF p_reason IS NULL OR btrim(p_reason) = '' THEN
            RAISE EXCEPTION 'El motivo es obligatorio para tomar la auditoría de otro usuario.';
        END IF;
        v_event := 'AUDIT_LOCK_TAKEOVER';
    ELSE
        v_event := 'AUDIT_LOCK_CLAIM';
    END IF;

    UPDATE logistica.sales_order_audits
       SET assigned_auditor_user_id = v_actor,
           locked_by_user_id = v_actor,
           locked_at = now(),
           updated_at = now()
     WHERE id = v_audit_id
     RETURNING * INTO v_audit;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_actor_name
      FROM portal.users u
     WHERE u.id = v_actor;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_preparer_name
      FROM portal.users u
     WHERE u.id = v_card.assigned_user_id;

    SELECT count(*) INTO v_line_count
      FROM logistica.sales_order_audit_lines
     WHERE company_id = p_company_id AND audit_id = v_audit_id;

    RETURN jsonb_build_object(
        'audit_id', v_audit.id,
        'card_id', p_card_id,
        'company_id', p_company_id,
        'status', v_audit.status,
        'cycle_no', v_audit.cycle_no,
        'assigned_auditor_user_id', v_audit.assigned_auditor_user_id,
        'auditor_name', v_actor_name,
        'locked_by_user_id', v_audit.locked_by_user_id,
        'locked_at', v_audit.locked_at,
        'prepared_by_user_id', v_audit.prepared_by_user_id_snapshot,
        'preparer_name', v_preparer_name,
        'line_count', v_line_count,
        'package_count', v_audit.package_count,
        'event', v_event
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.take_sales_order_audit(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.take_sales_order_audit(uuid, uuid, text) TO authenticated, service_role;

-- ============================================================================
-- 10. Lectura consolidada de la sesión
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.get_sales_order_audit_detail(
    p_company_id uuid,
    p_card_id uuid,
    p_cycle_no integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_preparer_name text;
    v_auditor_name text;
    v_locked_by_name text;
    v_lines jsonb;
    v_incidents jsonb;
    v_attachments jsonb;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para consultar Auditoría.';
    END IF;

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE company_id = p_company_id
      AND card_id = p_card_id
      AND cycle_no = p_cycle_no;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'audit', NULL,
            'lines', '[]'::jsonb,
            'incidents', '[]'::jsonb,
            'attachments', '[]'::jsonb
        );
    END IF;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_preparer_name
      FROM portal.users u
     WHERE u.id = v_audit.prepared_by_user_id_snapshot;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_auditor_name
      FROM portal.users u
     WHERE u.id = v_audit.assigned_auditor_user_id;

    SELECT NULLIF(btrim(concat_ws(' ', u.nombre, u.apellido)), '')
      INTO v_locked_by_name
      FROM portal.users u
     WHERE u.id = v_audit.locked_by_user_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.bsale_detail_id), '[]'::jsonb)
      INTO v_lines
      FROM logistica.sales_order_audit_lines l
     WHERE l.company_id = p_company_id AND l.audit_id = v_audit.id;

    SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.detected_at), '[]'::jsonb)
      INTO v_incidents
      FROM logistica.sales_order_audit_incidents i
     WHERE i.company_id = p_company_id AND i.audit_id = v_audit.id;

    SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.uploaded_at), '[]'::jsonb)
      INTO v_attachments
      FROM logistica.sales_order_audit_attachments a
     WHERE a.company_id = p_company_id AND a.audit_id = v_audit.id;

    RETURN jsonb_build_object(
        'audit', to_jsonb(v_audit) || jsonb_build_object(
            'preparer_name', v_preparer_name,
            'auditor_name', v_auditor_name,
            'locked_by_name', v_locked_by_name
        ),
        'lines', v_lines,
        'incidents', v_incidents,
        'attachments', v_attachments
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.get_sales_order_audit_detail(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_audit_detail(uuid, uuid, integer) TO authenticated, service_role;

-- ============================================================================
-- 11. Confirmación de cantidad auditada
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_audit_line(
    p_company_id uuid,
    p_audit_line_id uuid,
    p_audit_quantity numeric,
    p_incident_type text DEFAULT NULL,
    p_observation text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_line logistica.sales_order_audit_lines%ROWTYPE;
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_incident_type text;
    v_incident_id uuid;
    v_incident jsonb;
    v_line_status text;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;
    IF p_audit_quantity IS NULL OR p_audit_quantity < 0 THEN
        RAISE EXCEPTION 'La cantidad auditada debe ser mayor o igual a 0.';
    END IF;

    SELECT * INTO v_line
    FROM logistica.sales_order_audit_lines
    WHERE id = p_audit_line_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Línea de auditoría no encontrada.';
    END IF;

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = v_line.audit_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;

    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = v_audit.card_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND OR v_card.status <> 'IN_AUDIT' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En auditoría.';
    END IF;
    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;

    v_incident_type := NULLIF(upper(btrim(coalesce(p_incident_type, ''))), '');

    IF v_incident_type IS NOT NULL AND v_incident_type NOT IN (
        'QUANTITY_LOWER_THAN_PREPARED',
        'QUANTITY_GREATER_THAN_PREPARED',
        'WRONG_PRODUCT',
        'DAMAGED_PRODUCT',
        'PRODUCT_NOT_FOUND',
        'OTHER'
    ) THEN
        RAISE EXCEPTION 'Tipo de incidencia de auditoría inválido.';
    END IF;

    IF v_incident_type IS NULL THEN
        IF p_audit_quantity < v_line.prepared_quantity_snapshot THEN
            v_incident_type := 'QUANTITY_LOWER_THAN_PREPARED';
        ELSIF p_audit_quantity > v_line.prepared_quantity_snapshot THEN
            v_incident_type := 'QUANTITY_GREATER_THAN_PREPARED';
        END IF;
    END IF;

    IF v_incident_type = 'QUANTITY_LOWER_THAN_PREPARED'
       AND p_audit_quantity >= v_line.prepared_quantity_snapshot THEN
        RAISE EXCEPTION 'La incidencia de cantidad menor no coincide con las cantidades.';
    END IF;
    IF v_incident_type = 'QUANTITY_GREATER_THAN_PREPARED'
       AND p_audit_quantity <= v_line.prepared_quantity_snapshot THEN
        RAISE EXCEPTION 'La incidencia de cantidad mayor no coincide con las cantidades.';
    END IF;
    IF v_incident_type = 'PRODUCT_NOT_FOUND'
       AND p_audit_quantity > 0 THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0.';
    END IF;
    IF v_incident_type = 'OTHER'
       AND (p_observation IS NULL OR btrim(p_observation) = '') THEN
        RAISE EXCEPTION 'La observación es obligatoria para la incidencia OTRO.';
    END IF;

    UPDATE logistica.sales_order_audit_incidents
       SET status = 'SUPERSEDED',
           updated_at = now()
     WHERE company_id = p_company_id
       AND audit_line_id = v_line.id
       AND status = 'OPEN';

    IF v_incident_type IS NOT NULL THEN
        INSERT INTO logistica.sales_order_audit_incidents (
            company_id, audit_id, audit_line_id, card_id, preparation_line_id,
            requested_quantity_snapshot, prepared_quantity_snapshot,
            audit_quantity, difference_vs_prepared, incident_type,
            observation, status, detected_by
        ) VALUES (
            p_company_id, v_audit.id, v_line.id, v_line.card_id, v_line.preparation_line_id,
            v_line.requested_quantity_snapshot, v_line.prepared_quantity_snapshot,
            p_audit_quantity, p_audit_quantity - v_line.prepared_quantity_snapshot,
            v_incident_type, NULLIF(btrim(p_observation), ''), 'OPEN', v_actor
        )
        RETURNING id INTO v_incident_id;

        SELECT to_jsonb(i) INTO v_incident
        FROM logistica.sales_order_audit_incidents i
        WHERE i.id = v_incident_id;
    END IF;

    v_line_status := CASE
        WHEN v_incident_type IS NULL
         AND p_audit_quantity = v_line.prepared_quantity_snapshot THEN 'CONFIRMED'
        ELSE 'INCIDENT'
    END;

    UPDATE logistica.sales_order_audit_lines
       SET audit_quantity = p_audit_quantity,
           line_status = v_line_status,
           confirmed_by = v_actor,
           confirmed_at = now(),
           updated_at = now()
     WHERE id = v_line.id
     RETURNING * INTO v_line;

    RETURN jsonb_build_object(
        'line', to_jsonb(v_line),
        'incident', v_incident,
        'incident_type', v_incident_type,
        'difference_vs_prepared', p_audit_quantity - v_line.prepared_quantity_snapshot
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.confirm_sales_order_audit_line(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.confirm_sales_order_audit_line(uuid, uuid, numeric, text, text) TO authenticated, service_role;

-- ============================================================================
-- 12. Bultos: dato físico independiente
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.set_sales_order_audit_package_count(
    p_company_id uuid,
    p_audit_id uuid,
    p_package_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;
    IF p_package_count IS NULL OR p_package_count < 0 THEN
        RAISE EXCEPTION 'La cantidad de bultos no puede ser negativa.';
    END IF;

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = p_audit_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;
    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;

    UPDATE logistica.sales_order_audits
       SET package_count = p_package_count,
           updated_at = now()
     WHERE id = p_audit_id
     RETURNING * INTO v_audit;

    RETURN to_jsonb(v_audit);
END;
$$;

REVOKE ALL ON FUNCTION logistica.set_sales_order_audit_package_count(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.set_sales_order_audit_package_count(uuid, uuid, integer) TO authenticated, service_role;

-- ============================================================================
-- 13. Registro de adjuntos/evidencia
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.register_sales_order_audit_attachment(
    p_company_id uuid,
    p_audit_id uuid,
    p_attachment_type text,
    p_storage_path text,
    p_file_name text,
    p_mime_type text,
    p_file_size bigint,
    p_incident_id uuid DEFAULT NULL,
    p_audit_line_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public, storage
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_attachment_type text;
    v_incident logistica.sales_order_audit_incidents%ROWTYPE;
    v_line logistica.sales_order_audit_lines%ROWTYPE;
    v_attachment_id uuid;
    v_attachment jsonb;
    v_parts text[];
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para gestionar Auditoría.';
    END IF;

    v_attachment_type := upper(btrim(coalesce(p_attachment_type, '')));
    IF v_attachment_type NOT IN ('INCIDENT_EVIDENCE', 'GLOBAL_DISPATCH_PHOTO') THEN
        RAISE EXCEPTION 'Tipo de adjunto de auditoría inválido.';
    END IF;
    IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
        RAISE EXCEPTION 'La ruta de storage es obligatoria.';
    END IF;
    IF p_file_name IS NULL OR btrim(p_file_name) = '' THEN
        RAISE EXCEPTION 'El nombre de archivo es obligatorio.';
    END IF;
    IF p_mime_type IS NULL
       OR p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic') THEN
        RAISE EXCEPTION 'Tipo MIME no permitido para evidencia de auditoría.';
    END IF;
    IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 10485760 THEN
        RAISE EXCEPTION 'El tamaño del archivo debe estar entre 1 byte y 10 MB.';
    END IF;

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = p_audit_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Sesión de auditoría no encontrada.';
    END IF;
    IF v_audit.status <> 'OPEN' THEN
        RAISE EXCEPTION 'La sesión de auditoría no está abierta.';
    END IF;
    IF v_audit.locked_by_user_id IS NULL THEN
        RAISE EXCEPTION 'Esta auditoría aún no tiene responsable. Tómala antes de continuar.';
    END IF;
    IF v_audit.locked_by_user_id <> v_actor THEN
        RAISE EXCEPTION 'Esta auditoría está asignada a otro usuario.';
    END IF;

    v_parts := string_to_array(p_storage_path, '/');
    IF array_length(v_parts, 1) < 4
       OR v_parts[1] <> p_company_id::text
       OR v_parts[2] <> v_audit.card_id::text
       OR v_parts[3] <> p_audit_id::text THEN
        RAISE EXCEPTION 'La ruta de storage no corresponde a la empresa, tarjeta y auditoría.';
    END IF;
    IF NOT logistica.is_audit_evidence_path_allowed(p_storage_path) THEN
        RAISE EXCEPTION 'La ruta de storage no es válida para evidencia de Auditoría.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM storage.objects o
        WHERE o.bucket_id = 'audit-evidence'
          AND o.name = p_storage_path
    ) THEN
        RAISE EXCEPTION 'El archivo no existe en el bucket audit-evidence.';
    END IF;

    IF v_attachment_type = 'INCIDENT_EVIDENCE' THEN
        IF p_incident_id IS NULL OR p_audit_line_id IS NULL THEN
            RAISE EXCEPTION 'La evidencia de incidencia requiere incidencia y línea.';
        END IF;
        SELECT * INTO v_incident
        FROM logistica.sales_order_audit_incidents
        WHERE id = p_incident_id
          AND company_id = p_company_id
          AND audit_id = p_audit_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Incidencia de auditoría no encontrada.';
        END IF;
        SELECT * INTO v_line
        FROM logistica.sales_order_audit_lines
        WHERE id = p_audit_line_id
          AND company_id = p_company_id
          AND audit_id = p_audit_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Línea de auditoría no encontrada.';
        END IF;
        IF v_incident.audit_line_id <> v_line.id THEN
            RAISE EXCEPTION 'La incidencia no pertenece a la línea indicada.';
        END IF;
    ELSE
        IF p_incident_id IS NOT NULL OR p_audit_line_id IS NOT NULL THEN
            RAISE EXCEPTION 'La foto global no puede asociarse a una incidencia o línea.';
        END IF;
    END IF;

    INSERT INTO logistica.sales_order_audit_attachments (
        company_id, audit_id, audit_line_id, incident_id, attachment_type,
        storage_bucket, storage_path, file_name, mime_type, file_size,
        uploaded_by
    ) VALUES (
        p_company_id, p_audit_id, p_audit_line_id, p_incident_id, v_attachment_type,
        'audit-evidence', p_storage_path, btrim(p_file_name), p_mime_type, p_file_size,
        v_actor
    )
    RETURNING id INTO v_attachment_id;

    SELECT to_jsonb(a) INTO v_attachment
    FROM logistica.sales_order_audit_attachments a
    WHERE a.id = v_attachment_id;

    RETURN v_attachment;
END;
$$;

REVOKE ALL ON FUNCTION logistica.register_sales_order_audit_attachment(uuid, uuid, text, text, text, text, bigint, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.register_sales_order_audit_attachment(uuid, uuid, text, text, text, text, bigint, uuid, uuid) TO authenticated, service_role;

-- Helper explícito: una incidencia WRONG_PRODUCT/DAMAGED_PRODUCT sólo está
-- respaldada cuando existe al menos una fotografía asociada.
CREATE OR REPLACE FUNCTION logistica.audit_incident_has_required_evidence(
    p_company_id uuid,
    p_incident_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = logistica, public
AS $$
    SELECT CASE
        WHEN i.incident_type NOT IN ('WRONG_PRODUCT', 'DAMAGED_PRODUCT') THEN true
        ELSE EXISTS (
            SELECT 1
            FROM logistica.sales_order_audit_attachments a
            WHERE a.company_id = i.company_id
              AND a.incident_id = i.id
              AND a.attachment_type = 'INCIDENT_EVIDENCE'
        )
    END
    FROM logistica.sales_order_audit_incidents i
    WHERE i.company_id = p_company_id AND i.id = p_incident_id;
$$;

REVOKE ALL ON FUNCTION logistica.audit_incident_has_required_evidence(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.audit_incident_has_required_evidence(uuid, uuid) TO service_role;

-- ============================================================================
-- 14. Validación de pre-cierre (sin transición final)
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.can_finalize_sales_order_audit(
    p_company_id uuid,
    p_audit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_audit logistica.sales_order_audits%ROWTYPE;
    v_card_status text;
    v_pending integer;
    v_open_incidents integer;
    v_missing_evidence integer;
    v_blockers jsonb := '[]'::jsonb;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    IF NOT core.has_permission_for_company(v_actor, p_company_id, 'logistica.audit.manage') THEN
        RAISE EXCEPTION 'No tienes permiso para consultar Auditoría.';
    END IF;

    SELECT * INTO v_audit
    FROM logistica.sales_order_audits
    WHERE id = p_audit_id AND company_id = p_company_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'can_finalize', false,
            'audit_id', p_audit_id,
            'blockers', jsonb_build_array(jsonb_build_object(
                'code', 'AUDIT_NOT_FOUND',
                'message', 'Sesión de auditoría no encontrada.'
            ))
        );
    END IF;

    IF v_audit.status <> 'OPEN' THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'AUDIT_NOT_OPEN',
            'message', 'La sesión de auditoría no está abierta.'
        ));
    END IF;

    SELECT status INTO v_card_status
    FROM logistica.sales_order_preparation_cards
    WHERE id = v_audit.card_id AND company_id = p_company_id;

    IF v_card_status IS DISTINCT FROM 'IN_AUDIT' THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'CARD_NOT_IN_AUDIT',
            'message', 'La tarjeta ya no está En auditoría.'
        ));
    END IF;

    SELECT count(*) INTO v_pending
    FROM logistica.sales_order_audit_lines
    WHERE company_id = p_company_id
      AND audit_id = v_audit.id
      AND line_status = 'PENDING';

    IF v_pending > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'LINES_PENDING',
            'message', format('Faltan %s líneas por auditar.', v_pending),
            'count', v_pending
        ));
    END IF;

    SELECT count(*) INTO v_open_incidents
    FROM logistica.sales_order_audit_incidents
    WHERE company_id = p_company_id
      AND audit_id = v_audit.id
      AND status = 'OPEN';

    IF v_open_incidents > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'OPEN_INCIDENTS',
            'message', format('Existen %s incidencias de auditoría abiertas.', v_open_incidents),
            'count', v_open_incidents
        ));
    END IF;

    IF v_audit.package_count IS NULL OR v_audit.package_count < 1 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'PACKAGE_COUNT_REQUIRED',
            'message', 'La cantidad de bultos es obligatoria para finalizar Auditoría.'
        ));
    END IF;

    SELECT count(*) INTO v_missing_evidence
    FROM logistica.sales_order_audit_incidents i
    WHERE i.company_id = p_company_id
      AND i.audit_id = v_audit.id
      AND i.status = 'OPEN'
      AND i.incident_type IN ('WRONG_PRODUCT', 'DAMAGED_PRODUCT')
      AND NOT logistica.audit_incident_has_required_evidence(i.company_id, i.id);

    IF v_missing_evidence > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'code', 'MISSING_REQUIRED_EVIDENCE',
            'message', format('Faltan fotografías obligatorias en %s incidencias.', v_missing_evidence),
            'count', v_missing_evidence
        ));
    END IF;

    RETURN jsonb_build_object(
        'can_finalize', v_blockers = '[]'::jsonb,
        'audit_id', v_audit.id,
        'package_count', v_audit.package_count,
        'blockers', v_blockers
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.can_finalize_sales_order_audit(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.can_finalize_sales_order_audit(uuid, uuid) TO authenticated, service_role;

COMMIT;
