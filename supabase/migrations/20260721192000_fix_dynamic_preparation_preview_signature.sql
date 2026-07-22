-- Mantiene una sola firma pública para la preview y evita ambigüedad con defaults heredados.

ALTER FUNCTION logistica.preview_next_route_candidates(uuid, timestamptz)
  RENAME TO preview_next_route_candidates_with_min_generation_date;

CREATE OR REPLACE FUNCTION logistica.preview_next_route_candidates(
  p_company_id uuid
)
RETURNS jsonb AS $$
DECLARE
  v_context record;
  v_min_generation_date timestamptz;
BEGIN
  SELECT * INTO v_context
  FROM logistica.get_next_dispatch_route_context(p_company_id);

  IF v_context.route_date IS NULL THEN
    RETURN jsonb_build_object('has_route', false);
  END IF;

  v_min_generation_date := (
    ((v_context.cutoff_at AT TIME ZONE 'America/Santiago')::date - 7)::timestamp
    AT TIME ZONE 'America/Santiago'
  );

  RETURN logistica.preview_next_route_candidates_with_min_generation_date(p_company_id, v_min_generation_date);
END;
$$ LANGUAGE plpgsql STABLE;
