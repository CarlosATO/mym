-- Migration: 20260803120100_inventarios_campaigns.sql
-- Description: Fase 4I.2E. Campanas de inventario (inventory_campaigns) y
--              alcance materializado por unidad (inventory_campaign_sites).
--              PARTIALLY_COMPLETED es condicion calculada, no estado persistente.
-- Author: Assistant

-- ============================================================
-- 1. PERMISOS NUEVOS
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('inventarios.campaigns.manage', 'Gestionar campanas de inventario'),
        ('inventarios.campaigns.read', 'Leer campanas de inventario')
) AS permission(code, name)
CROSS JOIN (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.campaigns.manage'),
    ('BODEGA', 'inventarios.campaigns.manage'),
    ('SUPER_USUARIO', 'inventarios.campaigns.read'),
    ('BODEGA', 'inventarios.campaigns.read'),
    ('GERENCIA', 'inventarios.campaigns.read')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. CAMPANAS
-- ============================================================
CREATE TABLE inventarios.inventory_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    name text NOT NULL,
    campaign_type text NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    planned_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    approved_at timestamptz,
    approved_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancellation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaigns_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaigns_company_name UNIQUE (company_id, name),
    CONSTRAINT chk_inventarios_campaigns_type
        CHECK (campaign_type IN ('GENERAL', 'SELECTIVE', 'EXTERNAL')),
    CONSTRAINT chk_inventarios_campaigns_status
        CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'UNDER_REVIEW', 'APPROVED', 'CANCELLED')),
    CONSTRAINT chk_inventarios_campaigns_dates
        CHECK (
            (started_at IS NULL OR (planned_at IS NOT NULL AND started_at >= planned_at))
            AND (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
            AND (approved_at IS NULL OR (started_at IS NOT NULL AND approved_at >= started_at))
        ),
    CONSTRAINT chk_inventarios_campaigns_cancelled
        CHECK (
            status <> 'CANCELLED'
            OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)
        )
);

CREATE INDEX idx_inventarios_campaigns_company_status
    ON inventarios.inventory_campaigns (company_id, status);

-- ============================================================
-- 3. ALCANCE MATERIALIZADO POR UNIDAD
-- ============================================================
CREATE TABLE inventarios.inventory_campaign_sites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    campaign_id uuid NOT NULL,
    inventory_site_id uuid NOT NULL,
    is_required boolean NOT NULL DEFAULT true,
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_campaign_sites_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_campaign_sites_campaign_site UNIQUE (company_id, campaign_id, inventory_site_id),
    CONSTRAINT fk_inventarios_campaign_sites_campaign
        FOREIGN KEY (company_id, campaign_id)
        REFERENCES inventarios.inventory_campaigns(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_campaign_sites_site
        FOREIGN KEY (company_id, inventory_site_id)
        REFERENCES inventarios.inventory_sites(company_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_inventarios_campaign_sites_campaign
    ON inventarios.inventory_campaign_sites (company_id, campaign_id, display_order);
