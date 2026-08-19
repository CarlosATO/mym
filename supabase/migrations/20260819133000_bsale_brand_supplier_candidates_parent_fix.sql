-- PROV-1C: resolve preferred BSALE_OPERATIVE mappings to their REAL parent.
-- This changes only the read-only candidate view; no supplier or mapping rows are changed.

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
             AND s.company_id = bp.company_id
             AND s.is_active = true
             AND s.status = 'ACTIVE' THEN s.id
            WHEN s.supplier_kind = 'BSALE_OPERATIVE'
             AND parent.company_id = bp.company_id
             AND parent.supplier_kind = 'REAL'
             AND parent.is_active = true
             AND parent.status = 'ACTIVE' THEN parent.id
            ELSE NULL
        END AS real_supplier_id
    FROM brand_products bp
    JOIN adquisiciones.product_supplier_mappings m
      ON m.product_id = bp.product_id
     AND m.company_id = bp.company_id
     AND m.is_active = true
     AND m.is_preferred = true
    LEFT JOIN adquisiciones.suppliers s ON s.id = m.supplier_id
    LEFT JOIN adquisiciones.suppliers parent ON parent.id = s.parent_supplier_id
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
    FROM real_counts
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
