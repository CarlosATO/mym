-- Entrada idempotente para materialización automática posterior al sync de documentos Bsale.

CREATE OR REPLACE FUNCTION logistica.materialize_next_route_preparation_cards(
  p_company_id uuid,
  p_source text DEFAULT 'AUTO_SYNC'
)
RETURNS jsonb AS $$
DECLARE
  v_before jsonb;
  v_materialization jsonb;
  v_after jsonb;
BEGIN
  v_before := logistica.preview_next_route_candidates(p_company_id);

  IF COALESCE((v_before->>'has_route')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('has_route', false, 'source', p_source);
  END IF;

  v_materialization := logistica.sync_next_route_preparation_cards(
    p_company_id,
    NULL,
    false,
    NULL
  );
  v_after := logistica.preview_next_route_candidates(p_company_id);

  RETURN jsonb_build_object(
    'has_route', true,
    'source', p_source,
    'route_date', v_after->>'route_date',
    'cities', v_after->'cities',
    'materialized', COALESCE((v_materialization->>'would_insert_cards')::integer, 0),
    'reprogrammed', COALESCE((v_materialization->>'would_reprogram_cards')::integer, 0),
    'existing', COALESCE((v_after->'counts'->>'existing_cards')::integer, 0),
    'out_of_cutoff', COALESCE((v_after->'counts'->>'out_cutoff')::integer, 0),
    'exceptions', COALESCE((v_after->'counts'->>'exceptions')::integer, 0),
    'completed_at', now()
  );
END;
$$ LANGUAGE plpgsql VOLATILE;

GRANT EXECUTE ON FUNCTION logistica.materialize_next_route_preparation_cards(uuid, text) TO service_role;
