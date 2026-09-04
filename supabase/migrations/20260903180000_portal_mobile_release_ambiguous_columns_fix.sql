-- Qualify release columns that collide with RETURNS TABLE output parameters.

BEGIN;

CREATE OR REPLACE FUNCTION portal.publish_mobile_release(
    p_version text,
    p_build_number integer,
    p_storage_path text
)
RETURNS TABLE (
    app_name text,
    version text,
    build_number integer,
    storage_path text,
    published_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, portal
AS $$
DECLARE
    v_published_at timestamptz := now();
BEGIN
    IF NOT portal.is_super_usuario() THEN
        RAISE EXCEPTION 'PERMISSION_DENIED';
    END IF;
    IF p_version IS NULL OR btrim(p_version) = '' THEN
        RAISE EXCEPTION 'VERSION_REQUIRED';
    END IF;
    IF p_build_number IS NULL OR p_build_number <= 0 THEN
        RAISE EXCEPTION 'BUILD_INVALID';
    END IF;
    IF p_storage_path IS NULL OR p_storage_path !~ '^inventarios/[^/]+[.]apk$' THEN
        RAISE EXCEPTION 'STORAGE_PATH_INVALID';
    END IF;
    IF p_storage_path <> ('inventarios/PetGroup-Inventarios-v' || btrim(p_version) || '-build' || p_build_number || '.apk') THEN
        RAISE EXCEPTION 'STORAGE_PATH_VERSION_MISMATCH';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('inventory_mobile', 0));

    IF EXISTS (
        SELECT 1
        FROM portal.mobile_app_releases AS r
        WHERE r.app_key = 'inventory_mobile'
          AND r.version = btrim(p_version)
          AND r.build_number = p_build_number
    ) THEN
        RAISE EXCEPTION 'VERSION_BUILD_ALREADY_REGISTERED';
    END IF;

    UPDATE portal.mobile_app_releases
    SET is_active = false
    WHERE app_key = 'inventory_mobile' AND is_active;

    INSERT INTO portal.mobile_app_releases
        (app_key, app_name, version, build_number, storage_path, is_active, published_at)
    VALUES
        ('inventory_mobile', 'Inventarios', btrim(p_version), p_build_number, p_storage_path, true, v_published_at);

    RETURN QUERY
    SELECT r.app_name, r.version, r.build_number, r.storage_path, r.published_at
    FROM portal.mobile_app_releases r
    WHERE r.app_key = 'inventory_mobile' AND r.is_active;
END;
$$;

REVOKE ALL ON FUNCTION portal.publish_mobile_release(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.publish_mobile_release(text, integer, text) TO authenticated;

COMMIT;
