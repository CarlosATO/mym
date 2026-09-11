-- Primer corte vertical del dominio Mermas.
-- Solo solicitudes operativas: no stock, ledger, Bsale write ni rendiciones.

CREATE SCHEMA IF NOT EXISTS mermas;
GRANT USAGE ON SCHEMA mermas TO authenticated, service_role;

CREATE TABLE mermas.request_correlatives (
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    request_year integer NOT NULL,
    next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
    PRIMARY KEY (company_id, request_year)
);

CREATE TABLE mermas.requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    request_code text NOT NULL,
    status text NOT NULL DEFAULT 'PENDIENTE' CHECK (status = 'PENDIENTE'),
    created_by uuid NOT NULL REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, request_code)
);

CREATE TABLE mermas.request_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES mermas.requests(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_variant_id integer NOT NULL,
    sku text NOT NULL,
    product_name text NOT NULL,
    variant_description text,
    quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    expiration_date date NOT NULL,
    lot text,
    observation text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mermas_requests_company_created_idx ON mermas.requests(company_id, created_at DESC);
CREATE INDEX mermas_requests_pending_idx ON mermas.requests(company_id, status) WHERE status = 'PENDIENTE';
CREATE INDEX mermas_request_lines_request_idx ON mermas.request_lines(request_id);
CREATE INDEX mermas_request_lines_variant_idx ON mermas.request_lines(company_id, bsale_variant_id);

ALTER TABLE mermas.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mermas.request_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY mermas_requests_select ON mermas.requests FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id)
      AND portal.has_permission('logistica.mermas.view'));
CREATE POLICY mermas_lines_select ON mermas.request_lines FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id)
      AND portal.has_permission('logistica.mermas.view'));

GRANT SELECT ON mermas.requests, mermas.request_lines TO authenticated;
GRANT ALL ON mermas.requests, mermas.request_lines, mermas.request_correlatives TO service_role;

INSERT INTO portal.permissions (code, name, description, module_id, is_active)
SELECT permission.code, permission.name, permission.description, m.id, true
FROM portal.modules m
CROSS JOIN (VALUES
  ('logistica.mermas.view', 'Ver Mermas', 'Consultar solicitudes de merma de la empresa activa.'),
  ('logistica.mermas.create', 'Crear solicitudes de Merma', 'Crear solicitudes de merma con sus líneas.'),
  ('logistica.mermas.pending.view', 'Gestionar pendientes de Merma', 'Visualizar el aviso de solicitudes pendientes para gestión Bsale.')
) AS permission(code, name, description)
WHERE m.code = 'logistica'
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, module_id = EXCLUDED.module_id, is_active = true;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA', 'BODEGA')
  AND p.code IN ('logistica.mermas.view', 'logistica.mermas.create')
  AND p.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM portal.roles r CROSS JOIN portal.permissions p
WHERE r.name IN ('SUPER_USUARIO', 'GERENCIA')
  AND p.code = 'logistica.mermas.pending.view'
  AND p.is_active
ON CONFLICT (role_id, permission_id) DO NOTHING;

CREATE OR REPLACE FUNCTION mermas.create_request(
    p_company_id uuid,
    p_user_id uuid,
    p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, integraciones, mermas
AS $$
DECLARE
    v_request_id uuid;
    v_code text;
    v_year integer := EXTRACT(YEAR FROM timezone('America/Santiago', now()))::integer;
    v_sequence bigint;
    v_line jsonb;
    v_variant record;
    v_quantity numeric;
    v_reason text;
    v_expiration date;
    v_line_count integer := 0;
BEGIN
    IF p_user_id IS NULL OR p_company_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud inválida';
    END IF;
    IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
        RAISE EXCEPTION 'Usuario inválido';
    END IF;
    IF NOT core.has_company_access(p_user_id, p_company_id) THEN
        RAISE EXCEPTION 'El usuario no tiene acceso a la empresa activa';
    END IF;
    IF NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.create') THEN
        RAISE EXCEPTION 'No autorizado para crear solicitudes de Merma';
    END IF;
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'La solicitud debe contener al menos una línea';
    END IF;

    INSERT INTO mermas.request_correlatives(company_id, request_year, next_value)
    VALUES (p_company_id, v_year, 2)
    ON CONFLICT (company_id, request_year)
    DO UPDATE SET next_value = mermas.request_correlatives.next_value + 1
    RETURNING next_value - 1 INTO v_sequence;

    v_code := 'MER-' || v_year::text || '-' || lpad(v_sequence::text, 6, '0');

    INSERT INTO mermas.requests(company_id, request_code, status, created_by)
    VALUES (p_company_id, v_code, 'PENDIENTE', p_user_id)
    RETURNING id INTO v_request_id;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
    LOOP
        SELECT bv.bsale_id, bv.code, bp.name, bv.description
        INTO v_variant
        FROM integraciones.bsale_variants bv
        JOIN integraciones.bsale_products bp
          ON bp.company_id = bv.company_id AND bp.bsale_id = bv.bsale_product_id
        WHERE bv.id = NULLIF(v_line->>'variant_id', '')::uuid
          AND bv.company_id = p_company_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Producto no encontrado en el catálogo Bsale de la empresa activa';
        END IF;
        v_quantity := NULLIF(v_line->>'quantity', '')::numeric;
        v_reason := btrim(COALESCE(v_line->>'reason', ''));
        v_expiration := NULLIF(v_line->>'expiration_date', '')::date;
        IF v_quantity IS NULL OR v_quantity <= 0 THEN RAISE EXCEPTION 'La cantidad debe ser mayor que cero'; END IF;
        IF v_reason = '' THEN RAISE EXCEPTION 'El motivo es obligatorio'; END IF;
        IF v_expiration IS NULL THEN RAISE EXCEPTION 'La fecha de vencimiento es obligatoria'; END IF;

        INSERT INTO mermas.request_lines (
            request_id, company_id, bsale_variant_id, sku, product_name, variant_description,
            quantity, reason, expiration_date, lot, observation
        ) VALUES (
            v_request_id, p_company_id, v_variant.bsale_id, COALESCE(v_variant.code, ''),
            COALESCE(v_variant.name, v_variant.code, 'Producto Bsale'), v_variant.description,
            v_quantity, v_reason, v_expiration, NULLIF(btrim(v_line->>'lot'), ''),
            NULLIF(btrim(v_line->>'observation'), '')
        );
        v_line_count := v_line_count + 1;
    END LOOP;

    INSERT INTO portal.audit_logs(table_name, record_id, action, new_data, performed_by)
    VALUES ('mermas.requests', v_request_id, 'CREATE', jsonb_build_object(
        'request_code', v_code, 'company_id', p_company_id, 'status', 'PENDIENTE', 'line_count', v_line_count
    ), p_user_id);

    RETURN jsonb_build_object('success', true, 'request_id', v_request_id, 'request_code', v_code, 'status', 'PENDIENTE');
END;
$$;

REVOKE ALL ON FUNCTION mermas.create_request(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.create_request(uuid, uuid, jsonb) TO service_role;
