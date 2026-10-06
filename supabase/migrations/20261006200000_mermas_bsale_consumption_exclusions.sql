-- Auditable exclusions prevent intentional Bsale cleanup records from returning
-- through the overlap window of the Mermas sync.

CREATE TABLE IF NOT EXISTS mermas.bsale_consumption_exclusions (
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  consumption_id bigint NOT NULL CHECK (consumption_id > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  excluded_by uuid NOT NULL REFERENCES portal.users(id),
  excluded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, consumption_id)
);

ALTER TABLE mermas.bsale_consumption_exclusions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON mermas.bsale_consumption_exclusions TO authenticated;
GRANT ALL ON mermas.bsale_consumption_exclusions TO service_role;

CREATE POLICY mermas_bsale_consumption_exclusions_select
  ON mermas.bsale_consumption_exclusions
  FOR SELECT TO authenticated
  USING (core.has_company_access(auth.uid(), company_id)
    AND portal.has_permission('logistica.mermas.view'));

-- QA cleanup: associate the exclusion with the operator who created the existing outbound.
INSERT INTO mermas.bsale_consumption_exclusions(
  company_id, consumption_id, reason, excluded_by
)
SELECT o.company_id, o.bsale_consumption_id,
  'Limpieza QA MER-2026-000015', o.created_by
FROM mermas.bsale_outbound_operations o
WHERE o.company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
  AND o.bsale_consumption_id = 2620
ON CONFLICT (company_id, consumption_id) DO NOTHING;

ALTER FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb)
  RENAME TO process_bsale_consumption_unfiltered;

CREATE OR REPLACE FUNCTION mermas.process_bsale_consumption(
  p_company_id uuid,
  p_user_id uuid,
  p_header jsonb,
  p_details jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core, portal, mermas
AS $$
DECLARE
  v_consumption_id bigint := NULLIF(p_header->>'id', '')::bigint;
  v_type integer := NULLIF(p_header->>'consumptionTypeId', '')::integer;
BEGIN
  IF NOT core.has_company_access(p_user_id, p_company_id)
     OR NOT core.has_permission_for_company(p_user_id, p_company_id, 'logistica.mermas.sync') THEN
    RAISE EXCEPTION 'No autorizado para sincronizar Mermas';
  END IF;
  IF v_consumption_id IS NULL OR v_type IS DISTINCT FROM 2 THEN
    RETURN jsonb_build_object('accepted', false, 'excluded', false,
      'new_details', 0, 'new_movements', 0, 'movements', 0);
  END IF;
  IF EXISTS (
    SELECT 1 FROM mermas.bsale_consumption_exclusions e
    WHERE e.company_id = p_company_id AND e.consumption_id = v_consumption_id
  ) THEN
    RETURN jsonb_build_object('accepted', false, 'excluded', true,
      'consumption_id', v_consumption_id, 'new_details', 0,
      'new_movements', 0, 'movements', 0);
  END IF;
  RETURN mermas.process_bsale_consumption_unfiltered(
    p_company_id, p_user_id, p_header, p_details
  );
END;
$$;

REVOKE ALL ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mermas.process_bsale_consumption(uuid, uuid, jsonb, jsonb)
  TO service_role;
