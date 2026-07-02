-- Asignar empresa al usuario finanzas@mympremium.cl
-- Ejecutar contra Supabase remoto (core schema)
-- Solo se inserta si no existe el registro (WHERE NOT EXISTS)

INSERT INTO core.user_company_access (
    user_id,
    company_id,
    role,
    is_default,
    is_active,
    created_at,
    created_by
)
SELECT
    'ba104779-f927-46de-8c6c-300fac1130de',
    'd1000000-0000-0000-0000-000000000001',
    'FINANZAS',
    true,
    true,
    now(),
    (SELECT id FROM portal.users WHERE email = 'admin@mym.cl' LIMIT 1)
WHERE NOT EXISTS (
    SELECT 1 FROM core.user_company_access
    WHERE user_id = 'ba104779-f927-46de-8c6c-300fac1130de'
    AND company_id = 'd1000000-0000-0000-0000-000000000001'
    AND is_active = true
);
