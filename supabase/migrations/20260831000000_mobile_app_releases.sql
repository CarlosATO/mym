-- Internal distribution metadata for PetGroup mobile applications.

INSERT INTO storage.buckets (id, name, public)
VALUES ('mobile-apps', 'mobile-apps', false)
ON CONFLICT (id) DO UPDATE
SET public = false;

CREATE TABLE portal.mobile_app_releases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app_key text NOT NULL,
    app_name text NOT NULL,
    version text NOT NULL,
    build_number integer NOT NULL CHECK (build_number >= 0),
    storage_path text NOT NULL
        CHECK (storage_path ~ '^inventarios/[^/]+[.]apk$'),
    is_active boolean NOT NULL DEFAULT false,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mobile_app_releases_active_requires_published
        CHECK (NOT is_active OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX mobile_app_releases_one_active_per_app
    ON portal.mobile_app_releases (app_key)
    WHERE is_active;

CREATE INDEX mobile_app_releases_app_history
    ON portal.mobile_app_releases (app_key, published_at DESC NULLS LAST);

CREATE TRIGGER trg_mobile_app_releases_set_updated_at
    BEFORE UPDATE ON portal.mobile_app_releases
    FOR EACH ROW
    EXECUTE FUNCTION portal.set_updated_at();

ALTER TABLE portal.mobile_app_releases ENABLE ROW LEVEL SECURITY;

-- Direct table access is restricted to Portal administrators. The ERP contract
-- below exposes only the active release DTO to authenticated callers.
CREATE POLICY mobile_app_releases_admin_select
    ON portal.mobile_app_releases FOR SELECT
    USING (portal.has_permission('system.admin'));

CREATE POLICY mobile_app_releases_admin_insert
    ON portal.mobile_app_releases FOR INSERT
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY mobile_app_releases_admin_update
    ON portal.mobile_app_releases FOR UPDATE
    USING (portal.has_permission('system.admin'))
    WITH CHECK (portal.has_permission('system.admin'));

CREATE POLICY mobile_app_releases_admin_delete
    ON portal.mobile_app_releases FOR DELETE
    USING (portal.has_permission('system.admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON portal.mobile_app_releases TO authenticated;
GRANT ALL ON portal.mobile_app_releases TO service_role;

CREATE OR REPLACE FUNCTION portal.get_active_mobile_release()
RETURNS TABLE (
    app_name text,
    version text,
    build_number integer,
    storage_path text,
    published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, portal
AS $$
    SELECT r.app_name, r.version, r.build_number, r.storage_path, r.published_at
    FROM portal.mobile_app_releases AS r
    WHERE r.app_key = 'inventory_mobile'
      AND r.is_active
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION portal.get_active_mobile_release() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.get_active_mobile_release() TO authenticated, service_role;
