-- Asignar empresas a usuarios existentes sin registro en core.user_company_access
-- Ejecutar contra Supabase remoto (core schema)
-- Cada INSERT es idempotente (WHERE NOT EXISTS)

-- 1. finanzas@mympremium.cl → DISTRIBUIDORA MYM
INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active, created_at, created_by)
SELECT
    'ba104779-f927-46de-8c6c-300fac1130de',
    'd1000000-0000-0000-0000-000000000001',
    'FINANZAS',
    true, true, now(),
    (SELECT id FROM portal.users WHERE email = 'admin@mym.cl' LIMIT 1)
WHERE NOT EXISTS (
    SELECT 1 FROM core.user_company_access
    WHERE user_id = 'ba104779-f927-46de-8c6c-300fac1130de'
    AND company_id = 'd1000000-0000-0000-0000-000000000001'
    AND is_active = true
);

-- 2. SUPER_USUARIO (dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa) → EMPRESA 2
-- Si el super usuario no tiene acceso a EMPRESA 2, este INSERT lo agregará
INSERT INTO core.user_company_access (user_id, company_id, role, is_default, is_active, created_at, created_by)
SELECT
    'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa',
    'd2000000-0000-0000-0000-000000000002',
    'SUPER_USUARIO',
    false, true, now(),
    'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa'
WHERE NOT EXISTS (
    SELECT 1 FROM core.user_company_access
    WHERE user_id = 'dc9be3b3-bf39-47b2-8ea3-fdd6aa9a4aaa'
    AND company_id = 'd2000000-0000-0000-0000-000000000002'
    AND is_active = true
);
