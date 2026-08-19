-- PROV-1C: approved Bsale Brand -> REAL supplier links.
-- Candidates remain derived and are never inserted into this table automatically.

CREATE TABLE IF NOT EXISTS integraciones.bsale_brand_supplier_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    bsale_brand_id integer NOT NULL,
    supplier_id uuid NOT NULL REFERENCES adquisiciones.suppliers(id) ON DELETE RESTRICT,
    source text NOT NULL DEFAULT 'MANUAL',
    linked_at timestamptz NOT NULL DEFAULT now(),
    linked_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_bsale_brand_supplier_link_brand_positive CHECK (bsale_brand_id > 0),
    CONSTRAINT uq_bsale_brand_supplier_links_company_brand UNIQUE (company_id, bsale_brand_id),
    CONSTRAINT fk_bsale_brand_supplier_links_brand
        FOREIGN KEY (company_id, bsale_brand_id)
        REFERENCES integraciones.bsale_brands(company_id, bsale_brand_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bsale_brand_supplier_links_company_supplier
    ON integraciones.bsale_brand_supplier_links (company_id, supplier_id);

COMMENT ON TABLE integraciones.bsale_brand_supplier_links IS
    'Explicitly approved Bsale Brand to REAL PetGroup supplier links. Candidates are derived, not stored here.';

ALTER TABLE integraciones.bsale_brand_supplier_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE integraciones.bsale_brand_supplier_links FROM PUBLIC, anon;
GRANT SELECT ON TABLE integraciones.bsale_brand_supplier_links TO authenticated;
GRANT ALL ON TABLE integraciones.bsale_brand_supplier_links TO service_role;
GRANT SELECT ON TABLE integraciones.bsale_brands TO authenticated;

CREATE POLICY rls_bsale_brand_supplier_links_select
    ON integraciones.bsale_brand_supplier_links
    FOR SELECT TO authenticated
    USING (
        portal.has_permission('system.admin') OR (
            portal.has_permission('adquisiciones.suppliers.view')
            AND core.has_company_access(auth.uid(), company_id)
        )
    );

CREATE OR REPLACE VIEW integraciones.vw_bsale_brand_supplier_candidates
WITH (security_invoker = true) AS
WITH brand_products AS (
    SELECT
        b.company_id,
        b.bsale_brand_id,
        p.id AS product_id
    FROM integraciones.bsale_brands b
    JOIN adquisiciones.products p
      ON p.company_id = b.company_id
     AND p.bsale_brand_id = b.bsale_brand_id
     AND p.is_active = true
     AND p.source = 'BSALE'
), preferred_mappings AS (
    SELECT
        bp.company_id,
        bp.bsale_brand_id,
        bp.product_id,
        CASE
             WHEN s.supplier_kind = 'REAL'
              AND s.is_active = true
              AND s.status = 'ACTIVE' THEN s.id
            ELSE NULL
        END AS real_supplier_id
    FROM brand_products bp
    JOIN adquisiciones.product_supplier_mappings m
      ON m.product_id = bp.product_id
     AND m.company_id = bp.company_id
     AND m.is_active = true
     AND m.is_preferred = true
     LEFT JOIN adquisiciones.suppliers s ON s.id = m.supplier_id
 ), product_resolution AS (
    SELECT
        bp.company_id,
        bp.bsale_brand_id,
        bp.product_id,
        EXISTS (
            SELECT 1
            FROM preferred_mappings pm
            WHERE pm.company_id = bp.company_id
              AND pm.bsale_brand_id = bp.bsale_brand_id
              AND pm.product_id = bp.product_id
              AND pm.real_supplier_id IS NOT NULL
        ) AS has_preferred_real,
        false AS has_active_fallback_real
    FROM brand_products bp
), brand_counts AS (
    SELECT
        b.company_id,
        b.bsale_brand_id,
        count(pr.product_id)::integer AS active_products,
        count(pr.product_id) FILTER (WHERE pr.has_preferred_real)::integer AS resolved_preferred_products,
        count(pr.product_id) FILTER (WHERE NOT pr.has_preferred_real OR pr.product_id IS NULL)::integer AS unresolved_preferred_products,
        count(pr.product_id) FILTER (WHERE pr.has_active_fallback_real)::integer AS active_fallback_products
    FROM integraciones.bsale_brands b
    LEFT JOIN product_resolution pr
      ON pr.company_id = b.company_id
     AND pr.bsale_brand_id = b.bsale_brand_id
    GROUP BY b.company_id, b.bsale_brand_id
), real_counts AS (
    SELECT
        company_id,
        bsale_brand_id,
        real_supplier_id,
        count(DISTINCT product_id)::integer AS products_resolved
    FROM preferred_mappings
    WHERE real_supplier_id IS NOT NULL
    GROUP BY company_id, bsale_brand_id, real_supplier_id
), real_summary AS (
    SELECT
        company_id,
        bsale_brand_id,
        count(*)::integer AS real_supplier_count,
        (array_agg(real_supplier_id ORDER BY products_resolved DESC, real_supplier_id))[1] AS candidate_supplier_id
    FROM (
        SELECT
            rc.*,
            max(products_resolved) OVER (PARTITION BY company_id, bsale_brand_id) AS max_products
        FROM real_counts rc
    ) ranked
    GROUP BY company_id, bsale_brand_id
), approved AS (
    SELECT
        l.company_id,
        l.bsale_brand_id,
        l.id AS link_id,
        l.supplier_id AS linked_supplier_id,
        s.business_name AS linked_supplier_name,
        s.rut AS linked_supplier_rut,
        l.source AS linked_source,
        l.linked_at,
        l.linked_by
    FROM integraciones.bsale_brand_supplier_links l
    JOIN adquisiciones.suppliers s ON s.id = l.supplier_id
)
SELECT
    bc.company_id,
    bc.bsale_brand_id,
    bc.active_products,
    bc.resolved_preferred_products,
    bc.unresolved_preferred_products,
    bc.active_fallback_products,
    COALESCE(rs.real_supplier_count, 0)::integer AS real_supplier_count,
    CASE WHEN COALESCE(rs.real_supplier_count, 0) = 1 THEN rs.candidate_supplier_id ELSE NULL END AS candidate_supplier_id,
    CASE WHEN COALESCE(rs.real_supplier_count, 0) = 1 THEN candidate.business_name ELSE NULL END AS candidate_supplier_name,
    CASE WHEN COALESCE(rs.real_supplier_count, 0) = 1 THEN candidate.rut ELSE NULL END AS candidate_supplier_rut,
    CASE
        WHEN COALESCE(rs.real_supplier_count, 0) = 0 THEN 'SIN_RESOLVER'
        WHEN rs.real_supplier_count > 1 THEN 'MIXTO'
        WHEN bc.unresolved_preferred_products = 0 THEN 'INEQUIVOCO'
        ELSE 'CASI_INEQUIVOCO'
    END AS classification,
    a.link_id,
    a.linked_supplier_id,
    a.linked_supplier_name,
    a.linked_supplier_rut,
    a.linked_source,
    a.linked_at,
    a.linked_by,
    CASE
        WHEN a.link_id IS NOT NULL THEN 'LINKED'
        WHEN COALESCE(rs.real_supplier_count, 0) > 1 THEN 'CONFLICT'
        ELSE 'PENDING'
    END AS derived_status
FROM brand_counts bc
LEFT JOIN real_summary rs
  ON rs.company_id = bc.company_id
 AND rs.bsale_brand_id = bc.bsale_brand_id
LEFT JOIN adquisiciones.suppliers candidate ON candidate.id = rs.candidate_supplier_id
LEFT JOIN approved a
  ON a.company_id = bc.company_id
 AND a.bsale_brand_id = bc.bsale_brand_id;

GRANT SELECT ON integraciones.vw_bsale_brand_supplier_candidates TO authenticated, service_role;

CREATE OR REPLACE FUNCTION integraciones.link_bsale_brand_supplier(
    p_company_id uuid,
    p_bsale_brand_id integer,
    p_supplier_id uuid,
    p_source text DEFAULT 'MANUAL'
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_existing integraciones.bsale_brand_supplier_links%ROWTYPE;
    v_link integraciones.bsale_brand_supplier_links%ROWTYPE;
    v_supplier adquisiciones.suppliers%ROWTYPE;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.update')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;
    IF p_bsale_brand_id IS NULL OR p_bsale_brand_id <= 0 THEN RAISE EXCEPTION 'INVALID_BSALE_BRAND_ID'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM integraciones.bsale_brands b
        WHERE b.company_id = p_company_id AND b.bsale_brand_id = p_bsale_brand_id
    ) THEN RAISE EXCEPTION 'BRAND_NOT_DETECTED'; END IF;

    SELECT * INTO v_supplier
    FROM adquisiciones.suppliers
    WHERE id = p_supplier_id AND company_id = p_company_id
    FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_WRONG_COMPANY'; END IF;
    IF v_supplier.supplier_kind <> 'REAL' THEN RAISE EXCEPTION 'SUPPLIER_MUST_BE_REAL'; END IF;
    IF NOT v_supplier.is_active OR v_supplier.status <> 'ACTIVE' THEN RAISE EXCEPTION 'SUPPLIER_NOT_ACTIVE'; END IF;

    SELECT * INTO v_existing
    FROM integraciones.bsale_brand_supplier_links
    WHERE company_id = p_company_id AND bsale_brand_id = p_bsale_brand_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.supplier_id = p_supplier_id THEN
            RETURN jsonb_build_object('status', 'ALREADY_LINKED', 'link', to_jsonb(v_existing));
        END IF;
        RAISE EXCEPTION 'BRAND_ALREADY_LINKED_TO_ANOTHER_SUPPLIER';
    END IF;

    INSERT INTO integraciones.bsale_brand_supplier_links (
        company_id, bsale_brand_id, supplier_id, source, linked_at, linked_by
    ) VALUES (
        p_company_id, p_bsale_brand_id, p_supplier_id,
        COALESCE(NULLIF(pg_catalog.btrim(p_source), ''), 'MANUAL'),
        now(), v_actor
    ) RETURNING * INTO v_link;

    INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, new_data, performed_by)
    VALUES (
        'integraciones.bsale_brand_supplier_links', v_link.id, 'LINK', NULL,
        jsonb_build_object('company_id', p_company_id, 'bsale_brand_id', p_bsale_brand_id, 'supplier_id', p_supplier_id, 'source', v_link.source),
        v_actor
    );

    RETURN jsonb_build_object('status', 'LINKED', 'link', to_jsonb(v_link));
END;
$$;

CREATE OR REPLACE FUNCTION integraciones.unlink_bsale_brand_supplier(
    p_company_id uuid,
    p_bsale_brand_id integer
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, core, portal, integraciones, adquisiciones
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_link integraciones.bsale_brand_supplier_links%ROWTYPE;
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
    IF NOT (portal.has_permission('system.admin') OR portal.has_permission('adquisiciones.suppliers.update')) THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF NOT core.has_company_access(v_actor, p_company_id) THEN RAISE EXCEPTION 'COMPANY_ACCESS_DENIED'; END IF;

    SELECT * INTO v_link
    FROM integraciones.bsale_brand_supplier_links
    WHERE company_id = p_company_id AND bsale_brand_id = p_bsale_brand_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'NOT_LINKED'); END IF;

    DELETE FROM integraciones.bsale_brand_supplier_links WHERE id = v_link.id;
    INSERT INTO portal.audit_logs (table_name, record_id, action, old_data, new_data, performed_by)
    VALUES (
        'integraciones.bsale_brand_supplier_links', v_link.id, 'UNLINK', to_jsonb(v_link), NULL, v_actor
    );
    RETURN jsonb_build_object('status', 'UNLINKED', 'link_id', v_link.id);
END;
$$;

REVOKE ALL ON FUNCTION integraciones.link_bsale_brand_supplier(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION integraciones.unlink_bsale_brand_supplier(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION integraciones.link_bsale_brand_supplier(uuid, integer, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION integraciones.unlink_bsale_brand_supplier(uuid, integer) TO authenticated, service_role;
