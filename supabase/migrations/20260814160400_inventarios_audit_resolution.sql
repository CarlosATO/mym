-- =========================================================================================
-- MIGRATION: M1.5H - Resolucion administrativa de auditorias PRODUCTO POR PRODUCTO
-- =========================================================================================
-- Objetivo:
--   Permitir que la Administracion (SUPER_USUARIO o ADMINISTRATOR activo del Inventario)
--   resuelva cada producto auditado SUBMITTED con APPROVE o REJECT.
--     * SUBMITTED NUNCA modifica el resultado fisico efectivo.
--     * APPROVE reemplaza (nunca suma) el resultado efectivo de las ubicaciones auditadas
--       materializando count_entries con capture_source = 'AUDIT'.
--     * REJECT conserva el fisico anterior; el resultado auditado queda historico.
--   Reglas contractuales cerradas:
--     - resolucion por audit_product_id; decisiones mixtas en una misma auditoria;
--     - overlay AUDIT por manifest exacto (replaced_count_entry_id), nunca por scope amplio;
--     - RECOUNT indivisible: un APPROVE sobre una ubicacion reemplaza la fila del RECOUNT
--       por id; un RECOUNT posterior no desplaza un AUDIT aprobado (se crea nueva auditoria);
--     - el count AUDIT conserva al auditor real (counted_by = audited_by), no hereda
--       recount_request_id y no falsifica session_participant_id;
--     - pendientes NO bloquean el cierre global; al cerrar se terminalizan sin aplicarse;
--     - NO_PREVIOUS_LOCATION fuera de aprobacion en este bloque;
--     - NO_CONTEXT / AMBIGUOUS_CONTEXT bloquean APPROVE sin mutaciones parciales;
--     - una session APPROVED afectada genera nueva official_version encadenada.
--
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

-- ============================================================
-- 0. count_entries: soporte de capturas de origen AUDIT
-- ============================================================

-- El count sintetico AUDIT no pertenece a un participante de jornada: se identifica
-- exclusivamente por counted_by = audited_by (el auditor real). session_participant_id
-- pasa a ser opcional.
ALTER TABLE inventarios.count_entries ALTER COLUMN session_participant_id DROP NOT NULL;

-- Vinculo del count sintetico con el resultado auditado que representa.
ALTER TABLE inventarios.count_entries
    ADD COLUMN audit_result_id uuid
    REFERENCES inventarios.inventory_audit_results(id) ON DELETE RESTRICT;

-- El nombre del CHECK de capture_source puede variar entre ambientes; se elimina por
-- nombre canonico o, en su defecto, por definicion (lista de valores sin AUDIT).
DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.count_entries'::regclass
                 AND c.conname = 'chk_inventarios_counts_capture_source') THEN
        ALTER TABLE inventarios.count_entries DROP CONSTRAINT chk_inventarios_counts_capture_source;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.count_entries'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%MOBILE%'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%WEB%'
          AND pg_catalog.pg_get_constraintdef(c.oid) NOT LIKE '%AUDIT%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.count_entries DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.count_entries
    ADD CONSTRAINT chk_inventarios_counts_capture_source
    CHECK (capture_source IN ('MOBILE','WEB','AUDIT'));

-- Regla de identidad: un count AUDIT no puede fingir participante ni heredar recount;
-- los demas orígenes no pueden usar audit_result_id.
ALTER TABLE inventarios.count_entries
    ADD CONSTRAINT chk_inventarios_counts_audit_identity
    CHECK (
        (capture_source = 'AUDIT' AND session_participant_id IS NULL
         AND recount_request_id IS NULL AND audit_result_id IS NOT NULL)
        OR (capture_source <> 'AUDIT' AND audit_result_id IS NULL
            AND session_participant_id IS NOT NULL)
    );

-- ============================================================
-- 1. MODELO: RESOLUCION ADMINISTRATIVA (por producto, items por ubicacion)
-- ============================================================

-- 1.1 Cabecera de resolucion por producto auditado.
CREATE TABLE inventarios.inventory_audit_resolutions (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
    reason text,
    resolved_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    resolved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    supersedes_resolution_id uuid,
    superseded_at timestamptz,
    superseded_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    total_audited numeric(14,3),
    item_count integer,
    synthetic_count_entry_count integer,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz,
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_resolutions_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_resolutions_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolutions_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolutions_supersedes
        FOREIGN KEY (supersedes_resolution_id)
        REFERENCES inventarios.inventory_audit_resolutions(id) ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_audit_resolutions_reason
        CHECK (decision <> 'REJECTED' OR (reason IS NOT NULL AND pg_catalog.btrim(reason) <> '')),
    CONSTRAINT chk_inventarios_audit_resolutions_supersede
        CHECK (
            (supersedes_resolution_id IS NULL AND superseded_at IS NULL AND superseded_by IS NULL)
            OR (supersedes_resolution_id IS NOT NULL AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL)
        ),
    CONSTRAINT chk_inventarios_audit_resolutions_not_self
        CHECK (supersedes_resolution_id IS NULL OR supersedes_resolution_id <> id)
);

COMMENT ON TABLE inventarios.inventory_audit_resolutions IS
    'Resolucion administrativa vigente por producto auditado (APPROVED o REJECTED). APPROVED reemplaza el efectivo de las ubicaciones auditadas; REJECTED no altera el fisico.';

CREATE UNIQUE INDEX uq_inventarios_audit_resolutions_current_product
    ON inventarios.inventory_audit_resolutions (company_id, audit_product_id)
    WHERE superseded_at IS NULL;

ALTER TABLE inventarios.inventory_audit_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_resolutions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_resolutions TO service_role;

-- 1.2 Items de resolucion por ubicacion auditada (uno por audited location).
CREATE TABLE inventarios.inventory_audit_resolution_items (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    resolution_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    audit_location_id uuid NOT NULL,
    audit_result_id uuid NOT NULL,
    -- Contexto de anclaje resuelto de forma unica y contractual.
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    task_id uuid,
    task_cycle integer,
    snapshot_location_id uuid,
    synthetic_count_entry_id uuid,
    audited_quantity numeric(14,3) NOT NULL,
    replaced_physical_quantity numeric(14,3) NOT NULL DEFAULT 0,
    delta numeric(14,3) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_resolution_items_resolution
        FOREIGN KEY (resolution_id)
        REFERENCES inventarios.inventory_audit_resolutions(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_items_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_items_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_items_location
        FOREIGN KEY (audit_location_id)
        REFERENCES inventarios.inventory_audit_locations(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_items_result
        FOREIGN KEY (audit_result_id)
        REFERENCES inventarios.inventory_audit_results(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_resolution_items_synthetic
        FOREIGN KEY (synthetic_count_entry_id)
        REFERENCES inventarios.count_entries(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_audit_resolution_items_resolution_location
        UNIQUE (company_id, resolution_id, audit_location_id),
    CONSTRAINT uq_inventarios_audit_resolution_items_synthetic
        UNIQUE (company_id, synthetic_count_entry_id),
    CONSTRAINT chk_inventarios_audit_resolution_items_quantity
        CHECK (audited_quantity >= 0 AND replaced_physical_quantity >= 0),
    CONSTRAINT chk_inventarios_audit_resolution_items_delta
        CHECK (delta = audited_quantity - replaced_physical_quantity),
    CONSTRAINT chk_inventarios_audit_resolution_items_context
        CHECK (
            synthetic_count_entry_id IS NULL
            OR (session_id IS NOT NULL AND snapshot_id IS NOT NULL
                AND session_zone_id IS NOT NULL AND task_id IS NOT NULL
                AND task_cycle IS NOT NULL AND snapshot_location_id IS NOT NULL)
        )
);

COMMENT ON TABLE inventarios.inventory_audit_resolution_items IS
    'Reemplazo por ubicacion auditada: identifica el audit_result, el contexto de anclaje unico y el count_entry sintetico AUDIT que sustituye el resultado efectivo de esa ubicacion.';

CREATE INDEX idx_inventarios_audit_resolution_items_product
    ON inventarios.inventory_audit_resolution_items (company_id, audit_product_id);

ALTER TABLE inventarios.inventory_audit_resolution_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_resolution_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_resolution_items TO service_role;

-- 1.3 Manifest normalizado: contribuciones efectivas que dejan de aportar, por item.
CREATE TABLE inventarios.inventory_audit_resolution_replaced_contributions (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    resolution_id uuid NOT NULL,
    item_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    replaced_count_entry_id uuid NOT NULL,
    replaced_source text NOT NULL CHECK (replaced_source IN ('NORMAL','RECOUNT','AUDIT')),
    root_count_entry_id uuid,
    recount_request_id uuid,
    recount_decision_id uuid,
    session_zone_id uuid,
    task_id uuid,
    task_cycle integer,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_audit_resolution_replaced_resolution
        FOREIGN KEY (resolution_id)
        REFERENCES inventarios.inventory_audit_resolutions(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_replaced_item
        FOREIGN KEY (item_id)
        REFERENCES inventarios.inventory_audit_resolution_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_replaced_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_replaced_count
        FOREIGN KEY (replaced_count_entry_id)
        REFERENCES inventarios.count_entries(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_audit_resolution_replaced_item_entry
        UNIQUE (company_id, item_id, replaced_count_entry_id)
);

COMMENT ON TABLE inventarios.inventory_audit_resolution_replaced_contributions IS
    'Manifest exacto por item: cada contribucion efectiva (NORMAL/RECOUNT/AUDIT) reemplazada por id. Nunca un scope amplio.';

CREATE INDEX idx_inventarios_audit_resolution_replaced_entry
    ON inventarios.inventory_audit_resolution_replaced_contributions (company_id, replaced_count_entry_id);

ALTER TABLE inventarios.inventory_audit_resolution_replaced_contributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_resolution_replaced_contributions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_resolution_replaced_contributions TO service_role;

-- 1.4 Eventos append-only de resolucion.
CREATE TABLE inventarios.inventory_audit_resolution_events (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    audit_id uuid NOT NULL,
    audit_product_id uuid NOT NULL,
    decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
    reason text,
    previous_status text NOT NULL,
    next_status text NOT NULL,
    resolution_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    resolved_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    resolved_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT fk_inventarios_audit_resolution_events_audit
        FOREIGN KEY (audit_id)
        REFERENCES inventarios.inventory_audits(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_events_product
        FOREIGN KEY (audit_product_id)
        REFERENCES inventarios.inventory_audit_products(id) ON DELETE CASCADE,
    CONSTRAINT fk_inventarios_audit_resolution_events_resolution
        FOREIGN KEY (resolution_id)
        REFERENCES inventarios.inventory_audit_resolutions(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_audit_resolution_events_key
        UNIQUE (company_id, idempotency_key)
);

ALTER TABLE inventarios.inventory_audit_resolution_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inventarios.inventory_audit_resolution_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inventarios.inventory_audit_resolution_events TO service_role;

-- ============================================================
-- 2. inventory_audits: estado agregado + trazabilidad de escritura
-- ============================================================

ALTER TABLE inventarios.inventory_audits
    ADD COLUMN updated_at timestamptz;

ALTER TABLE inventarios.inventory_audits
    ADD COLUMN updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT;

ALTER TABLE inventarios.inventory_audit_products
    ADD COLUMN updated_at timestamptz;

ALTER TABLE inventarios.inventory_audit_products
    ADD COLUMN updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT;

-- Estado padre agregado determinista:
--   todos CANCELLED -> CANCELLED
--   terminales + no terminales -> PARTIALLY_RESOLVED
--   todos APPROVED -> APPROVED ; todos REJECTED -> REJECTED ; otra mezcla terminal -> RESOLVED
--   ningun terminal -> operacional (PENDING/ASSIGNED/IN_PROGRESS/SUBMITTED)
-- Nombre del CHECK de estado variable entre ambientes; se elimina por nombre canonico
-- o, en su defecto, por definicion (lista de estados).
DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
                 AND c.conname = 'chk_inventarios_audits_status') THEN
        ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT chk_inventarios_audits_status;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%SUBMITTED%'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%CANCELLED%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.inventory_audits
    ADD CONSTRAINT chk_inventarios_audits_status
    CHECK (status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED',
                      'APPROVED','REJECTED','PARTIALLY_RESOLVED','RESOLVED','CANCELLED'));

-- El CHECK de submitted_by exigia status='SUBMITTED', incompatible con el estado agregado
-- (PARTIALLY_RESOLVED/RESOLVED/APPROVED/REJECTED conservan submitted_at tras el envio).
-- Se relaja conservando la trazabilidad (submitted_at requiere submitted_by).
DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
                 AND c.conname = 'chk_inventarios_audits_submitted_by') THEN
        ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT chk_inventarios_audits_submitted_by;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.inventory_audits'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%submitted_by%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.inventory_audits DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.inventory_audits
    ADD CONSTRAINT chk_inventarios_audits_submitted_by
    CHECK (submitted_at IS NULL OR submitted_by IS NOT NULL);

-- ============================================================
-- 3. HELPER: GUARD DE RESOLUCION (SUPER_USUARIO o ADMINISTRATOR activo)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._inventarios_require_audit_resolver(
    p_company_id uuid,
    p_campaign_id uuid
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_role_name text;
BEGIN
    IF p_company_id IS NULL OR p_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    v_actor_id := inventarios.require_company_access(p_company_id);

    SELECT r.name INTO v_role_name
    FROM portal.users u
    JOIN portal.roles r ON r.id = u.role_id
    WHERE u.id = v_actor_id AND u.is_active = true;
    IF coalesce(v_role_name, '') = 'SUPER_USUARIO' THEN
        RETURN v_actor_id;
    END IF;

    IF EXISTS (
        SELECT 1 FROM inventarios.inventory_campaign_participants icp
        WHERE icp.company_id = p_company_id
          AND icp.campaign_id = p_campaign_id
          AND icp.user_id = v_actor_id
          AND icp.participant_role = 'ADMINISTRATOR'
          AND icp.active_from <= pg_catalog.now()
          AND icp.revoked_at IS NULL
    ) THEN
        RETURN v_actor_id;
    END IF;

    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_PERMISSION_REQUIRED',
        DETAIL=pg_catalog.jsonb_build_object('message','No tienes el permiso requerido para resolver esta auditoría.','retryable',false)::text;
END;
$function$;

ALTER FUNCTION inventarios._inventarios_require_audit_resolver(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_require_audit_resolver(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_require_audit_resolver(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 4. HELPER: RECALCULO DEL ESTADO AGREGADO DE LA AUDITORIA
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._inventarios_audit_refresh_parent_status(
    p_company_id uuid,
    p_audit_id uuid,
    p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_total bigint;
    v_approved bigint;
    v_rejected bigint;
    v_cancelled bigint;
    v_nonterminal bigint;
    v_submitted bigint;
    v_in_progress bigint;
    v_assigned bigint;
    v_pending bigint;
    v_status text;
    v_now timestamptz := pg_catalog.now();
BEGIN
    SELECT pg_catalog.count(*),
           pg_catalog.count(*) FILTER (WHERE status = 'APPROVED'),
           pg_catalog.count(*) FILTER (WHERE status = 'REJECTED'),
           pg_catalog.count(*) FILTER (WHERE status = 'CANCELLED'),
           pg_catalog.count(*) FILTER (WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED')),
           pg_catalog.count(*) FILTER (WHERE status = 'SUBMITTED'),
           pg_catalog.count(*) FILTER (WHERE status = 'IN_PROGRESS'),
           pg_catalog.count(*) FILTER (WHERE status = 'ASSIGNED'),
           pg_catalog.count(*) FILTER (WHERE status = 'PENDING')
    INTO v_total, v_approved, v_rejected, v_cancelled, v_nonterminal,
         v_submitted, v_in_progress, v_assigned, v_pending
    FROM inventarios.inventory_audit_products
    WHERE company_id = p_company_id AND audit_id = p_audit_id;

    IF v_total = 0 OR v_total IS NULL THEN
        RETURN;
    END IF;

    IF v_nonterminal = 0 THEN
        -- Todos terminales.
        IF v_cancelled = v_total THEN
            v_status := 'CANCELLED';
        ELSIF v_approved = v_total THEN
            v_status := 'APPROVED';
        ELSIF v_rejected = v_total THEN
            v_status := 'REJECTED';
        ELSE
            v_status := 'RESOLVED';
        END IF;
    ELSIF v_approved > 0 OR v_rejected > 0 OR v_cancelled > 0 THEN
        -- Terminales + no terminales.
        v_status := 'PARTIALLY_RESOLVED';
    ELSE
        -- Ningun terminal: estado operacional.
        IF v_submitted = v_total THEN
            v_status := 'SUBMITTED';
        ELSIF v_in_progress > 0 THEN
            v_status := 'IN_PROGRESS';
        ELSIF v_assigned > 0 THEN
            v_status := 'ASSIGNED';
        ELSE
            v_status := 'PENDING';
        END IF;
    END IF;

    UPDATE inventarios.inventory_audits
    SET status = v_status,
        approved_at = CASE WHEN v_status = 'APPROVED' THEN v_now ELSE approved_at END,
        approved_by = CASE WHEN v_status = 'APPROVED' THEN p_actor_id ELSE approved_by END,
        rejected_at = CASE WHEN v_status = 'REJECTED' THEN v_now ELSE rejected_at END,
        rejected_by = CASE WHEN v_status = 'REJECTED' THEN p_actor_id ELSE rejected_by END,
        rejection_reason = CASE WHEN v_status = 'REJECTED'
                                AND (rejection_reason IS NULL OR pg_catalog.btrim(rejection_reason) = '')
                                THEN 'TODOS_LOS_PRODUCTOS_RECHAZADOS' ELSE rejection_reason END,
        updated_at = v_now,
        updated_by = p_actor_id
    WHERE company_id = p_company_id AND id = p_audit_id;
END;
$function$;

ALTER FUNCTION inventarios._inventarios_audit_refresh_parent_status(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_audit_refresh_parent_status(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_audit_refresh_parent_status(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 5. HELPER: SCOPE DE RESOLUCION POR UBICACION (manifest + anclaje unico)
--    Manifest = contribuciones efectivas actuales del (producto, ubicacion) en su sesion.
--    Anclaje: contexto del primario (menor captured_at, desempate por id). Sin previa:
--    contexto unico resoluble contractualmente; si no, NO_CONTEXT / AMBIGUOUS_CONTEXT.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._inventarios_audit_resolution_scope(
    p_company_id uuid,
    p_audit_location_id uuid,
    p_bsale_variant_id integer
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_session_id uuid;
    v_snapshot_location_id uuid;
    v_manifest jsonb := '[]'::jsonb;
    v_replaced_physical numeric := 0;
    v_ctx_count bigint := 0;
    v_anchor jsonb := NULL;
    v_error text := NULL;
    v_error_detail text := NULL;
    v_snapshot_id uuid;
    v_zone_id uuid;
    v_task_id uuid;
    v_task_cycle integer;
    v_snapshot_product_id uuid;
    v_zone_count bigint;
    v_task_count bigint;
    v_sp_count bigint;
    v_primary_snapshot_id uuid;
    v_primary_zone_id uuid;
    v_primary_task_id uuid;
    v_primary_cycle integer;
    v_primary_location_id uuid;
    v_primary_product_id uuid;
    v_primary_rec_request uuid;
    v_primary_rec_decision uuid;
    v_primary_root uuid;
    v_row record;
BEGIN
    SELECT l.session_id, l.snapshot_location_id
    INTO v_session_id, v_snapshot_location_id
    FROM inventarios.inventory_audit_locations l
    WHERE l.company_id = p_company_id AND l.id = p_audit_location_id;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest','[]'::jsonb, 'replaced_physical', 0::numeric,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación de auditoría no existe.');
    END IF;

    -- 1) Manifest: contribuciones efectivas actuales del (producto, ubicacion).
    IF v_session_id IS NOT NULL THEN
        WITH contribs AS (
            SELECT g.contribution_count_entry_id, g.contribution_source, g.root_count_entry_id,
                   g.recount_request_id, g.recount_decision_id, g.task_id, g.task_cycle,
                   g.session_id, g.session_zone_id, g.snapshot_id, g.snapshot_location_id,
                   g.snapshot_product_id,
                   ce.captured_at, ce.physical_quantity
            FROM inventarios.tasks t
            CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, v_session_id, t.id) g
            JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
            WHERE t.company_id = p_company_id AND t.session_id = v_session_id
              AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
              AND ce.bsale_variant_id = p_bsale_variant_id
              AND ce.snapshot_location_id IS NOT DISTINCT FROM v_snapshot_location_id
        )
        SELECT
            CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                 ELSE pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'contribution_count_entry_id', c.contribution_count_entry_id,
                        'source', c.contribution_source,
                        'root_count_entry_id', c.root_count_entry_id,
                        'recount_request_id', c.recount_request_id,
                        'recount_decision_id', c.recount_decision_id,
                        'task_id', c.task_id,
                        'task_cycle', c.task_cycle,
                        'session_zone_id', c.session_zone_id,
                        'snapshot_id', c.snapshot_id,
                        'snapshot_location_id', c.snapshot_location_id,
                        'snapshot_product_id', c.snapshot_product_id,
                        'captured_at', c.captured_at,
                        'physical_quantity', c.physical_quantity
                    ) ORDER BY c.captured_at, c.contribution_count_entry_id)
            END,
            coalesce(pg_catalog.sum(c.physical_quantity), 0),
            pg_catalog.count(DISTINCT c.session_id || '|' || c.snapshot_id || '|'
                             || c.session_zone_id || '|' || c.snapshot_location_id)
        INTO v_manifest, v_replaced_physical, v_ctx_count
        FROM contribs c;
    END IF;

    IF jsonb_array_length(v_manifest) > 0 THEN
        -- Los reemplazados deben compartir un unico contexto de ubicacion.
        IF v_ctx_count > 1 THEN
            RETURN pg_catalog.jsonb_build_object(
                'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
                'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
                'error_detail', 'Las contribuciones reemplazadas abarcan más de un contexto de ubicación.');
        END IF;
        v_primary_task_id := (v_manifest->0->>'task_id')::uuid;
        v_primary_cycle := (v_manifest->0->>'task_cycle')::integer;
        v_primary_snapshot_id := (v_manifest->0->>'snapshot_id')::uuid;
        v_primary_zone_id := (v_manifest->0->>'session_zone_id')::uuid;
        v_primary_location_id := (v_manifest->0->>'snapshot_location_id')::uuid;
        v_primary_product_id := (v_manifest->0->>'snapshot_product_id')::uuid;
        v_anchor := pg_catalog.jsonb_build_object(
            'session_id', v_session_id,
            'snapshot_id', v_primary_snapshot_id,
            'session_zone_id', v_primary_zone_id,
            'task_id', v_primary_task_id,
            'task_cycle', v_primary_cycle,
            'snapshot_location_id', v_primary_location_id,
            'snapshot_product_id', v_primary_product_id);
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', v_anchor, 'error', NULL::text);
    END IF;

    -- 2) Manifest vacio: resolver contexto unico contractual (sin inferencia arbitraria).
    IF v_session_id IS NULL OR v_snapshot_location_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación no tiene sesión ni snapshot_location para anclar el conteo sintético.');
    END IF;

    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = v_session_id;
    IF v_snapshot_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La sesión no tiene snapshot operacional.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(szl.session_zone_id)
    INTO v_zone_count, v_zone_id
    FROM inventarios.session_zone_locations szl
    WHERE szl.company_id = p_company_id AND szl.session_id = v_session_id
      AND szl.snapshot_id = v_snapshot_id AND szl.snapshot_location_id = v_snapshot_location_id;
    IF v_zone_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La ubicación no pertenece a una zona del snapshot.');
    END IF;
    IF v_zone_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'La ubicación pertenece a más de una zona del snapshot.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(t.id), pg_catalog.min(t.validation_cycle)
    INTO v_task_count, v_task_id, v_task_cycle
    FROM inventarios.tasks t
    WHERE t.company_id = p_company_id AND t.session_id = v_session_id
      AND t.session_zone_id = v_zone_id AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL;
    IF v_task_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'La zona no tiene tareas activas.');
    END IF;
    IF v_task_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'La zona tiene más de una tarea activa.');
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.min(sp.id)
    INTO v_sp_count, v_snapshot_product_id
    FROM inventarios.snapshot_products sp
    WHERE sp.company_id = p_company_id AND sp.snapshot_id = v_snapshot_id
      AND sp.bsale_variant_id = p_bsale_variant_id;
    IF v_sp_count = 0 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'NO_CONTEXT',
            'error_detail', 'El producto no existe en el snapshot de la sesión.');
    END IF;
    IF v_sp_count > 1 THEN
        RETURN pg_catalog.jsonb_build_object(
            'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
            'anchor', NULL::jsonb, 'error', 'AMBIGUOUS_CONTEXT',
            'error_detail', 'El producto tiene más de un registro en el snapshot.');
    END IF;

    v_anchor := pg_catalog.jsonb_build_object(
        'session_id', v_session_id,
        'snapshot_id', v_snapshot_id,
        'session_zone_id', v_zone_id,
        'task_id', v_task_id,
        'task_cycle', v_task_cycle,
        'snapshot_location_id', v_snapshot_location_id,
        'snapshot_product_id', v_snapshot_product_id);
    RETURN pg_catalog.jsonb_build_object(
        'manifest', v_manifest, 'replaced_physical', v_replaced_physical,
        'anchor', v_anchor, 'error', NULL::text);
END;
$function$;

ALTER FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_audit_resolution_scope(uuid, uuid, integer) TO authenticated, service_role;

-- ============================================================
-- 6. get_effective_count_entries: los counts AUDIT no son raices
--    (el overlay AUDIT vive en la capa de contribuciones, igual que RECOUNT).
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_effective_count_entries(
    p_company_id uuid,
    p_session_id uuid,
    p_task_id uuid,
    p_recount_request_id uuid
)
RETURNS TABLE (
    root_count_entry_id uuid,
    effective_count_entry_id uuid,
    company_id uuid,
    session_id uuid,
    snapshot_id uuid,
    session_zone_id uuid,
    snapshot_location_id uuid,
    snapshot_product_id uuid,
    task_id uuid,
    task_cycle integer,
    recount_request_id uuid
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
    END IF;
    IF p_task_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
    END IF;
    IF p_recount_request_id IS NOT NULL THEN
        PERFORM 1 FROM inventarios.recount_requests rr
        WHERE rr.company_id = p_company_id AND rr.session_id = p_session_id AND rr.id = p_recount_request_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
                DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text;
        END IF;
        IF p_task_id IS NOT NULL THEN
            PERFORM 1 FROM inventarios.recount_requests rr
            WHERE rr.id = p_recount_request_id AND rr.source_task_id = p_task_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
                    DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
            END IF;
        END IF;
    END IF;
    PERFORM 1 FROM (
        SELECT 1 FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id AND ce.session_id = p_session_id
          AND (p_task_id IS NULL OR ce.task_id = p_task_id)
          AND (
              (p_recount_request_id IS NULL AND ce.recount_request_id IS NULL)
              OR (p_recount_request_id IS NOT NULL AND ce.recount_request_id = p_recount_request_id)
          )
          AND (
              (ce.invalidated_at IS NULL AND ce.invalidated_by IS NOT NULL)
              OR (ce.invalidated_at IS NOT NULL AND ce.invalidated_by IS NULL)
              OR (ce.invalidated_at IS NULL AND ce.invalidation_reason IS NOT NULL)
              OR (ce.invalidated_at IS NOT NULL AND ce.invalidation_reason IS NULL)
              OR (ce.invalidated_by IS NULL AND ce.invalidation_reason IS NOT NULL)
              OR (ce.invalidated_by IS NOT NULL AND ce.invalidation_reason IS NULL)
          )
        LIMIT 1
    ) partial;
    IF FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    RETURN QUERY
    WITH scope_entries AS (
        SELECT ce.id, ce.company_id, ce.session_id, ce.snapshot_id, ce.session_zone_id,
               ce.snapshot_location_id, ce.snapshot_product_id, ce.task_id, ce.task_cycle,
               ce.recount_request_id,
               ce.physical_quantity, ce.available_quantity, ce.damaged_quantity,
               ce.expired_quantity, ce.blocked_quantity, ce.other_unavailable_quantity,
               ce.invalidated_at, ce.invalidated_by, ce.invalidation_reason
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.session_id = p_session_id
          AND (p_task_id IS NULL OR ce.task_id = p_task_id)
          AND (
              (p_recount_request_id IS NULL AND ce.recount_request_id IS NULL)
              OR (p_recount_request_id IS NOT NULL AND ce.recount_request_id = p_recount_request_id)
          )
          AND ce.capture_source <> 'AUDIT'
    ),
    roots AS (
        SELECT se.*
        FROM scope_entries se
        WHERE NOT EXISTS (
            SELECT 1 FROM inventarios.count_entry_corrections cec
            WHERE cec.company_id = p_company_id AND cec.replacement_count_entry_id = se.id
        )
    ),
    active_corrections AS (
        SELECT cec.root_count_entry_id, cec.replacement_count_entry_id
        FROM inventarios.count_entry_corrections cec
        WHERE cec.company_id = p_company_id
          AND cec.superseded_at IS NULL
          AND cec.root_count_entry_id IN (SELECT r.id FROM roots r)
    ),
    candidates AS (
        SELECT r.id AS root_id,
               COALESCE(ac.replacement_count_entry_id, r.id) AS candidate_id,
               r.company_id, r.session_id, r.snapshot_id, r.session_zone_id,
               r.snapshot_location_id, r.snapshot_product_id,
               r.task_id, r.task_cycle, r.recount_request_id
        FROM roots r
        LEFT JOIN active_corrections ac ON ac.root_count_entry_id = r.id
    ),
    validated AS (
        SELECT c.root_id, c.candidate_id, c.company_id, c.session_id, c.snapshot_id,
               c.session_zone_id, c.snapshot_location_id, c.snapshot_product_id,
               c.task_id, c.task_cycle, c.recount_request_id
        FROM candidates c
        JOIN inventarios.count_entries ce ON ce.id = c.candidate_id AND ce.company_id = p_company_id
        WHERE ce.invalidated_at IS NULL
          AND ce.invalidated_by IS NULL
          AND ce.invalidation_reason IS NULL
          AND ce.session_id = c.session_id
          AND ce.snapshot_id = c.snapshot_id
          AND ce.session_zone_id = c.session_zone_id
          AND ce.snapshot_location_id = c.snapshot_location_id
          AND ce.snapshot_product_id = c.snapshot_product_id
          AND ce.task_id = c.task_id
          AND ce.task_cycle = c.task_cycle
          AND ce.recount_request_id IS NOT DISTINCT FROM c.recount_request_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity
              + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
    )
    SELECT v.root_id, v.candidate_id, v.company_id, v.session_id, v.snapshot_id,
           v.session_zone_id, v.snapshot_location_id, v.snapshot_product_id,
           v.task_id, v.task_cycle, v.recount_request_id
    FROM validated v
    ORDER BY v.task_id, v.task_cycle, v.session_zone_id, v.snapshot_product_id, v.root_id;
END;
$function$;

ALTER FUNCTION inventarios.get_effective_count_entries(uuid, uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_effective_count_entries(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- 7. get_effective_task_contributions: OVERLAY AUDIT
--    Precedencia AUDIT > RECOUNT > NORMAL solo en el scope exacto reemplazado.
--    normal_counts / recount_contributions se filtran SOLO por id (manifest).
--    Un RECOUNT posterior no desplaza un AUDIT aprobado.
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.get_effective_task_contributions(p_company_id uuid, p_session_id uuid, p_task_id uuid)
 RETURNS TABLE(contribution_count_entry_id uuid, contribution_source text, root_count_entry_id uuid, recount_request_id uuid, recount_decision_id uuid, company_id uuid, session_id uuid, snapshot_id uuid, session_zone_id uuid, snapshot_location_id uuid, snapshot_product_id uuid, task_id uuid, task_cycle integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_cancelled_at timestamptz;
    v_cancelled_by uuid;
BEGIN
    IF p_company_id IS NULL OR p_session_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    PERFORM 1 FROM inventarios.sessions s WHERE s.company_id = p_company_id AND s.id = p_session_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    SELECT t.cancelled_at, t.cancelled_by INTO v_cancelled_at, v_cancelled_by
    FROM inventarios.tasks t WHERE t.company_id = p_company_id AND t.session_id = p_session_id AND t.id = p_task_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
        DETAIL=pg_catalog.jsonb_build_object('message','El recurso solicitado no existe.','retryable',false)::text; END IF;
    IF (v_cancelled_at IS NULL AND v_cancelled_by IS NOT NULL)
       OR (v_cancelled_at IS NOT NULL AND v_cancelled_by IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',false)::text;
    END IF;
    IF v_cancelled_at IS NOT NULL AND v_cancelled_by IS NOT NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH task_info AS (
        SELECT t.validation_cycle FROM inventarios.tasks t
        WHERE t.id = p_task_id
    ),
    audit_replaced_ids AS (
        SELECT rc.replaced_count_entry_id
        FROM inventarios.inventory_audit_resolution_replaced_contributions rc
        WHERE rc.company_id = p_company_id
    ),
    approved_audit_scopes AS (
        SELECT DISTINCT i.session_id, i.session_zone_id, ce.snapshot_product_id
        FROM inventarios.inventory_audit_resolution_items i
        JOIN inventarios.inventory_audit_resolutions r ON r.id = i.resolution_id
        JOIN inventarios.count_entries ce ON ce.id = i.synthetic_count_entry_id
        WHERE r.company_id = p_company_id AND r.decision = 'APPROVED' AND r.superseded_at IS NULL
          AND i.session_id IS NOT NULL AND i.synthetic_count_entry_id IS NOT NULL
    ),
    normal_counts AS (
        SELECT ec.effective_count_entry_id AS contribution_count_entry_id,
               'NORMAL'::text AS source,
               ec.root_count_entry_id, ec.recount_request_id,
               NULL::uuid AS recount_decision_id,
               ec.company_id, ec.session_id, ec.snapshot_id, ec.session_zone_id,
               ec.snapshot_location_id, ec.snapshot_product_id,
               ec.task_id, ec.task_cycle
        FROM inventarios.get_effective_count_entries(p_company_id, p_session_id, p_task_id, NULL) ec
        JOIN task_info ti ON ec.task_cycle = ti.validation_cycle
    ),
    recount_scopes AS (
        SELECT rd.recount_request_id, rd.recount_decision_id,
               rd.selected_count_entry_id, rd.selected_root_count_entry_id,
               rd.session_zone_id, rd.snapshot_product_id,
               rd.source_task_id, rd.task_cycle,
               rd.session_id, rd.snapshot_id, rd.snapshot_location_id
        FROM inventarios.get_applicable_recount_decisions(p_company_id, p_session_id, p_task_id) rd
    ),
    replaced_scopes AS (
        SELECT DISTINCT rs.session_zone_id, rs.snapshot_product_id, rs.task_cycle
        FROM recount_scopes rs
    ),
    filtered_normal AS (
        SELECT nc.* FROM normal_counts nc
        WHERE NOT EXISTS (
            SELECT 1 FROM replaced_scopes rs
            WHERE rs.session_zone_id = nc.session_zone_id
              AND rs.snapshot_product_id = nc.snapshot_product_id
              AND rs.task_cycle = nc.task_cycle
        )
          AND NOT EXISTS (
              SELECT 1 FROM audit_replaced_ids ar
              WHERE ar.replaced_count_entry_id = nc.contribution_count_entry_id
          )
    ),
    recount_contributions AS (
        SELECT rs.selected_count_entry_id AS contribution_count_entry_id,
               'RECOUNT'::text AS source,
               rs.selected_root_count_entry_id AS root_count_entry_id,
               rs.recount_request_id, rs.recount_decision_id,
               p_company_id, rs.session_id, rs.snapshot_id, rs.session_zone_id,
               rs.snapshot_location_id, rs.snapshot_product_id,
               rs.source_task_id AS task_id, rs.task_cycle
        FROM recount_scopes rs
        WHERE NOT EXISTS (
            SELECT 1 FROM audit_replaced_ids ar
            WHERE ar.replaced_count_entry_id = rs.selected_count_entry_id
        )
          AND NOT EXISTS (
              SELECT 1 FROM approved_audit_scopes aas
              WHERE aas.session_id = rs.session_id
                AND aas.session_zone_id = rs.session_zone_id
                AND aas.snapshot_product_id = rs.snapshot_product_id
          )
    ),
    audit_contributions AS (
        SELECT ce.id AS contribution_count_entry_id,
               'AUDIT'::text AS source,
               ce.id AS root_count_entry_id,
               NULL::uuid AS recount_request_id,
               NULL::uuid AS recount_decision_id,
               ce.company_id, ce.session_id, ce.snapshot_id, ce.session_zone_id,
               ce.snapshot_location_id, ce.snapshot_product_id,
               ce.task_id, ce.task_cycle
        FROM inventarios.count_entries ce
        WHERE ce.company_id = p_company_id
          AND ce.capture_source = 'AUDIT'
          AND ce.task_id = p_task_id
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM audit_replaced_ids ar
              WHERE ar.replaced_count_entry_id = ce.id
          )
    ),
    combined AS (
        SELECT * FROM filtered_normal
        UNION ALL
        SELECT * FROM recount_contributions
        UNION ALL
        SELECT * FROM audit_contributions
    )
    SELECT c.contribution_count_entry_id, c.source, c.root_count_entry_id,
           c.recount_request_id, c.recount_decision_id,
           c.company_id, c.session_id, c.snapshot_id, c.session_zone_id,
           c.snapshot_location_id, c.snapshot_product_id,
           c.task_id, c.task_cycle
    FROM combined c
    WHERE EXISTS (
        SELECT 1 FROM inventarios.count_entries ce WHERE ce.id = c.contribution_count_entry_id
          AND ce.company_id = p_company_id
          AND ce.physical_quantity = ce.available_quantity + ce.damaged_quantity + ce.expired_quantity + ce.blocked_quantity + ce.other_unavailable_quantity
          AND ce.invalidated_at IS NULL AND ce.invalidated_by IS NULL AND ce.invalidation_reason IS NULL
    )
    ORDER BY c.task_cycle, c.session_zone_id, c.snapshot_product_id, c.source, c.root_count_entry_id, c.contribution_count_entry_id;
END;
$function$;

ALTER FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.get_effective_task_contributions(uuid, uuid, uuid) TO authenticated;

-- ============================================================
-- 8. official_versions: soporte de contribuciones AUDIT y encadenamiento
-- ============================================================

-- 8.1 Conteos: permite contribuciones AUDIT (normal + recount <= total) sin perder trazabilidad (manifest).
-- Los nombres de estos CHECK varian entre ambientes (chk_official_versions_counts /
-- chk_official_items_cnt); se eliminan por nombre canonico o por definicion.
DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.official_versions'::regclass
                 AND c.conname = 'chk_official_versions_counts') THEN
        ALTER TABLE inventarios.official_versions DROP CONSTRAINT chk_official_versions_counts;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.official_versions'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%recount_contribution_count%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.official_versions DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.official_versions
    ADD CONSTRAINT chk_official_versions_counts CHECK (
        task_count >= 1 AND contribution_count >= 1
        AND normal_contribution_count >= 0 AND recount_contribution_count >= 0
        AND normal_contribution_count + recount_contribution_count <= contribution_count
        AND item_count >= 1
    );

DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.official_version_items'::regclass
                 AND c.conname = 'chk_official_items_counts') THEN
        ALTER TABLE inventarios.official_version_items DROP CONSTRAINT chk_official_items_counts;
    ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                  WHERE c.conrelid = 'inventarios.official_version_items'::regclass
                    AND c.conname = 'chk_official_items_cnt') THEN
        ALTER TABLE inventarios.official_version_items DROP CONSTRAINT chk_official_items_cnt;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.official_version_items'::regclass
          AND c.contype = 'c'
          AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%recount_contribution_count%'
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.official_version_items DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.official_version_items
    ADD CONSTRAINT chk_official_items_counts CHECK (
        contribution_count >= 1 AND normal_contribution_count >= 0 AND recount_contribution_count >= 0
        AND normal_contribution_count + recount_contribution_count <= contribution_count
    );

-- 8.2 Supersede diferido: permite marcar la version vigente como superseded apuntando a la
--     nueva version (aun no insertada) dentro de la misma transaccion.
-- Se elimina la FK auto-referencial existente (nombre variable) y se recrea DEFERRABLE.
DO $$
DECLARE
    v_con text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
               WHERE c.conrelid = 'inventarios.official_versions'::regclass
                 AND c.conname = 'fk_official_versions_supersedes') THEN
        ALTER TABLE inventarios.official_versions DROP CONSTRAINT fk_official_versions_supersedes;
    ELSE
        SELECT c.conname INTO v_con
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'inventarios.official_versions'::regclass
          AND c.contype = 'f'
          AND c.confrelid = 'inventarios.official_versions'::regclass
          AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = 'inventarios.official_versions'::regclass
                                  AND a.attname = 'supersedes_version_id')]
        ORDER BY c.conname
        LIMIT 1;
        IF v_con IS NOT NULL THEN
            EXECUTE pg_catalog.format('ALTER TABLE inventarios.official_versions DROP CONSTRAINT %I', v_con);
        END IF;
    END IF;
END;
$$;

ALTER TABLE inventarios.official_versions
    ADD CONSTRAINT fk_official_versions_supersedes
    FOREIGN KEY (supersedes_version_id)
    REFERENCES inventarios.official_versions(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- 8.3 Reconsolidacion de una session APPROVED afectada por un APPROVE de auditoria.
--     Genera una NUEVA official_version encadenada; la anterior nunca se muta.
CREATE OR REPLACE FUNCTION inventarios._consolidate_session_official(
    p_company_id uuid,
    p_session_id uuid,
    p_actor_id uuid
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_session_status text;
    v_snapshot_id uuid;
    v_current_id uuid;
    v_version integer;
    v_new_id uuid;
    v_approved_at timestamptz := pg_catalog.now();
    v_task_count bigint := 0;
    v_cc bigint := 0;
    v_nc bigint := 0;
    v_rc bigint := 0;
    v_ic bigint := 0;
    v_task_row record;
    v_contrib_row record;
    v_prod_key text;
    v_prod jsonb;
    v_manifest jsonb;
    v_products jsonb := '[]'::jsonb;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios._consolidate_session_official'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_session_id::text));

    SELECT s.status INTO v_session_status
    FROM inventarios.sessions s
    WHERE s.company_id = p_company_id AND s.id = p_session_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_session_status <> 'APPROVED' THEN
        RETURN NULL;
    END IF;

    SELECT os.id INTO v_snapshot_id
    FROM inventarios.operational_snapshots os
    WHERE os.company_id = p_company_id AND os.session_id = p_session_id;
    IF v_snapshot_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT id INTO v_current_id
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id
      AND ov.superseded_at IS NULL
    ORDER BY ov.version_number DESC
    LIMIT 1;
    IF v_current_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(pg_catalog.max(version_number), 0) + 1
    INTO v_version
    FROM inventarios.official_versions ov
    WHERE ov.company_id = p_company_id AND ov.session_id = p_session_id;

    v_new_id := pg_catalog.gen_random_uuid();

    -- Calcular los aportes efectivos ANTES de escribir (los CHECKS exigen counts >= 1).
    FOR v_task_row IN
        SELECT t.id FROM inventarios.tasks t
        WHERE t.company_id = p_company_id AND t.session_id = p_session_id
          AND t.cancelled_at IS NULL AND t.cancelled_by IS NULL
        ORDER BY t.id
    LOOP
        v_task_count := v_task_count + 1;
        FOR v_contrib_row IN
            SELECT ec.contribution_count_entry_id, ec.contribution_source,
                   ec.root_count_entry_id, ec.recount_request_id, ec.recount_decision_id,
                   ec.snapshot_product_id, ec.snapshot_id, ec.session_zone_id,
                   ec.task_id, ec.task_cycle,
                   ce.bsale_variant_id,
                   ce.available_quantity, ce.damaged_quantity, ce.expired_quantity,
                   ce.blocked_quantity, ce.other_unavailable_quantity, ce.physical_quantity
            FROM inventarios.get_effective_task_contributions(p_company_id, p_session_id, v_task_row.id) ec
            JOIN inventarios.count_entries ce ON ce.id = ec.contribution_count_entry_id
            ORDER BY ec.task_id, ec.task_cycle, ec.session_zone_id,
                     ec.contribution_source, ec.root_count_entry_id, ec.contribution_count_entry_id
        LOOP
            v_cc := v_cc + 1;
            IF v_contrib_row.contribution_source = 'NORMAL' THEN v_nc := v_nc + 1; END IF;
            IF v_contrib_row.contribution_source = 'RECOUNT' THEN v_rc := v_rc + 1; END IF;

            v_prod_key := v_contrib_row.snapshot_product_id::text;
            v_prod := NULL;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products)
            WHERE value->>'key' = v_prod_key;
            IF v_prod IS NULL THEN
                v_prod := pg_catalog.jsonb_build_object(
                    'key', v_prod_key, 'snapshot_product_id', v_contrib_row.snapshot_product_id,
                    'snapshot_id', v_contrib_row.snapshot_id,
                    'bsale_variant_id', v_contrib_row.bsale_variant_id,
                    'available_quantity', 0, 'damaged_quantity', 0, 'expired_quantity', 0,
                    'blocked_quantity', 0, 'other_unavailable_quantity', 0,
                    'physical_quantity', 0, 'contribution_count', 0,
                    'normal_contribution_count', 0, 'recount_contribution_count', 0,
                    'manifest', '[]'::jsonb);
                v_products := v_products || v_prod;
            END IF;
            SELECT value INTO v_prod FROM jsonb_array_elements(v_products)
            WHERE value->>'key' = v_prod_key;
            v_prod := v_prod || pg_catalog.jsonb_build_object(
                'available_quantity', (v_prod->>'available_quantity')::numeric + v_contrib_row.available_quantity,
                'damaged_quantity', (v_prod->>'damaged_quantity')::numeric + v_contrib_row.damaged_quantity,
                'expired_quantity', (v_prod->>'expired_quantity')::numeric + v_contrib_row.expired_quantity,
                'blocked_quantity', (v_prod->>'blocked_quantity')::numeric + v_contrib_row.blocked_quantity,
                'other_unavailable_quantity', (v_prod->>'other_unavailable_quantity')::numeric + v_contrib_row.other_unavailable_quantity,
                'physical_quantity', (v_prod->>'physical_quantity')::numeric + v_contrib_row.physical_quantity,
                'contribution_count', (v_prod->>'contribution_count')::integer + 1,
                'normal_contribution_count', (v_prod->>'normal_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'NORMAL' THEN 1 ELSE 0 END,
                'recount_contribution_count', (v_prod->>'recount_contribution_count')::integer + CASE WHEN v_contrib_row.contribution_source = 'RECOUNT' THEN 1 ELSE 0 END
            );
            v_manifest := v_prod->'manifest';
            v_manifest := v_manifest || pg_catalog.jsonb_build_object(
                'contribution_count_entry_id', v_contrib_row.contribution_count_entry_id,
                'contribution_source', v_contrib_row.contribution_source,
                'root_count_entry_id', v_contrib_row.root_count_entry_id,
                'recount_request_id', v_contrib_row.recount_request_id,
                'recount_decision_id', v_contrib_row.recount_decision_id,
                'task_id', v_contrib_row.task_id,
                'task_cycle', v_contrib_row.task_cycle,
                'session_zone_id', v_contrib_row.session_zone_id
            );
            v_prod := v_prod || pg_catalog.jsonb_build_object('manifest', v_manifest);
            v_products := (
                SELECT pg_catalog.jsonb_agg(CASE WHEN elem->>'key' = v_prod_key THEN v_prod ELSE elem END ORDER BY elem->>'key')
                FROM pg_catalog.jsonb_array_elements(v_products) elem
            );
        END LOOP;
    END LOOP;

    IF v_cc = 0 OR pg_catalog.jsonb_array_length(v_products) = 0 THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_NOT_CONSOLIDATED',
            DETAIL=pg_catalog.jsonb_build_object('message','La sesión no tiene contribuciones efectivas para reconsolidar.','retryable',false)::text;
    END IF;

    -- Marcar la vigente como superseded (FK diferida: la nueva aun no existe).
    UPDATE inventarios.official_versions
    SET superseded_at = v_approved_at,
        superseded_by = p_actor_id,
        supersedes_version_id = v_new_id
    WHERE id = v_current_id AND superseded_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_CONCURRENT_MODIFICATION',
            DETAIL=pg_catalog.jsonb_build_object('message','Se detecto una modificacion concurrente.','retryable',true)::text;
    END IF;

    INSERT INTO inventarios.official_versions (
        id, company_id, session_id, snapshot_id, version_number, task_count,
        contribution_count, normal_contribution_count, recount_contribution_count,
        item_count, approved_at, approved_by, supersedes_version_id,
        superseded_at, superseded_by, created_at, created_by
    )
    VALUES (
        v_new_id, p_company_id, p_session_id, v_snapshot_id, v_version,
        v_task_count, v_cc, v_nc, v_rc,
        pg_catalog.jsonb_array_length(v_products),
        v_approved_at, p_actor_id, NULL, NULL, NULL,
        v_approved_at, p_actor_id
    );

    v_ic := 0;
    FOR v_prod IN SELECT value FROM pg_catalog.jsonb_array_elements(v_products) ORDER BY (value->>'key') LOOP
        INSERT INTO inventarios.official_version_items (
            company_id, official_version_id, session_id, snapshot_id, snapshot_product_id,
            bsale_variant_id, available_quantity, damaged_quantity, expired_quantity,
            blocked_quantity, other_unavailable_quantity, physical_quantity,
            contribution_count, normal_contribution_count, recount_contribution_count,
            contribution_manifest, created_at, created_by
        )
        VALUES (
            p_company_id, v_new_id, p_session_id,
            (v_prod->>'snapshot_id')::uuid, (v_prod->>'snapshot_product_id')::uuid,
            (v_prod->>'bsale_variant_id')::integer,
            (v_prod->>'available_quantity')::numeric, (v_prod->>'damaged_quantity')::numeric,
            (v_prod->>'expired_quantity')::numeric, (v_prod->>'blocked_quantity')::numeric,
            (v_prod->>'other_unavailable_quantity')::numeric, (v_prod->>'physical_quantity')::numeric,
            (v_prod->>'contribution_count')::integer,
            (v_prod->>'normal_contribution_count')::integer,
            (v_prod->>'recount_contribution_count')::integer,
            v_prod->'manifest', v_approved_at, p_actor_id
        );
        v_ic := v_ic + 1;
    END LOOP;

    UPDATE inventarios.official_versions
    SET item_count = v_ic
    WHERE id = v_new_id;

    RETURN v_new_id;
END;
$function$;

ALTER FUNCTION inventarios._consolidate_session_official(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._consolidate_session_official(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._consolidate_session_official(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 9. RPC: RESOLVER PRODUCTO AUDITADO (APPROVE / REJECT)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.resolve_inventory_audit_product(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_product_id uuid,
    p_decision text,
    p_reason text DEFAULT NULL,
    p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_decision text;
    v_reason text;
    v_operation jsonb;
    v_operation_id uuid;
    v_payload jsonb;
    v_occurred_at timestamptz := pg_catalog.now();
    v_campaign_id uuid;
    v_campaign_status text;
    v_product_status text;
    v_scope_status text;
    v_variant integer;
    v_resolution_id uuid;
    v_event_id uuid;
    v_item_count integer := 0;
    v_synthetic_count integer := 0;
    v_total_audited numeric := 0;
    v_loc record;
    v_result record;
    v_scope jsonb;
    v_anchor jsonb;
    v_error text;
    v_count_entry_id uuid;
    v_item_id uuid;
    v_replaced_physical numeric;
    v_many jsonb;
    v_sess_status text;
    v_affected_official_id uuid;
    v_sessions uuid[] := '{}'::uuid[];
    v_session uuid;
    v_response jsonb;
    v_new_version jsonb := NULL;
BEGIN
    v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
    v_reason := pg_catalog.btrim(coalesce(p_reason, ''));
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_audit_product_id IS NULL
       OR p_idempotency_key IS NULL OR v_decision NOT IN ('APPROVE','REJECT') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;
    IF v_decision = 'REJECT' AND (pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 1000) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','El motivo del rechazo debe tener entre 5 y 1000 caracteres.','retryable',false)::text;
    END IF;

    SELECT a.campaign_id INTO v_campaign_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios._inventarios_require_audit_resolver(p_company_id, v_campaign_id);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resolve_inventory_audit_product.idempotency'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_idempotency_key::text));
    v_payload := pg_catalog.jsonb_build_object(
        'operation','inventarios.audit.resolve','company_id',p_company_id,
        'audit_id',p_audit_id,'audit_product_id',p_audit_product_id,
        'decision',v_decision,'reason',v_reason);
    v_operation := inventarios.begin_idempotent_operation(
        p_company_id,'inventarios.audit.resolve',p_idempotency_key,
        inventarios.compute_request_hash(v_payload));
    IF v_operation ->> 'mode' = 'REPLAY' THEN RETURN v_operation -> 'response_payload'; END IF;
    v_operation_id := (v_operation ->> 'operation_id')::uuid;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('inventarios.resolve_inventory_audit_product'),
        pg_catalog.hashtext(p_company_id::text || ':' || p_audit_product_id::text));

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = v_campaign_id
    FOR UPDATE;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;
    IF v_campaign_status NOT IN ('IN_PROGRESS','UNDER_REVIEW') THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_SESSION_INVALID_STATE',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no admite la resolución de auditorías en su estado actual.','retryable',false,'status',v_campaign_status)::text;
    END IF;

    SELECT ap.status, ap.scope_status, ap.bsale_variant_id
    INTO v_product_status, v_scope_status, v_variant
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id AND ap.id = p_audit_product_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no pertenece a la auditoría.','retryable',false)::text;
    END IF;
    IF v_product_status <> 'SUBMITTED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_ALREADY_RESOLVED',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto auditado no está pendiente de decisión.','retryable',false,'status',v_product_status)::text;
    END IF;
    IF v_scope_status <> 'LOCATIONS_RESOLVED' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_SCOPE_UNSUPPORTED',
            DETAIL=pg_catalog.jsonb_build_object('message','Este producto sin ubicación previa aún no admite resolución administrativa.','retryable',false)::text;
    END IF;

    -- ---------- REJECT ----------
    IF v_decision = 'REJECT' THEN
        INSERT INTO inventarios.inventory_audit_resolutions (
            company_id, campaign_id, audit_id, audit_product_id, decision, reason,
            resolved_by, resolved_at, item_count, created_by, updated_at, updated_by
        )
        VALUES (
            p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'REJECTED', v_reason,
            v_actor_id, v_occurred_at, 0, v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_resolution_id;

        INSERT INTO inventarios.inventory_audit_resolution_events (
            company_id, campaign_id, audit_id, audit_product_id, decision, reason,
            previous_status, next_status, resolution_id, idempotency_key,
            resolved_by, resolved_at, created_by
        )
        VALUES (
            p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'REJECT', v_reason,
            v_product_status, 'REJECTED', v_resolution_id, p_idempotency_key,
            v_actor_id, v_occurred_at, v_actor_id
        )
        RETURNING id INTO v_event_id;

        UPDATE inventarios.inventory_audit_products
        SET status = 'REJECTED', updated_at = v_occurred_at, updated_by = v_actor_id
        WHERE company_id = p_company_id AND id = p_audit_product_id;

        PERFORM inventarios._inventarios_audit_refresh_parent_status(p_company_id, p_audit_id, v_actor_id);

        v_response := pg_catalog.jsonb_build_object(
            'operation','inventarios.audit.resolve',
            'entity_id', v_resolution_id,
            'state','REJECTED',
            'version', NULL::integer,
            'cycle_number', NULL::integer,
            'assignment_id', NULL::uuid,
            'event_id', v_event_id,
            'replayed', false,
            'occurred_at', v_occurred_at,
            'data', pg_catalog.jsonb_build_object(
                'audit_id', p_audit_id,
                'audit_product_id', p_audit_product_id,
                'decision', 'REJECTED',
                'reason', v_reason,
                'resolved_by', v_actor_id,
                'resolved_at', v_occurred_at,
                'physical_unchanged', true,
                'affected_official_versions', '[]'::jsonb
            )
        );
        RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_resolution_id, v_response);
    END IF;

    -- ---------- APPROVE ----------
    INSERT INTO inventarios.inventory_audit_resolutions (
        company_id, campaign_id, audit_id, audit_product_id, decision, reason,
        resolved_by, resolved_at, total_audited, item_count, synthetic_count_entry_count,
        created_by, updated_at, updated_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'APPROVED', v_reason,
        v_actor_id, v_occurred_at, 0, 0, 0, v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_resolution_id;

    FOR v_loc IN
        SELECT l.id
        FROM inventarios.inventory_audit_locations l
        WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
          AND l.audit_product_id = p_audit_product_id
        ORDER BY l.location_code, l.id
    LOOP
        SELECT r.id, r.physical_quantity, r.audited_by, r.captured_at,
               r.identification_method, r.scanned_code
        INTO v_result
        FROM inventarios.inventory_audit_results r
        WHERE r.company_id = p_company_id
          AND r.audit_product_id = p_audit_product_id
          AND r.audit_location_id = v_loc.id;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_RESOLUTION_INCOMPLETE',
                DETAIL=pg_catalog.jsonb_build_object('message','Faltan resultados auditados para resolver el producto.','retryable',false,'audit_location_id',v_loc.id)::text;
        END IF;

        v_scope := inventarios._inventarios_audit_resolution_scope(p_company_id, v_loc.id, v_variant);
        v_error := v_scope ->> 'error';
        IF v_error = 'NO_CONTEXT' OR v_error = 'AMBIGUOUS_CONTEXT' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',
                MESSAGE=CASE WHEN v_error = 'NO_CONTEXT' THEN 'INV_AUDIT_RESOLUTION_NO_CONTEXT'
                             ELSE 'INV_AUDIT_RESOLUTION_AMBIGUOUS_CONTEXT' END,
                DETAIL=pg_catalog.jsonb_build_object(
                    'message', coalesce(v_scope ->> 'error_detail', 'No se puede resolver el contexto del conteo sintético.'),
                    'retryable', false,
                    'audit_location_id', v_loc.id)::text;
        END IF;
        v_anchor := v_scope -> 'anchor';
        v_replaced_physical := (v_scope ->> 'replaced_physical')::numeric;

        INSERT INTO inventarios.count_entries (
            company_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
            session_participant_id, counted_by, snapshot_product_id, snapshot_location_id,
            bsale_variant_id, identification_method, scanned_code, capture_source,
            offline_id, device_id, captured_at, server_received_at, synced_at, synced_by,
            physical_quantity, available_quantity, damaged_quantity, expired_quantity,
            blocked_quantity, other_unavailable_quantity, recount_request_id,
            audit_result_id, created_by
        )
        VALUES (
            p_company_id, (v_anchor->>'session_id')::uuid, (v_anchor->>'snapshot_id')::uuid,
            (v_anchor->>'session_zone_id')::uuid, (v_anchor->>'task_id')::uuid,
            (v_anchor->>'task_cycle')::integer, NULL, v_result.audited_by,
            (v_anchor->>'snapshot_product_id')::uuid, (v_anchor->>'snapshot_location_id')::uuid,
            v_variant, v_result.identification_method, v_result.scanned_code, 'AUDIT',
            NULL, NULL, v_result.captured_at, v_occurred_at, NULL, NULL,
            v_result.physical_quantity, v_result.physical_quantity, 0, 0, 0, 0, NULL,
            v_result.id, v_actor_id
        )
        RETURNING id INTO v_count_entry_id;

        INSERT INTO inventarios.inventory_audit_resolution_items (
            company_id, resolution_id, audit_id, audit_product_id, audit_location_id,
            audit_result_id, session_id, snapshot_id, session_zone_id, task_id, task_cycle,
            snapshot_location_id, synthetic_count_entry_id, audited_quantity,
            replaced_physical_quantity, delta, created_by
        )
        VALUES (
            p_company_id, v_resolution_id, p_audit_id, p_audit_product_id, v_loc.id,
            v_result.id, (v_anchor->>'session_id')::uuid, (v_anchor->>'snapshot_id')::uuid,
            (v_anchor->>'session_zone_id')::uuid, (v_anchor->>'task_id')::uuid,
            (v_anchor->>'task_cycle')::integer, (v_anchor->>'snapshot_location_id')::uuid,
            v_count_entry_id, v_result.physical_quantity, v_replaced_physical,
            v_result.physical_quantity - v_replaced_physical, v_actor_id
        )
        RETURNING id INTO v_item_id;

        FOR v_many IN SELECT el.value FROM pg_catalog.jsonb_array_elements(v_scope -> 'manifest') el LOOP
            INSERT INTO inventarios.inventory_audit_resolution_replaced_contributions (
                company_id, resolution_id, item_id, audit_product_id, replaced_count_entry_id,
                replaced_source, root_count_entry_id, recount_request_id, recount_decision_id,
                session_zone_id, task_id, task_cycle, created_by
            )
            VALUES (
                p_company_id, v_resolution_id, v_item_id, p_audit_product_id,
                (v_many->>'contribution_count_entry_id')::uuid, v_many->>'source',
                (v_many->>'root_count_entry_id')::uuid,
                (v_many->>'recount_request_id')::uuid,
                (v_many->>'recount_decision_id')::uuid,
                (v_many->>'session_zone_id')::uuid,
                (v_many->>'task_id')::uuid,
                (v_many->>'task_cycle')::integer,
                v_actor_id
            );
        END LOOP;

        v_item_count := v_item_count + 1;
        v_synthetic_count := v_synthetic_count + 1;
        v_total_audited := v_total_audited + v_result.physical_quantity;

        v_session := (v_anchor->>'session_id')::uuid;
        IF v_session IS NOT NULL AND NOT (v_session = ANY(v_sessions)) THEN
            v_sessions := array_append(v_sessions, v_session);
        END IF;
    END LOOP;

    UPDATE inventarios.inventory_audit_resolutions
    SET total_audited = v_total_audited,
        item_count = v_item_count,
        synthetic_count_entry_count = v_synthetic_count,
        updated_at = v_occurred_at,
        updated_by = v_actor_id
    WHERE id = v_resolution_id;

    INSERT INTO inventarios.inventory_audit_resolution_events (
        company_id, campaign_id, audit_id, audit_product_id, decision, reason,
        previous_status, next_status, resolution_id, idempotency_key,
        resolved_by, resolved_at, created_by
    )
    VALUES (
        p_company_id, v_campaign_id, p_audit_id, p_audit_product_id, 'APPROVE', v_reason,
        v_product_status, 'APPROVED', v_resolution_id, p_idempotency_key,
        v_actor_id, v_occurred_at, v_actor_id
    )
    RETURNING id INTO v_event_id;

    UPDATE inventarios.inventory_audit_products
    SET status = 'APPROVED', updated_at = v_occurred_at, updated_by = v_actor_id
    WHERE company_id = p_company_id AND id = p_audit_product_id;

    PERFORM inventarios._inventarios_audit_refresh_parent_status(p_company_id, p_audit_id, v_actor_id);

    FOREACH v_session IN ARRAY v_sessions LOOP
        SELECT s.status INTO v_sess_status
        FROM inventarios.sessions s
        WHERE s.company_id = p_company_id AND s.id = v_session;
        IF v_sess_status = 'APPROVED' THEN
            v_affected_official_id := inventarios._consolidate_session_official(p_company_id, v_session, v_actor_id);
            IF v_affected_official_id IS NOT NULL THEN
                v_new_version := coalesce(v_new_version, '[]'::jsonb) || pg_catalog.jsonb_build_object(
                    'session_id', v_session,
                    'official_version_id', v_affected_official_id);
            END IF;
        END IF;
    END LOOP;

    v_response := pg_catalog.jsonb_build_object(
        'operation','inventarios.audit.resolve',
        'entity_id', v_resolution_id,
        'state','APPROVED',
        'version', NULL::integer,
        'cycle_number', NULL::integer,
        'assignment_id', NULL::uuid,
        'event_id', v_event_id,
        'replayed', false,
        'occurred_at', v_occurred_at,
        'data', pg_catalog.jsonb_build_object(
            'audit_id', p_audit_id,
            'audit_product_id', p_audit_product_id,
            'decision', 'APPROVED',
            'reason', v_reason,
            'resolution_id', v_resolution_id,
            'item_count', v_item_count,
            'synthetic_count_entry_count', v_synthetic_count,
            'total_audited', v_total_audited,
            'resolved_by', v_actor_id,
            'resolved_at', v_occurred_at,
            'affected_official_versions', coalesce(v_new_version, '[]'::jsonb)
        )
    );
    RETURN inventarios.complete_idempotent_operation(p_company_id, v_operation_id, v_resolution_id, v_response);
END;
$function$;

ALTER FUNCTION inventarios.resolve_inventory_audit_product(uuid, uuid, uuid, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.resolve_inventory_audit_product(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.resolve_inventory_audit_product(uuid, uuid, uuid, text, text, uuid) TO authenticated, service_role;

-- ============================================================
-- 10. RPC: PREVIEW DE RESOLUCION DE PRODUCTO (ERP)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios.preview_inventory_audit_product_resolution(
    p_company_id uuid,
    p_audit_id uuid,
    p_audit_product_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_campaign_id uuid;
    v_campaign_status text;
    v_audit_number integer;
    v_audit_status text;
    v_submitted_at timestamptz;
    v_submitted_by uuid;
    v_auditor_user_id uuid;
    v_auditor_name text;
    v_product_status text;
    v_scope_status text;
    v_variant integer;
    v_sku text;
    v_name text;
    v_snapshot_theoretical numeric;
    v_snapshot_physical numeric;
    v_snapshot_difference numeric;
    v_current_effective numeric := 0;
    v_audited_total numeric := 0;
    v_replaced_total numeric := 0;
    v_result_if_approved numeric := 0;
    v_locations jsonb := '[]'::jsonb;
    v_loc record;
    v_result record;
    v_scope jsonb;
    v_error text;
    v_loc_audited numeric;
    v_loc_replaced numeric;
    v_applicable boolean := true;
    v_reason text := NULL;
    v_loc_detail jsonb;
    v_manifest_ids jsonb;
BEGIN
    IF p_company_id IS NULL OR p_audit_id IS NULL OR p_audit_product_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_INVALID_REQUEST_PAYLOAD',
            DETAIL=pg_catalog.jsonb_build_object('message','La solicitud no tiene el formato requerido.','retryable',false)::text;
    END IF;

    v_actor_id := inventarios.require_permission(p_company_id, 'inventarios.campaigns.read');

    SELECT a.campaign_id, a.audit_number, a.status, a.submitted_at, a.submitted_by,
           a.assigned_user_id
    INTO v_campaign_id, v_audit_number, v_audit_status, v_submitted_at, v_submitted_by,
         v_auditor_user_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = p_company_id AND a.id = p_audit_id;
    IF v_campaign_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','La auditoría no existe.','retryable',false)::text;
    END IF;

    SELECT c.status INTO v_campaign_status
    FROM inventarios.inventory_campaigns c
    WHERE c.company_id = p_company_id AND c.id = v_campaign_id;
    IF v_campaign_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El inventario no existe.','retryable',false)::text;
    END IF;

    SELECT u.nombre INTO v_auditor_name
    FROM portal.users u WHERE u.id = v_auditor_user_id;

    SELECT ap.status, ap.scope_status, ap.bsale_variant_id, ap.sku, ap.name,
           ap.theoretical_quantity, ap.physical_quantity, ap.difference_quantity
    INTO v_product_status, v_scope_status, v_variant, v_sku, v_name,
         v_snapshot_theoretical, v_snapshot_physical, v_snapshot_difference
    FROM inventarios.inventory_audit_products ap
    WHERE ap.company_id = p_company_id AND ap.audit_id = p_audit_id AND ap.id = p_audit_product_id;
    IF v_variant IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='INV_AUDIT_PRODUCT_NOT_FOUND',
            DETAIL=pg_catalog.jsonb_build_object('message','El producto no pertenece a la auditoría.','retryable',false)::text;
    END IF;

    -- Efectivo actual del producto en el Inventario.
    WITH campaign_tasks AS (
        SELECT t.id AS task_id, t.session_id
        FROM inventarios.tasks t
        JOIN inventarios.sessions s ON s.company_id = t.company_id AND s.id = t.session_id
        WHERE s.company_id = p_company_id AND s.campaign_id = v_campaign_id
          AND t.cancelled_at IS NULL AND t.superseded_at IS NULL
    )
    SELECT coalesce(pg_catalog.sum(ce.physical_quantity), 0)
    INTO v_current_effective
    FROM campaign_tasks ct
    CROSS JOIN LATERAL inventarios.get_effective_task_contributions(p_company_id, ct.session_id, ct.task_id) g
    JOIN inventarios.count_entries ce ON ce.id = g.contribution_count_entry_id
    WHERE ce.bsale_variant_id = v_variant;

    FOR v_loc IN
        SELECT l.id
        FROM inventarios.inventory_audit_locations l
        WHERE l.company_id = p_company_id AND l.audit_id = p_audit_id
          AND l.audit_product_id = p_audit_product_id
        ORDER BY l.location_code, l.id
    LOOP
        SELECT r.id, r.physical_quantity, r.captured_at
        INTO v_result
        FROM inventarios.inventory_audit_results r
        WHERE r.company_id = p_company_id
          AND r.audit_product_id = p_audit_product_id
          AND r.audit_location_id = v_loc.id;
        IF NOT FOUND THEN
            v_loc_audited := NULL;
        ELSE
            v_loc_audited := v_result.physical_quantity;
        END IF;

        v_scope := inventarios._inventarios_audit_resolution_scope(p_company_id, v_loc.id, v_variant);
        v_error := v_scope ->> 'error';
        v_loc_replaced := (v_scope ->> 'replaced_physical')::numeric;
        v_manifest_ids := (
            SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                        ELSE pg_catalog.jsonb_agg(el->>'contribution_count_entry_id')
                   END
            FROM pg_catalog.jsonb_array_elements(v_scope -> 'manifest') el
        );

        IF v_loc_audited IS NULL AND v_applicable THEN
            v_applicable := false; v_reason := 'RESULTS_INCOMPLETE';
        END IF;
        IF v_error IS NOT NULL AND v_applicable THEN
            v_applicable := false; v_reason := v_error;
        END IF;

        IF v_loc_audited IS NOT NULL THEN
            v_audited_total := v_audited_total + v_loc_audited;
            v_replaced_total := v_replaced_total + v_loc_replaced;
        END IF;

        v_loc_detail := pg_catalog.jsonb_build_object(
            'audit_location_id', v_loc.id,
            'location_code', (SELECT l2.location_code FROM inventarios.inventory_audit_locations l2 WHERE l2.id = v_loc.id),
            'location_name', (SELECT l2.location_name FROM inventarios.inventory_audit_locations l2 WHERE l2.id = v_loc.id),
            'current_effective_quantity', v_loc_replaced,
            'audited_quantity', v_loc_audited,
            'delta', CASE WHEN v_loc_audited IS NULL THEN NULL::numeric ELSE v_loc_audited - v_loc_replaced END,
            'replaced_count_entry_ids', v_manifest_ids,
            'context_error', v_error
        );
        v_locations := v_locations || v_loc_detail;
    END LOOP;

    v_result_if_approved := v_current_effective - v_replaced_total + v_audited_total;

    IF v_applicable THEN
        IF v_campaign_status NOT IN ('IN_PROGRESS','UNDER_REVIEW') THEN
            v_applicable := false; v_reason := 'CAMPAIGN_STATE';
        ELSIF v_product_status = 'APPROVED' OR v_product_status = 'REJECTED' THEN
            v_applicable := false; v_reason := 'ALREADY_RESOLVED';
        ELSIF v_product_status <> 'SUBMITTED' THEN
            v_applicable := false; v_reason := 'PRODUCT_STATE';
        ELSIF v_scope_status <> 'LOCATIONS_RESOLVED' THEN
            v_applicable := false; v_reason := 'SCOPE_UNSUPPORTED';
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'company_id', p_company_id,
        'audit_id', p_audit_id,
        'audit_number', v_audit_number,
        'audit_status', v_audit_status,
        'campaign_id', v_campaign_id,
        'campaign_status', v_campaign_status,
        'audit_product_id', p_audit_product_id,
        'bsale_variant_id', v_variant,
        'sku', v_sku,
        'name', v_name,
        'product_status', v_product_status,
        'scope_status', v_scope_status,
        'snapshot', pg_catalog.jsonb_build_object(
            'theoretical_quantity', v_snapshot_theoretical,
            'physical_quantity', v_snapshot_physical,
            'difference_quantity', v_snapshot_difference
        ),
        'auditor', pg_catalog.jsonb_build_object(
            'user_id', v_auditor_user_id,
            'name', v_auditor_name
        ),
        'submitted_at', v_submitted_at,
        'current_effective_quantity', v_current_effective,
        'audited_total', v_audited_total,
        'delta', v_result_if_approved - v_current_effective,
        'result_if_approved', v_result_if_approved,
        'locations', v_locations,
        'applicable', v_applicable,
        'blocking_reason', v_reason
    );
END;
$function$;

ALTER FUNCTION inventarios.preview_inventory_audit_product_resolution(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.preview_inventory_audit_product_resolution(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.preview_inventory_audit_product_resolution(uuid, uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 11. CIERRE GLOBAL: terminalizar auditorias pendientes sin aplicarlas
--     (sin bloqueo; los no aprobados jamas entran al fisico final)
-- ============================================================
CREATE OR REPLACE FUNCTION inventarios._inventarios_campaign_close_terminalize_audits(
    p_company_id uuid,
    p_campaign_id uuid,
    p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_occurred_at timestamptz := pg_catalog.now();
    v_audit_row record;
BEGIN
    -- Productos no decididos: terminalizacion sin aplicarse (nunca entran al fisico).
    UPDATE inventarios.inventory_audit_products ap
    SET status = 'CANCELLED',
        updated_at = v_occurred_at,
        updated_by = p_actor_id
    FROM inventarios.inventory_audits a
    WHERE a.company_id = ap.company_id AND a.id = ap.audit_id
      AND a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND ap.status IN ('PENDING','ASSIGNED','IN_PROGRESS','SUBMITTED');

    -- Recalcular el estado agregado de cada auditoria de la campana.
    FOR v_audit_row IN
        SELECT a.id FROM inventarios.inventory_audits a
        WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
        ORDER BY a.id
    LOOP
        PERFORM inventarios._inventarios_audit_refresh_parent_status(p_company_id, v_audit_row.id, p_actor_id);
    END LOOP;

    -- Auditorias agregadas CANCELLED: rellenar la trazabilidad de cancelacion.
    UPDATE inventarios.inventory_audits a
    SET cancelled_at = v_occurred_at,
        cancelled_by = p_actor_id,
        cancellation_reason = 'CIERRE_ADMIN_GLOBAL',
        updated_at = v_occurred_at,
        updated_by = p_actor_id
    WHERE a.company_id = p_company_id AND a.campaign_id = p_campaign_id
      AND a.status = 'CANCELLED' AND a.cancelled_at IS NULL;
END;
$function$;

ALTER FUNCTION inventarios._inventarios_campaign_close_terminalize_audits(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._inventarios_campaign_close_terminalize_audits(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._inventarios_campaign_close_terminalize_audits(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION inventarios._trg_inventarios_campaign_close_terminalize_audits()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
    IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
        PERFORM inventarios._inventarios_campaign_close_terminalize_audits(
            NEW.company_id, NEW.id, coalesce(NEW.approved_by, NEW.updated_by));
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION inventarios._trg_inventarios_campaign_close_terminalize_audits() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios._trg_inventarios_campaign_close_terminalize_audits() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios._trg_inventarios_campaign_close_terminalize_audits() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_inventarios_campaign_close_audits ON inventarios.inventory_campaigns;

CREATE TRIGGER trg_inventarios_campaign_close_audits
AFTER UPDATE ON inventarios.inventory_campaigns
FOR EACH ROW
EXECUTE FUNCTION inventarios._trg_inventarios_campaign_close_terminalize_audits();

COMMIT;
