
CREATE FUNCTION rutas.lookup_geocode_cache_v1(
  p_company_id uuid,
  p_destinations jsonb
)
RETURNS TABLE (
  country_code text,
  commune_key text,
  address_key text,
  status text,
  latitude numeric,
  longitude numeric,
  accuracy_label text,
  provider text,
  provider_place_id text,
  matched_address text,
  fetched_at timestamptz,
  expires_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'company_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_destinations IS NULL
     OR jsonb_typeof(p_destinations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_destinations) > 100 THEN
    RAISE EXCEPTION 'destinations must be a JSON array with at most 100 entries'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH requested AS (
      SELECT DISTINCT
        COALESCE(NULLIF(btrim(d.country_code), ''), 'CL') AS requested_country,
        btrim(d.commune_key) AS requested_commune,
        btrim(d.address_key) AS requested_address
      FROM jsonb_to_recordset(p_destinations)
        AS d(country_code text, commune_key text, address_key text)
    )
    SELECT
      cache.country_code,
      cache.commune_key,
      cache.address_key,
      cache.status,
      cache.latitude,
      cache.longitude,
      cache.accuracy_label,
      cache.provider,
      cache.provider_place_id,
      cache.matched_address,
      cache.fetched_at,
      cache.expires_at
    FROM requested req
    JOIN rutas.geocode_cache cache
      ON cache.company_id = p_company_id
     AND cache.country_code = req.requested_country
     AND cache.commune_key = req.requested_commune
     AND cache.address_key = req.requested_address
    WHERE cache.expires_at > now();
END;
$function$;

REVOKE ALL ON FUNCTION rutas.lookup_geocode_cache_v1(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION rutas.lookup_geocode_cache_v1(uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION rutas.lookup_geocode_cache_v1(uuid, jsonb) TO service_role;
COMMENT ON FUNCTION rutas.lookup_geocode_cache_v1(uuid, jsonb)
IS 'Busca hasta 100 claves de direccion en una llamada, solo dentro de la empresa indicada y omitiendo entradas vencidas. No consulta servicios externos. Acceso exclusivo al servidor.';
