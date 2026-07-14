-- ============================================================================
-- Migración: Tabla maestra de ciudades, ajustes de calendario y funciones de ruta
-- Fecha: 2026-07-14
-- ============================================================================

-- 1. Tabla Maestra de Ciudades
CREATE TABLE IF NOT EXISTS logistica.dispatch_cities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    name text NOT NULL,
    region text,
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_cities_unique_name 
ON logistica.dispatch_cities(company_id, lower(name));

ALTER TABLE logistica.dispatch_cities ENABLE ROW LEVEL SECURITY;

-- 2. Modificaciones Compatibles a tablas existentes
ALTER TABLE logistica.city_aliases 
ADD COLUMN IF NOT EXISTS city_id uuid NULL REFERENCES logistica.dispatch_cities(id) ON DELETE RESTRICT;

ALTER TABLE logistica.dispatch_calendar_cities 
ADD COLUMN IF NOT EXISTS city_id uuid NULL REFERENCES logistica.dispatch_cities(id) ON DELETE RESTRICT;

-- 3. Inserción Inicial de Ciudades y Alias propuestos
DO $$ 
DECLARE
  v_company_id uuid := 'd1000000-0000-0000-0000-000000000001'::uuid; -- Company por defecto
  
  -- Para inserción dinámica
  v_city_name text;
  v_city_id uuid;
  v_cities text[] := ARRAY[
    'Talca', 'Chillán', 'Linares', 'Parral', 'Curicó', 'Constitución', 'San Carlos', 
    'Rancagua', 'Molina', 'San Javier', 'San Vicente de Tagua Tagua', 'Cauquenes', 
    'Los Ángeles', 'Rengo', 'Pichilemu', 'San Fernando', 'Santa Cruz', 'Sagrada Familia', 
    'San Rafael', 'Bulnes', 'Teno', 'Graneros', 'Villa Alegre', 'Machalí', 'Paredones', 
    'Requínoa', 'Pinto', 'Doñihue', 'Peumo', 'Bucalemu', 'San Clemente', 'Hualañé', 
    'Chimbarongo', 'Santiago', 'Quilicura', 'Quillón'
  ];
BEGIN
  -- 3.1 Cargar Ciudades Canónicas
  FOREACH v_city_name IN ARRAY v_cities
  LOOP
    INSERT INTO logistica.dispatch_cities (company_id, name)
    VALUES (v_company_id, v_city_name)
    ON CONFLICT (company_id, lower(name)) DO NOTHING;
  END LOOP;

  -- 3.2 Cargar Alias (Mapeos crudos detectados)
  -- STGO -> Santiago
  SELECT id INTO v_city_id FROM logistica.dispatch_cities WHERE company_id = v_company_id AND lower(name) = 'santiago' LIMIT 1;
  IF v_city_id IS NOT NULL THEN
    INSERT INTO logistica.city_aliases (company_id, raw_city, normalized_city, city_id)
    VALUES (v_company_id, 'STGO', 'Santiago', v_city_id)
    ON CONFLICT (company_id, lower(raw_city)) DO UPDATE SET city_id = EXCLUDED.city_id, normalized_city = EXCLUDED.normalized_city;
  END IF;

  -- LOS ANEGELES -> Los Ángeles
  SELECT id INTO v_city_id FROM logistica.dispatch_cities WHERE company_id = v_company_id AND lower(name) = 'los ángeles' LIMIT 1;
  IF v_city_id IS NOT NULL THEN
    INSERT INTO logistica.city_aliases (company_id, raw_city, normalized_city, city_id)
    VALUES (v_company_id, 'LOS ANEGELES', 'Los Ángeles', v_city_id)
    ON CONFLICT (company_id, lower(raw_city)) DO UPDATE SET city_id = EXCLUDED.city_id, normalized_city = EXCLUDED.normalized_city;
  END IF;

  -- SAN FERNADO -> San Fernando
  SELECT id INTO v_city_id FROM logistica.dispatch_cities WHERE company_id = v_company_id AND lower(name) = 'san fernando' LIMIT 1;
  IF v_city_id IS NOT NULL THEN
    INSERT INTO logistica.city_aliases (company_id, raw_city, normalized_city, city_id)
    VALUES (v_company_id, 'SAN FERNADO', 'San Fernando', v_city_id)
    ON CONFLICT (company_id, lower(raw_city)) DO UPDATE SET city_id = EXCLUDED.city_id, normalized_city = EXCLUDED.normalized_city;
  END IF;

  -- GRANERO -> Graneros
  SELECT id INTO v_city_id FROM logistica.dispatch_cities WHERE company_id = v_company_id AND lower(name) = 'graneros' LIMIT 1;
  IF v_city_id IS NOT NULL THEN
    INSERT INTO logistica.city_aliases (company_id, raw_city, normalized_city, city_id)
    VALUES (v_company_id, 'GRANERO', 'Graneros', v_city_id)
    ON CONFLICT (company_id, lower(raw_city)) DO UPDATE SET city_id = EXCLUDED.city_id, normalized_city = EXCLUDED.normalized_city;
  END IF;

END $$;

-- ============================================================================
-- 4. Modificar Función Normalize City para priorizar nueva tabla
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.normalize_city(p_company_id uuid, p_raw_city text)
RETURNS text AS $$
DECLARE
    v_normalized text;
    v_city_id uuid;
BEGIN
    IF p_raw_city IS NULL OR trim(p_raw_city) = '' THEN
        RETURN NULL;
    END IF;

    -- 1. Buscar en aliases
    SELECT city_id, normalized_city INTO v_city_id, v_normalized
    FROM logistica.city_aliases
    WHERE company_id = p_company_id
      AND lower(raw_city) = lower(trim(p_raw_city))
      AND active = true
    LIMIT 1;

    IF FOUND THEN
        IF v_city_id IS NOT NULL THEN
            SELECT name INTO v_normalized
            FROM logistica.dispatch_cities
            WHERE id = v_city_id;
            
            IF v_normalized IS NOT NULL THEN
                RETURN v_normalized;
            END IF;
        END IF;
        -- Si city_id era null o no encontró la ciudad, retorna el normalized_city guardado
        RETURN v_normalized;
    END IF;

    -- 2. Si no hay alias, ver si hace match directo con una ciudad maestra
    SELECT name INTO v_normalized
    FROM logistica.dispatch_cities
    WHERE company_id = p_company_id
      AND lower(name) = lower(trim(p_raw_city))
      AND active = true
    LIMIT 1;

    IF FOUND THEN
        RETURN v_normalized;
    END IF;

    -- 3. Fallback: Capitalizar
    RETURN initcap(trim(p_raw_city));
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- 5. Función de Previsualización por Ruta (Read-Only)
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.preview_sales_order_route_candidates(
  p_company_id uuid,
  p_go_live_from_date date,
  p_route_from_date date,
  p_route_to_date date,
  p_limit integer DEFAULT NULL
)
RETURNS TABLE (
  nv_bsale_id bigint,
  nv_folio text,
  nv_emission_date date,
  client_name text,
  raw_city text,
  normalized_city text,
  city_id uuid,
  seller_name text,
  total_quantity numeric,
  total_amount numeric,
  route_date date,
  route_weekday int,
  route_label text,
  match_status text
) AS $$
BEGIN
    IF p_go_live_from_date IS NULL OR p_route_from_date IS NULL OR p_route_to_date IS NULL THEN
        RAISE EXCEPTION 'p_go_live_from_date, p_route_from_date y p_route_to_date son obligatorios';
    END IF;
    
    IF p_route_to_date < p_route_from_date THEN
        RAISE EXCEPTION 'p_route_to_date no puede ser menor a p_route_from_date';
    END IF;
    
    IF (p_route_to_date - p_route_from_date) > 6 THEN
        RAISE EXCEPTION 'La ventana de ruta (p_route_to_date - p_route_from_date) no puede ser mayor a 6 días de diferencia (7 días calendario)';
    END IF;

    RETURN QUERY
    WITH base_nvs AS (
        SELECT 
            nv.bsale_id AS nv_id,
            nv.folio,
            nv.nv_emission_date::date AS emission_date,
            nv.client_name,
            nv.city_raw,
            logistica.normalize_city(p_company_id, nv.city_raw) AS city_norm,
            COALESCE(
               (SELECT city_id FROM logistica.city_aliases ca WHERE ca.company_id = p_company_id AND lower(ca.raw_city) = lower(trim(nv.city_raw)) AND ca.active = true LIMIT 1),
               (SELECT id FROM logistica.dispatch_cities dc WHERE dc.company_id = p_company_id AND lower(dc.name) = lower(trim(nv.city_raw)) AND dc.active = true LIMIT 1)
            ) AS resolved_city_id,
            nv.seller_name,
            nv.total_quantity,
            nv.total_amount
        FROM integraciones.vw_bsale_sales_orders_for_preparation nv
        WHERE nv.company_id = p_company_id
          AND nv.nv_emission_date::date >= p_go_live_from_date
          -- Excluimos las que ya están en cards
          AND NOT EXISTS (
              SELECT 1 FROM logistica.sales_order_preparation_cards c
              WHERE c.company_id = p_company_id AND c.bsale_nv_id = nv.bsale_id
          )
    ),
    -- Expandimos un set de fechas en el rango solicitado
    route_dates AS (
        SELECT generate_series(p_route_from_date, p_route_to_date, '1 day'::interval)::date AS r_date
    ),
    route_mapping AS (
        SELECT 
            rd.r_date,
            EXTRACT(ISODOW FROM rd.r_date) AS r_weekday, -- 1 Lunes, 7 Domingo
            dcc.normalized_city,
            dcc.city_id,
            dcc.route_label
        FROM route_dates rd
        JOIN logistica.dispatch_calendar_cities dcc 
          ON dcc.company_id = p_company_id 
          AND dcc.active = true 
          AND dcc.weekday = EXTRACT(ISODOW FROM rd.r_date)
    )
    SELECT 
        b.nv_id,
        b.folio,
        b.emission_date,
        b.client_name,
        b.city_raw,
        b.city_norm,
        rm.city_id,
        b.seller_name,
        b.total_quantity,
        b.total_amount,
        rm.r_date AS calculated_route_date,
        rm.r_weekday::int,
        rm.route_label,
        'OK'::text AS match_status
    FROM base_nvs b
    -- Cruce principal usando city_id si el calendario lo tiene (y la NV lo resolvió). 
    -- Como fallback usamos el string normalized_city contra el calculado.
    JOIN route_mapping rm 
      ON (rm.city_id IS NOT NULL AND b.resolved_city_id = rm.city_id)
      OR (rm.city_id IS NULL AND lower(b.city_norm) = lower(rm.normalized_city))
    -- Consideramos un límite opcional
    LIMIT COALESCE(p_limit, 1000000);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- 6. Función de Materialización por Ruta
-- ============================================================================
CREATE OR REPLACE FUNCTION logistica.sync_sales_order_preparation_cards_for_route(
  p_company_id uuid,
  p_go_live_from_date date,
  p_route_from_date date,
  p_route_to_date date,
  p_limit integer DEFAULT NULL
)
RETURNS TABLE (inserted_count int) AS $$
DECLARE
  v_inserted int := 0;
BEGIN
    WITH candidates AS (
        SELECT *
        FROM logistica.preview_sales_order_route_candidates(
            p_company_id, p_go_live_from_date, p_route_from_date, p_route_to_date, p_limit
        )
    ),
    inserted AS (
        INSERT INTO logistica.sales_order_preparation_cards (
            company_id,
            bsale_nv_id,
            bsale_nv_folio,
            status,
            normalized_city,
            raw_city,
            route_date,
            priority
        )
        SELECT 
            p_company_id,
            c.nv_bsale_id,
            c.nv_folio,
            'PENDING_ROUTE_PREP',
            c.normalized_city,
            c.raw_city,
            c.route_date,
            0
        FROM candidates c
        ON CONFLICT (company_id, bsale_nv_id) DO NOTHING
        RETURNING id
    )
    SELECT count(*) INTO v_inserted FROM inserted;

    RETURN QUERY SELECT v_inserted;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Grants
GRANT EXECUTE ON FUNCTION logistica.normalize_city(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.preview_sales_order_route_candidates(uuid, date, date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION logistica.sync_sales_order_preparation_cards_for_route(uuid, date, date, date, integer) TO service_role;
