-- ============================================================================
-- Migración: Preparación de Pedidos (Logística)
-- Fecha: 2026-07-13
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS logistica;

-- ============================================================================
-- 1. Tabla: city_aliases
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.city_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    raw_city text NOT NULL,
    normalized_city text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Constraint única funcional para (company_id, lower(raw_city))
CREATE UNIQUE INDEX IF NOT EXISTS idx_city_aliases_unique_raw_city 
ON logistica.city_aliases(company_id, lower(raw_city));

CREATE INDEX IF NOT EXISTS idx_city_aliases_company ON logistica.city_aliases(company_id);

-- ============================================================================
-- 2. Función de Normalización de Ciudad
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.normalize_city(p_company_id uuid, p_raw_city text)
RETURNS text AS $$
DECLARE
    v_normalized text;
BEGIN
    IF p_raw_city IS NULL THEN
        RETURN NULL;
    END IF;

    -- Buscar alias
    SELECT normalized_city INTO v_normalized
    FROM logistica.city_aliases
    WHERE company_id = p_company_id
      AND lower(raw_city) = lower(p_raw_city)
      AND active = true
    LIMIT 1;

    IF FOUND THEN
        RETURN v_normalized;
    END IF;

    -- Fallback: Capitalizar la primera letra de cada palabra y hacer TRIM
    RETURN initcap(trim(p_raw_city));
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- 3. Tablas de Calendario de Despacho
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.dispatch_calendars (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logistica.dispatch_calendar_cities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    calendar_id uuid NOT NULL REFERENCES logistica.dispatch_calendars(id) ON DELETE CASCADE,
    weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = Lunes, 7 = Domingo
    normalized_city text NOT NULL,
    route_label text,
    active boolean NOT NULL DEFAULT true,
    priority integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id, calendar_id, weekday, normalized_city)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_calendar_cities_search 
ON logistica.dispatch_calendar_cities(company_id, weekday, normalized_city);

-- ============================================================================
-- 4. Tabla de Tarjetas de Preparación
-- ============================================================================
-- Uso de CHECK constraint en lugar de ENUM para mayor facilidad de migración futura
CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    bsale_nv_id bigint NOT NULL,
    bsale_nv_folio text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING_ROUTE_PREP' 
        CHECK (status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INVOICED_READY_FOR_ROUTE', 'CANCELLED')),
    normalized_city text,
    raw_city text,
    raw_municipality text,
    route_date date,
    priority integer NOT NULL DEFAULT 0,
    assigned_user_id uuid, -- Referencia opcional/lógica a auth.users o tabla de perfiles
    locked_by_user_id uuid,
    locked_at timestamptz,
    last_moved_by uuid,
    last_moved_at timestamptz,
    notes text,
    cancellation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id, bsale_nv_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_prep_cards_status ON logistica.sales_order_preparation_cards(company_id, status);
CREATE INDEX IF NOT EXISTS idx_sales_order_prep_cards_city ON logistica.sales_order_preparation_cards(company_id, normalized_city);
CREATE INDEX IF NOT EXISTS idx_sales_order_prep_cards_date ON logistica.sales_order_preparation_cards(company_id, route_date);

-- ============================================================================
-- 5. Tabla de Movimientos
-- ============================================================================
CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_movements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE CASCADE,
    from_status text,
    to_status text NOT NULL,
    moved_by uuid,
    movement_source text NOT NULL DEFAULT 'USER'
        CHECK (movement_source IN ('USER', 'SYSTEM', 'SYNC', 'ADMIN')),
    pin_validated boolean NOT NULL DEFAULT false,
    observation text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_order_prep_movs_card ON logistica.sales_order_preparation_movements(company_id, card_id, created_at DESC);

-- ============================================================================
-- 6. Función Idempotente para Materializar Tarjetas
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.sync_sales_order_preparation_cards(p_company_id uuid)
RETURNS void AS $$
BEGIN
    INSERT INTO logistica.sales_order_preparation_cards (
        company_id,
        bsale_nv_id,
        bsale_nv_folio,
        raw_city,
        raw_municipality,
        normalized_city,
        status
    )
    SELECT 
        nv.company_id,
        nv.nv_bsale_id,
        nv.nv_folio::text,
        nv.city_raw,
        nv.municipality_raw,
        logistica.normalize_city(nv.company_id, nv.city_raw),
        'PENDING_ROUTE_PREP'
    FROM integraciones.vw_bsale_sales_orders_for_preparation nv
    WHERE nv.company_id = p_company_id
    ON CONFLICT (company_id, bsale_nv_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 7. Vista de Lectura para el Tablero
-- ============================================================================
CREATE OR REPLACE VIEW logistica.vw_sales_order_preparation_board AS
SELECT 
    c.id AS card_id,
    c.company_id,
    c.status,
    c.priority,
    c.assigned_user_id,
    c.route_date,
    c.normalized_city,
    
    nv.nv_bsale_id,
    nv.nv_folio,
    nv.nv_emission_date,
    nv.nv_generation_date,
    
    nv.client_name,
    nv.city_raw,
    nv.municipality_raw,
    nv.address_raw,
    
    nv.seller_bsale_id,
    nv.seller_name,
    nv.total_quantity,
    nv.total_amount,
    
    nv.invoice_folio,
    nv.is_invoiced,
    
    c.created_at,
    c.updated_at
FROM logistica.sales_order_preparation_cards c
JOIN integraciones.vw_bsale_sales_orders_for_preparation nv 
  ON c.company_id = nv.company_id AND c.bsale_nv_id = nv.nv_bsale_id;

-- ============================================================================
-- 8. Seguridad (RLS)
-- ============================================================================
ALTER TABLE logistica.city_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated on city_aliases" ON logistica.city_aliases FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all for service_role on city_aliases" ON logistica.city_aliases FOR ALL TO service_role USING (true);

ALTER TABLE logistica.dispatch_calendars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated on dispatch_calendars" ON logistica.dispatch_calendars FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all for service_role on dispatch_calendars" ON logistica.dispatch_calendars FOR ALL TO service_role USING (true);

ALTER TABLE logistica.dispatch_calendar_cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated on dispatch_calendar_cities" ON logistica.dispatch_calendar_cities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all for service_role on dispatch_calendar_cities" ON logistica.dispatch_calendar_cities FOR ALL TO service_role USING (true);

ALTER TABLE logistica.sales_order_preparation_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated on prep_cards" ON logistica.sales_order_preparation_cards FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all for service_role on prep_cards" ON logistica.sales_order_preparation_cards FOR ALL TO service_role USING (true);

ALTER TABLE logistica.sales_order_preparation_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read for authenticated on prep_movements" ON logistica.sales_order_preparation_movements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Allow all for service_role on prep_movements" ON logistica.sales_order_preparation_movements FOR ALL TO service_role USING (true);
