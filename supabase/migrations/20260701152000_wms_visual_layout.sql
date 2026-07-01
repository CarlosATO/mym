-- MIGRATION: WMS Visual Layouts y Vista Stock
-- Creado para implementar la vista WMS visual

-- 1. Crear tabla location_layouts
CREATE TABLE IF NOT EXISTS logistica.location_layouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES logistica.locations(id) ON DELETE CASCADE,
    floor smallint NOT NULL DEFAULT 1,
    x numeric NOT NULL DEFAULT 0,
    y numeric NOT NULL DEFAULT 0,
    width numeric NOT NULL DEFAULT 80,
    height numeric NOT NULL DEFAULT 48,
    rotation numeric NOT NULL DEFAULT 0,
    layout_group varchar(100),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id),
    CONSTRAINT uq_company_location_layout UNIQUE (company_id, location_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_location_layouts_company_id ON logistica.location_layouts(company_id);
CREATE INDEX IF NOT EXISTS idx_location_layouts_warehouse_id ON logistica.location_layouts(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_location_layouts_location_id ON logistica.location_layouts(location_id);
CREATE INDEX IF NOT EXISTS idx_location_layouts_floor ON logistica.location_layouts(floor);

-- RLS y Grants
ALTER TABLE logistica.location_layouts ENABLE ROW LEVEL SECURITY;

GRANT ALL ON logistica.location_layouts TO authenticated, service_role;

CREATE POLICY rls_location_layouts_select ON logistica.location_layouts FOR SELECT TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_location_layouts_insert ON logistica.location_layouts FOR INSERT TO authenticated
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_location_layouts_update ON logistica.location_layouts FOR UPDATE TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id))
    WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_location_layouts_delete ON logistica.location_layouts FOR DELETE TO authenticated
    USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

-- 2. Crear vista de stock consolidado para ubicaciones
-- Esta vista evita N+1 y agrupa los saldos, devolviendo solo los mayores a 0
CREATE OR REPLACE VIEW logistica.v_stock_by_location AS
SELECT 
    company_id,
    warehouse_id,
    location_id,
    product_id,
    lot_number,
    expiration_date,
    SUM(
        CASE 
            WHEN movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN quantity
            WHEN movement_type IN ('OUT', 'TRANSFER_OUT') THEN -quantity
            ELSE 0 
        END
    ) AS quantity,
    -- Calculamos un unit_cost promedio ponderado o tomamos el max/ultimo (simplificado a MAX por rendimiento)
    MAX(unit_cost) AS max_unit_cost
FROM logistica.kardex_movements
GROUP BY 
    company_id,
    warehouse_id,
    location_id,
    product_id,
    lot_number,
    expiration_date
HAVING SUM(
    CASE 
        WHEN movement_type IN ('IN', 'TRANSFER_IN', 'ADJUSTMENT') THEN quantity
        WHEN movement_type IN ('OUT', 'TRANSFER_OUT') THEN -quantity
        ELSE 0 
    END
) > 0;

GRANT SELECT ON logistica.v_stock_by_location TO authenticated, service_role;

-- Configurar security_invoker en PostgreSQL 15+ para que respete las políticas de RLS subyacentes
ALTER VIEW logistica.v_stock_by_location SET (security_invoker = true);
