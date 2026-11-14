CREATE SCHEMA rutas;
COMMENT ON SCHEMA rutas IS 'Rutas Inteligentes: planificacion de entregas y calculos de recorridos; independiente de logistica y colaboradores';
REVOKE ALL ON SCHEMA rutas FROM PUBLIC;
REVOKE ALL ON SCHEMA rutas FROM anon, authenticated;
GRANT USAGE ON SCHEMA rutas TO service_role;

CREATE TABLE rutas.geocode_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  country_code text NOT NULL DEFAULT 'CL',
  address_key text NOT NULL,
  commune_key text NOT NULL,
  status text NOT NULL,
  latitude numeric(10,7),
  longitude numeric(10,7),
  accuracy_label text,
  provider text NOT NULL,
  provider_place_id text,
  matched_address text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT geocode_cache_country_code_check CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT geocode_cache_address_key_check CHECK (length(btrim(address_key)) BETWEEN 1 AND 300),
  CONSTRAINT geocode_cache_commune_key_check CHECK (length(btrim(commune_key)) BETWEEN 1 AND 120),
  CONSTRAINT geocode_cache_provider_check CHECK (length(btrim(provider)) BETWEEN 1 AND 60),
  CONSTRAINT geocode_cache_status_check CHECK (status IN ('RESOLVED','AMBIGUOUS','NOT_FOUND')),
  CONSTRAINT geocode_cache_coordinates_check CHECK (
    (
      status='RESOLVED' AND latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
    ) OR (
      status IN ('AMBIGUOUS','NOT_FOUND') AND latitude IS NULL AND longitude IS NULL
    )
  ),
  CONSTRAINT geocode_cache_expiry_check CHECK (expires_at > fetched_at),
  CONSTRAINT geocode_cache_key_unique UNIQUE (company_id, country_code, commune_key, address_key)
);

CREATE INDEX geocode_cache_company_expiry_idx ON rutas.geocode_cache (company_id, expires_at);
ALTER TABLE rutas.geocode_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rutas.geocode_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON rutas.geocode_cache TO service_role;

COMMENT ON TABLE rutas.geocode_cache IS 'Cache privado por empresa de resoluciones de direcciones. No implica direccion verificada del cliente ni seguimiento GPS.';
COMMENT ON COLUMN rutas.geocode_cache.address_key IS 'Direccion normalizada segun contrato de Rutas Inteligentes; no utilizar coincidencias ambiguas.';
COMMENT ON COLUMN rutas.geocode_cache.expires_at IS 'Caducidad obligatoria; la politica del proveedor puede limitar la retencion.';
