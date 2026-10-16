-- Bloque 2: RPCs auditables para excluir / revocar manualmente una Nota de Venta
-- del flujo de Preparacion/Bodega.
--
-- No modifican logistica.sales_order_preparation_cards (ni status, ni closed_at,
-- ni closure_reason). La tabla logistica.sales_order_preparation_exclusions es la
-- fuente primaria de auditoria. No se registran movimientos de tarjeta porque un
-- NV puede no tener tarjeta y la tabla de movimientos exige card_id.

-- ---------------------------------------------------------------------------
-- Helpers internos de autorizacion y actor (reutilizan el mecanismo real:
-- portal.roles.name, core.resolve_company_role_id, portal.is_super_usuario).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION logistica.preparation_exclusion_is_authorized(
    p_user_id uuid,
    p_company_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_role_id uuid;
    v_role_name text;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RETURN false;
    END IF;

    IF portal.is_super_usuario(p_user_id) THEN
        RETURN true;
    END IF;

    BEGIN
        v_role_id := core.resolve_company_role_id(p_user_id, p_company_id);
    EXCEPTION WHEN OTHERS THEN
        -- Fail-closed: un rol de empresa no mapeado nunca autoriza.
        RETURN false;
    END;

    IF v_role_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT r.name INTO v_role_name
    FROM portal.roles r
    WHERE r.id = v_role_id AND r.is_active = true;

    RETURN v_role_name IN ('SUPER_USUARIO', 'GERENCIA');
END;
$$;

REVOKE ALL ON FUNCTION logistica.preparation_exclusion_is_authorized(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.preparation_exclusion_is_authorized(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION logistica.preparation_exclusion_actor_name(
    p_user_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT nullif(btrim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')), '')
    FROM portal.users u
    WHERE u.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION logistica.preparation_exclusion_actor_name(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.preparation_exclusion_actor_name(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 1: excluir una NV (reversible, auditable).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION logistica.exclude_sales_order_preparation_nv(
    p_company_id uuid,
    p_bsale_nv_id bigint,
    p_reason text,
    p_observation text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_nv record;
    v_card record;
    v_existing_id uuid;
    v_row logistica.sales_order_preparation_exclusions%ROWTYPE;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.';
    END IF;

    IF p_company_id IS NULL OR p_bsale_nv_id IS NULL THEN
        RAISE EXCEPTION 'Parámetros obligatorios faltantes (company_id / bsale_nv_id).';
    END IF;

    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;

    IF NOT logistica.preparation_exclusion_is_authorized(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'No autorizado: se requiere rol SUPER_USUARIO o GERENCIA.';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'El motivo (reason) es obligatorio.';
    END IF;

    -- NV real desde datos sincronizados; el folio y el estado NO vienen del cliente.
    SELECT d.bsale_id, d.number, d.document_type_id, d.state
      INTO v_nv
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.bsale_id = p_bsale_nv_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Nota de venta % no encontrada para la empresa.', p_bsale_nv_id;
    END IF;

    IF v_nv.document_type_id IS DISTINCT FROM 23 THEN
        RAISE EXCEPTION 'El documento % no es una Nota de Venta (document_type_id=%).',
            p_bsale_nv_id, v_nv.document_type_id;
    END IF;

    IF v_nv.state = 1 THEN
        RAISE EXCEPTION 'La NV % está anulada en Bsale (state=1); no se puede excluir.', p_bsale_nv_id;
    END IF;

    IF v_nv.state = 8888 THEN
        RAISE EXCEPTION 'La NV % no es operativa en Bsale (state=8888); no se puede excluir.', p_bsale_nv_id;
    END IF;

    IF v_nv.state IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'La NV % no es operativa (state=%); no se puede excluir.', p_bsale_nv_id, v_nv.state;
    END IF;

    IF v_nv.number IS NULL THEN
        RAISE EXCEPTION 'La NV % no tiene folio registrado.', p_bsale_nv_id;
    END IF;

    -- Tarjeta activa (no CANCELLED). No se modifica.
    SELECT c.status, c.closed_at
      INTO v_card
    FROM logistica.sales_order_preparation_cards c
    WHERE c.company_id = p_company_id
      AND c.bsale_nv_id = p_bsale_nv_id
      AND c.status <> 'CANCELLED'
    ORDER BY (c.closed_at IS NULL) DESC, c.updated_at DESC NULLS LAST
    LIMIT 1;

    IF FOUND THEN
        IF v_card.closed_at IS NOT NULL THEN
            RAISE EXCEPTION 'La tarjeta de la NV % ya está cerrada; no se puede excluir.', p_bsale_nv_id;
        ELSIF v_card.status IN ('IN_PREPARATION', 'IN_AUDIT') THEN
            RAISE EXCEPTION 'La NV % está en %; primero debe volver a PENDING_ROUTE_PREP mediante el flujo existente.',
                p_bsale_nv_id, v_card.status;
        ELSIF v_card.status = 'INVOICED_READY_FOR_ROUTE' THEN
            RAISE EXCEPTION 'La NV % está en un estado terminal (%).', p_bsale_nv_id, v_card.status;
        ELSIF v_card.status <> 'PENDING_ROUTE_PREP' THEN
            RAISE EXCEPTION 'La tarjeta de la NV % está en un estado no permitido (%).',
                p_bsale_nv_id, v_card.status;
        END IF;
    END IF;

    SELECT e.id INTO v_existing_id
    FROM logistica.sales_order_preparation_exclusions e
    WHERE e.company_id = p_company_id
      AND e.bsale_nv_id = p_bsale_nv_id
      AND e.active = true
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', 'already_exists',
            'message', 'Ya existe una exclusión activa para esta NV.',
            'exclusion_id', v_existing_id
        );
    END IF;

    BEGIN
        INSERT INTO logistica.sales_order_preparation_exclusions (
            company_id, bsale_nv_id, nv_folio, reason, observation,
            excluded_by, excluded_by_name, excluded_at, active
        ) VALUES (
            p_company_id, p_bsale_nv_id, v_nv.number::text, btrim(p_reason), p_observation,
            v_actor, logistica.preparation_exclusion_actor_name(v_actor), now(), true
        )
        RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', 'already_exists',
            'message', 'Ya existe una exclusión activa para esta NV.'
        );
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'excluded',
        'id', v_row.id,
        'company_id', v_row.company_id,
        'bsale_nv_id', v_row.bsale_nv_id,
        'nv_folio', v_row.nv_folio,
        'reason', v_row.reason,
        'observation', v_row.observation,
        'excluded_by', v_row.excluded_by,
        'excluded_by_name', v_row.excluded_by_name,
        'excluded_at', v_row.excluded_at,
        'active', v_row.active
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.exclude_sales_order_preparation_nv(uuid, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.exclude_sales_order_preparation_nv(uuid, bigint, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RPC 2: revocar (logicamente) una exclusion activa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION logistica.revoke_sales_order_preparation_exclusion(
    p_company_id uuid,
    p_bsale_nv_id bigint,
    p_revoked_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_row logistica.sales_order_preparation_exclusions%ROWTYPE;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Usuario no autenticado.';
    END IF;

    IF p_company_id IS NULL OR p_bsale_nv_id IS NULL THEN
        RAISE EXCEPTION 'Parámetros obligatorios faltantes (company_id / bsale_nv_id).';
    END IF;

    IF NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;

    IF NOT logistica.preparation_exclusion_is_authorized(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'No autorizado: se requiere rol SUPER_USUARIO o GERENCIA.';
    END IF;

    IF p_revoked_reason IS NULL OR btrim(p_revoked_reason) = '' THEN
        RAISE EXCEPTION 'El motivo de revocación (revoked_reason) es obligatorio.';
    END IF;

    -- UPDATE condicional a active=true: bloquea la fila y evita carreras.
    UPDATE logistica.sales_order_preparation_exclusions e
    SET active = false,
        revoked_by = v_actor,
        revoked_by_name = logistica.preparation_exclusion_actor_name(v_actor),
        revoked_at = now(),
        revoked_reason = btrim(p_revoked_reason)
    WHERE e.company_id = p_company_id
      AND e.bsale_nv_id = p_bsale_nv_id
      AND e.active = true
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'ok', false,
            'status', 'not_found',
            'message', 'No existe una exclusión activa para esta NV.'
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'status', 'revoked',
        'id', v_row.id,
        'company_id', v_row.company_id,
        'bsale_nv_id', v_row.bsale_nv_id,
        'nv_folio', v_row.nv_folio,
        'reason', v_row.reason,
        'observation', v_row.observation,
        'excluded_by', v_row.excluded_by,
        'excluded_by_name', v_row.excluded_by_name,
        'excluded_at', v_row.excluded_at,
        'active', v_row.active,
        'revoked_by', v_row.revoked_by,
        'revoked_by_name', v_row.revoked_by_name,
        'revoked_at', v_row.revoked_at,
        'revoked_reason', v_row.revoked_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION logistica.revoke_sales_order_preparation_exclusion(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.revoke_sales_order_preparation_exclusion(uuid, bigint, text) TO authenticated, service_role;

COMMENT ON FUNCTION logistica.exclude_sales_order_preparation_nv(uuid, bigint, text, text) IS
    'Excluye administrativamente y de forma reversible una Nota de Venta del flujo de Preparacion. No modifica la tarjeta. Requiere rol SUPER_USUARIO o GERENCIA y acceso a la empresa.';
COMMENT ON FUNCTION logistica.revoke_sales_order_preparation_exclusion(uuid, bigint, text) IS
    'Revoca (logicamente) una exclusion activa de Nota de Venta. Conserva historial y no modifica la tarjeta. Requiere rol SUPER_USUARIO o GERENCIA y acceso a la empresa.';
