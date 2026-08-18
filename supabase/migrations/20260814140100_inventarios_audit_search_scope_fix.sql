-- =========================================================================================
-- MIGRATION: M1.5F.2 fix - Recrea list_my_inventory_audits sin pg_catalog.min(uuid)
-- (min(uuid) no existe como agregado en pg_catalog; la version inicial fallaba en runtime
--  al resolver el search_scope de un producto NO_PREVIOUS_LOCATION).
-- Esquema afectado EXCLUSIVAMENTE: inventarios.
-- =========================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION inventarios.list_my_inventory_audits()
RETURNS jsonb
LANGUAGE plpgsql STABLE PARALLEL SAFE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
    v_actor_id uuid;
    v_audits jsonb;
BEGIN
    v_actor_id := inventarios.require_actor();

    SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
        ELSE pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'audit_id', t.id,
                'audit_number', t.audit_number,
                'status', t.status,
                'campaign_id', t.campaign_id,
                'campaign_name', t.campaign_name,
                'assigned_at', t.created_at,
                'product_count', t.product_count,
                'products', t.products
            ) ORDER BY t.audit_number
        )
    END
    INTO v_audits
    FROM (
        SELECT a.id, a.audit_number, a.status, a.campaign_id,
               ic.name AS campaign_name, a.created_at,
               (SELECT pg_catalog.count(*) FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS product_count,
               (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                    ELSE pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'audit_product_id', ap.id,
                            'bsale_variant_id', ap.bsale_variant_id,
                            'product_id', ap.product_id,
                            'sku', ap.sku,
                            'name', ap.name,
                            'barcode', ap.barcode,
                            'scope_status', ap.scope_status,
                            'locations', CASE WHEN ap.scope_status <> 'LOCATIONS_RESOLVED' THEN '[]'::jsonb
                                           ELSE (SELECT CASE WHEN pg_catalog.count(*) = 0 THEN '[]'::jsonb
                                                   ELSE pg_catalog.jsonb_agg(
                                                        pg_catalog.jsonb_build_object(
                                                            'location_id', l.location_id,
                                                            'location_code', l.location_code,
                                                            'location_name', l.location_name
                                                        )
                                                   )
                                                 END
                                                 FROM inventarios.inventory_audit_locations l WHERE l.audit_product_id = ap.id)
                                          END,
                            'search_scope', CASE WHEN ap.scope_status <> 'NO_PREVIOUS_LOCATION' THEN NULL::jsonb
                                             ELSE (SELECT pg_catalog.jsonb_build_object(
                                                        'session_id', (SELECT sc2.session_id FROM inventarios.inventory_audit_search_scopes sc2 WHERE sc2.audit_product_id = ap.id LIMIT 1),
                                                        'session_name', (SELECT sc2.session_name FROM inventarios.inventory_audit_search_scopes sc2 WHERE sc2.audit_product_id = ap.id LIMIT 1),
                                                        'inventory_site_id', (SELECT sc2.inventory_site_id FROM inventarios.inventory_audit_search_scopes sc2 WHERE sc2.audit_product_id = ap.id LIMIT 1),
                                                        'site_name', (SELECT sc2.site_name FROM inventarios.inventory_audit_search_scopes sc2 WHERE sc2.audit_product_id = ap.id LIMIT 1),
                                                        'zones', (SELECT pg_catalog.jsonb_agg(
                                                            pg_catalog.jsonb_build_object(
                                                                'zone_id', sc.session_zone_id,
                                                                'zone_code', sc.zone_code,
                                                                'zone_name', sc.zone_name
                                                            ) ORDER BY sc.zone_code
                                                        )
                                                        FROM inventarios.inventory_audit_search_scopes sc WHERE sc.audit_product_id = ap.id)
                                                    )
                                                   FROM inventarios.inventory_audit_search_scopes sc0 WHERE sc0.audit_product_id = ap.id LIMIT 1)
                                              END
                        ) ORDER BY ap.bsale_variant_id
                    )
                END
                FROM inventarios.inventory_audit_products ap WHERE ap.audit_id = a.id) AS products
        FROM inventarios.inventory_audits a
        JOIN inventarios.inventory_campaigns ic ON ic.id = a.campaign_id AND ic.company_id = a.company_id
        WHERE a.assigned_user_id = v_actor_id
          AND a.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')
          AND EXISTS (
              SELECT 1 FROM core.user_company_access uca
              WHERE uca.user_id = v_actor_id AND uca.company_id = a.company_id AND uca.is_active = true
          )
        ORDER BY a.created_at
    ) t;

    RETURN pg_catalog.jsonb_build_object(
        'actor_user_id', v_actor_id,
        'audits', coalesce(v_audits, '[]'::jsonb)
    );
END;
$function$;

ALTER FUNCTION inventarios.list_my_inventory_audits() OWNER TO postgres;
REVOKE ALL ON FUNCTION inventarios.list_my_inventory_audits() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION inventarios.list_my_inventory_audits() TO authenticated, service_role;

COMMIT;
