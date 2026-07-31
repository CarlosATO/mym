-- Migration: 20260731060000_inventarios_phase_04f2_role_permissions.sql
-- Description: Puente definitivo entre portal.roles (autorizacion general) y
--              functional_role de inventarios.session_participants (autorizacion contextual).
--              Fase 4F.2. Sin roles nuevos, sin permisos nuevos, sin user_permissions.
-- Author: Assistant

-- ============================================================
-- 1. GUARDAS DE ESTRUCTURA FISICA
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'roles' AND column_name = 'name'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'roles' AND column_name = 'is_active'
    ) THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MODEL_UNSUPPORTED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'permissions' AND column_name = 'code'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'permissions' AND column_name = 'is_active'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'permissions' AND column_name = 'module_id'
    ) THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MODEL_UNSUPPORTED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'role_permissions' AND column_name = 'role_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'role_permissions' AND column_name = 'permission_id'
    ) THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MODEL_UNSUPPORTED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'portal' AND tablename = 'role_permissions'
          AND indexname = 'idx_role_permissions_unique'
    ) THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MODEL_UNSUPPORTED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'portal' AND table_name = 'modules' AND column_name = 'code'
    ) THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MODEL_UNSUPPORTED';
    END IF;
END $$;

-- ============================================================
-- 2. GUARDAS DE ROLES
-- ============================================================
DO $$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(t.role_name, ', ') INTO v_missing
    FROM (VALUES
        ('BODEGA'),
        ('CONSULTA_DE_BODEGA'),
        ('FINANZAS'),
        ('GERENCIA'),
        ('SUPER_USUARIO'),
        ('VENDEDOR')
    ) AS t(role_name)
    WHERE NOT EXISTS (
        SELECT 1 FROM portal.roles r
        WHERE r.name = t.role_name AND r.is_active = true
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_MISSING: %', v_missing;
    END IF;
END $$;

-- ============================================================
-- 3. GUARDAS DE PERMISOS USADOS POR LAS RPC OPERATIVAS
-- ============================================================
DO $$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(t.perm_code, ', ') INTO v_missing
    FROM (VALUES
        ('inventarios.tasks.assign'),
        ('inventarios.tasks.execute'),
        ('inventarios.tasks.validate'),
        ('inventarios.tasks.cancel'),
        ('inventarios.counts.record'),
        ('inventarios.counts.correct'),
        ('inventarios.incidents.manage'),
        ('inventarios.recounts.manage'),
        ('inventarios.recounts.decide'),
        ('inventarios.sessions.approve')
    ) AS t(perm_code)
    WHERE NOT EXISTS (
        SELECT 1 FROM portal.permissions p
        JOIN portal.modules m ON m.id = p.module_id
        WHERE p.code = t.perm_code
          AND p.is_active = true
          AND m.code = 'inventarios'
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'INVENTORY_4F2_PERMISSION_MISSING: %', v_missing;
    END IF;
END $$;

-- ============================================================
-- 4. MATRIZ PERMITIDA Y DETECCION DE ASIGNACIONES INESPERADAS
--    Matriz definitiva 4F.2:
--      SUPER_USUARIO -> las 10 permisiones usadas por RPC operativas
--      BODEGA        -> 9 permisiones operativas (excluye sessions.approve)
--      GERENCIA      -> unicamente inventarios.sessions.approve
--      CONSULTA_DE_BODEGA / FINANZAS / VENDEDOR -> cero
-- ============================================================
DO $$
DECLARE
    v_unexpected text;
BEGIN
    SELECT string_agg(DISTINCT r.name || '=' || p.code, ', ' ORDER BY r.name || '=' || p.code)
    INTO v_unexpected
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE m.code = 'inventarios'
      AND NOT (
        (r.name = 'SUPER_USUARIO' AND p.code IN (
            'inventarios.tasks.assign',
            'inventarios.tasks.execute',
            'inventarios.tasks.validate',
            'inventarios.tasks.cancel',
            'inventarios.counts.record',
            'inventarios.counts.correct',
            'inventarios.incidents.manage',
            'inventarios.recounts.manage',
            'inventarios.recounts.decide',
            'inventarios.sessions.approve'
        ))
        OR (r.name = 'BODEGA' AND p.code IN (
            'inventarios.tasks.assign',
            'inventarios.tasks.execute',
            'inventarios.tasks.validate',
            'inventarios.tasks.cancel',
            'inventarios.counts.record',
            'inventarios.counts.correct',
            'inventarios.incidents.manage',
            'inventarios.recounts.manage',
            'inventarios.recounts.decide'
        ))
        OR (r.name = 'GERENCIA' AND p.code = 'inventarios.sessions.approve')
      );

    IF v_unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'INVENTORY_4F2_UNEXPECTED_ROLE_PERMISSION: %', v_unexpected;
    END IF;
END $$;

-- ============================================================
-- 5. INSERCION IDEMPOTENTE (ON CONFLICT sobre idx_role_permissions_unique)
-- ============================================================
INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.tasks.assign'),
    ('SUPER_USUARIO', 'inventarios.tasks.execute'),
    ('SUPER_USUARIO', 'inventarios.tasks.validate'),
    ('SUPER_USUARIO', 'inventarios.tasks.cancel'),
    ('SUPER_USUARIO', 'inventarios.counts.record'),
    ('SUPER_USUARIO', 'inventarios.counts.correct'),
    ('SUPER_USUARIO', 'inventarios.incidents.manage'),
    ('SUPER_USUARIO', 'inventarios.recounts.manage'),
    ('SUPER_USUARIO', 'inventarios.recounts.decide'),
    ('SUPER_USUARIO', 'inventarios.sessions.approve'),
    ('BODEGA', 'inventarios.tasks.assign'),
    ('BODEGA', 'inventarios.tasks.execute'),
    ('BODEGA', 'inventarios.tasks.validate'),
    ('BODEGA', 'inventarios.tasks.cancel'),
    ('BODEGA', 'inventarios.counts.record'),
    ('BODEGA', 'inventarios.counts.correct'),
    ('BODEGA', 'inventarios.incidents.manage'),
    ('BODEGA', 'inventarios.recounts.manage'),
    ('BODEGA', 'inventarios.recounts.decide'),
    ('GERENCIA', 'inventarios.sessions.approve')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 6. VERIFICACION POSTERIOR EXACTA DE LA MATRIZ
-- ============================================================
DO $$
DECLARE
    v_super_count integer;
    v_bodega_count integer;
    v_gerencia_count integer;
    v_consulta_count integer;
    v_finanzas_count integer;
    v_vendedor_count integer;
    v_super_approve integer;
    v_bodega_approve integer;
    v_gerencia_oper integer;
    v_duplicates integer;
    v_user_perms integer;
BEGIN
    SELECT count(*) INTO v_super_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'SUPER_USUARIO' AND m.code = 'inventarios';

    SELECT count(*) INTO v_bodega_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'BODEGA' AND m.code = 'inventarios';

    SELECT count(*) INTO v_gerencia_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'GERENCIA' AND m.code = 'inventarios';

    SELECT count(*) INTO v_consulta_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'CONSULTA_DE_BODEGA' AND m.code = 'inventarios';

    SELECT count(*) INTO v_finanzas_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'FINANZAS' AND m.code = 'inventarios';

    SELECT count(*) INTO v_vendedor_count
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'VENDEDOR' AND m.code = 'inventarios';

    SELECT count(*) INTO v_super_approve
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    WHERE r.name = 'SUPER_USUARIO' AND p.code = 'inventarios.sessions.approve';

    SELECT count(*) INTO v_bodega_approve
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    WHERE r.name = 'BODEGA' AND p.code = 'inventarios.sessions.approve';

    SELECT count(*) INTO v_gerencia_oper
    FROM portal.role_permissions rp
    JOIN portal.roles r ON r.id = rp.role_id
    JOIN portal.permissions p ON p.id = rp.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE r.name = 'GERENCIA' AND m.code = 'inventarios'
      AND p.code <> 'inventarios.sessions.approve';

    SELECT count(*) INTO v_duplicates
    FROM (
        SELECT role_id, permission_id
        FROM portal.role_permissions
        GROUP BY role_id, permission_id
        HAVING count(*) > 1
    ) d;

    SELECT count(*) INTO v_user_perms
    FROM portal.user_permissions up
    JOIN portal.permissions p ON p.id = up.permission_id
    JOIN portal.modules m ON m.id = p.module_id
    WHERE m.code = 'inventarios';

    IF v_super_count <> 10
       OR v_bodega_count <> 9
       OR v_gerencia_count <> 1
       OR v_consulta_count <> 0
       OR v_finanzas_count <> 0
       OR v_vendedor_count <> 0
       OR v_super_approve <> 1
       OR v_bodega_approve <> 0
       OR v_gerencia_oper <> 0
       OR v_duplicates <> 0
       OR v_user_perms <> 0
    THEN
        RAISE EXCEPTION 'INVENTORY_4F2_ROLE_PERMISSION_MATRIX_MISMATCH';
    END IF;
END $$;
