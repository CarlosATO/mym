-- Migration: 20260803120000_inventarios_sites.sql
-- Description: Fase 4I.2E. Unidades inventariables (inventory_sites) y
--              ubicaciones por sitio (inventory_site_locations).
--              Los sitios externos no participan en Logistica.
-- Author: Assistant

-- ============================================================
-- 1. PERMISOS NUEVOS
-- ============================================================
INSERT INTO portal.permissions (code, name, module_id)
SELECT permission.code, permission.name, module.id
FROM (
    VALUES
        ('inventarios.sites.manage', 'Gestionar unidades inventariables'),
        ('inventarios.sites.read', 'Leer unidades inventariables')
) AS permission(code, name)
CROSS JOIN (SELECT id FROM portal.modules WHERE code = 'inventarios') AS module
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name, module_id = EXCLUDED.module_id;

INSERT INTO portal.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
    ('SUPER_USUARIO', 'inventarios.sites.manage'),
    ('BODEGA', 'inventarios.sites.manage'),
    ('SUPER_USUARIO', 'inventarios.sites.read'),
    ('BODEGA', 'inventarios.sites.read'),
    ('GERENCIA', 'inventarios.sites.read')
) AS m(role_name, perm_code)
JOIN portal.roles r ON r.name = m.role_name AND r.is_active = true
JOIN portal.permissions p ON p.code = m.perm_code AND p.is_active = true
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- 2. UNIDADES INVENTARIABLES
-- ============================================================
CREATE TABLE inventarios.inventory_sites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    name text NOT NULL,
    code text NOT NULL,
    site_type text NOT NULL,
    warehouse_id uuid REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    is_active boolean NOT NULL DEFAULT true,
    inventory_enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_sites_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_sites_company_code UNIQUE (company_id, code),
    CONSTRAINT chk_inventarios_sites_type
        CHECK (site_type IN ('INTERNAL_WAREHOUSE', 'OWN_STORE', 'EXTERNAL_SITE')),
    CONSTRAINT chk_inventarios_sites_internal_warehouse
        CHECK (
            (site_type = 'INTERNAL_WAREHOUSE' AND warehouse_id IS NOT NULL)
            OR (site_type IN ('OWN_STORE', 'EXTERNAL_SITE') AND warehouse_id IS NULL)
        )
);

-- Una bodega interna solo puede tener un inventory_site por empresa
CREATE UNIQUE INDEX uq_inventarios_sites_internal_warehouse
    ON inventarios.inventory_sites (company_id, warehouse_id)
    WHERE warehouse_id IS NOT NULL;

CREATE INDEX idx_inventarios_sites_company_active
    ON inventarios.inventory_sites (company_id, is_active, inventory_enabled);

-- ============================================================
-- 3. UBICACIONES POR SITIO
-- ============================================================
CREATE TABLE inventarios.inventory_site_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    inventory_site_id uuid NOT NULL,
    source_logistics_location_id uuid REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    code text NOT NULL,
    name text,
    aisle text,
    rack text,
    level text,
    position text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_site_locations_company_id UNIQUE (company_id, id),
    CONSTRAINT uq_inventarios_site_locations_site_id UNIQUE (company_id, inventory_site_id, id),
    CONSTRAINT uq_inventarios_site_locations_site_code UNIQUE (company_id, inventory_site_id, code),
    CONSTRAINT chk_inventarios_site_locations_code
        CHECK (pg_catalog.btrim(code) <> ''),
    CONSTRAINT fk_inventarios_site_locations_site
        FOREIGN KEY (company_id, inventory_site_id)
        REFERENCES inventarios.inventory_sites(company_id, id)
        ON DELETE RESTRICT
);

-- El vinculo a una ubicacion logistica es unico por empresa cuando no es NULL
CREATE UNIQUE INDEX uq_inventarios_site_locations_source_logistics
    ON inventarios.inventory_site_locations (company_id, source_logistics_location_id)
    WHERE source_logistics_location_id IS NOT NULL;

CREATE INDEX idx_inventarios_site_locations_site_active
    ON inventarios.inventory_site_locations (company_id, inventory_site_id, is_active);
