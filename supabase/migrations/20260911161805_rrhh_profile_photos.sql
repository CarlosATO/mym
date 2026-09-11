-- RRHH V1: private employee profile photos.

ALTER TABLE rrhh.employees
    ADD COLUMN profile_photo_path text
        CHECK (profile_photo_path IS NULL OR profile_photo_path ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$');

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('rrhh-profile-photos', 'rrhh-profile-photos', false, 5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS rrhh_profile_photos_select ON storage.objects;
CREATE POLICY rrhh_profile_photos_select ON storage.objects FOR SELECT TO authenticated
    USING (
        bucket_id = 'rrhh-profile-photos'
        AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.view'))
        AND EXISTS (SELECT 1 FROM rrhh.employees WHERE profile_photo_path = name)
    );

DROP POLICY IF EXISTS rrhh_profile_photos_insert ON storage.objects;
CREATE POLICY rrhh_profile_photos_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'rrhh-profile-photos'
        AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage'))
        AND name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$'
        AND EXISTS (SELECT 1 FROM rrhh.employees WHERE id::text = split_part(name, '/', 1))
    );

DROP POLICY IF EXISTS rrhh_profile_photos_update ON storage.objects;
CREATE POLICY rrhh_profile_photos_update ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'rrhh-profile-photos' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage')))
    WITH CHECK (bucket_id = 'rrhh-profile-photos' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage')));

DROP POLICY IF EXISTS rrhh_profile_photos_delete ON storage.objects;
CREATE POLICY rrhh_profile_photos_delete ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'rrhh-profile-photos' AND (portal.has_permission('system.admin') OR portal.has_permission('rrhh.personal.manage')));
