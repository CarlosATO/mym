-- PERF-03A: read-only operator RPC. Prepared locally; do not apply automatically.
-- Keep the shared administration board and all existing RLS policies unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.get_operator_preparation_board_v1(p_company_id uuid)
RETURNS TABLE (
  card_id uuid, company_id uuid, status text, priority integer,
  assigned_user_id uuid, route_date date, normalized_city text,
  nv_bsale_id integer, nv_folio integer, nv_emission_date date,
  nv_generation_date timestamptz, client_name text, city_raw text,
  municipality_raw text, address_raw text, seller_bsale_id integer,
  seller_name text, total_quantity numeric, total_amount numeric,
  invoice_folio text, is_invoiced boolean, created_at timestamptz,
  updated_at timestamptz, net_amount numeric, tax_amount numeric,
  gross_amount numeric, locked_by_user_id uuid, locked_at timestamptz,
  route_readiness text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_allowed boolean;
BEGIN
  -- Match the application's active profile/company and effective company role.
  -- Both permission helpers are intentional: preserve the global module gate
  -- and the company gate used by readiness, including explicit denials.
  -- authorization:start
  SELECT
    v_actor IS NOT NULL
    AND p_company_id IS NOT NULL
    AND auth.role() = 'authenticated'
    AND EXISTS (
      SELECT 1 FROM portal.users u
      WHERE u.id = v_actor AND u.is_active = true AND u.deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM core.companies co
      WHERE co.id = p_company_id AND co.is_active = true
    )
    AND EXISTS (
      SELECT 1 FROM core.user_company_access uca
      WHERE uca.user_id = v_actor AND uca.company_id = p_company_id
        AND uca.is_active = true AND uca.role = 'OPERADOR_BODEGA'
    )
    AND core.has_company_access(v_actor, p_company_id)
    AND portal.user_has_permission(v_actor, 'module.logistica.view')
    AND core.has_permission_for_company(v_actor, p_company_id, 'module.logistica.view')
  INTO v_allowed;
  -- authorization:end
  IF v_allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'OPERATOR_PREPARATION_ACCESS_DENIED';
  END IF;

  RETURN QUERY
  -- board:start
  WITH canonical_documents AS MATERIALIZED (
    -- One canonical NV per raw token for this company. DISTINCT ON preserves
    -- the shared view's row_number ordering while avoiding other companies.
    SELECT DISTINCT ON (d.raw_json ->> 'token')
      d.bsale_id, d.number, d.emission_date, d.generation_date,
      d.client_id, d.raw_json, d.state,
      d.total_amount, d.net_amount, d.tax_amount
    FROM integraciones.bsale_documents d
    WHERE d.company_id = p_company_id
      AND d.document_type_id = 23
      AND NULLIF(btrim(d.raw_json ->> 'token'), '') IS NOT NULL
    ORDER BY d.raw_json ->> 'token', d.generation_date DESC NULLS LAST, d.bsale_id DESC
  ), candidate_cards AS MATERIALIZED (
    SELECT c.id, c.company_id, c.status, c.priority, c.assigned_user_id,
      c.route_date, c.normalized_city, c.bsale_nv_id, c.current_bsale_nv_id,
      c.canonical_bsale_token, c.created_at, c.updated_at,
      c.locked_by_user_id, c.locked_at
    FROM logistica.sales_order_preparation_cards c
    WHERE c.company_id = p_company_id
      AND c.closed_at IS NULL
      AND c.status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED')
  ), eligible_cards AS MATERIALIZED (
    SELECT c.*, d.bsale_id AS nv_id, d.number AS nv_number,
      d.emission_date, d.generation_date, d.client_id, d.raw_json,
      d.total_amount, d.net_amount, d.tax_amount,
      CASE WHEN c.status = 'AUDITED' THEN
        CASE WHEN d.state IS DISTINCT FROM 0 THEN 'BLOCKED'
             ELSE 'INCIDENTS' END
      ELSE NULL::text END AS operational_readiness
    FROM candidate_cards c
    JOIN canonical_documents d
      ON d.bsale_id = COALESCE(c.current_bsale_nv_id, c.bsale_nv_id)
    WHERE d.state IN (0, 8888)
      -- A pointer to a superseded physical version does not match canonical
      -- documents and is excluded, exactly like the shared NV view.
      -- The old lateral chooses one type-5 invoice. For is_invoiced=false,
      -- existence is equivalent; do NOT add state/cancellation filters here.
      AND NOT EXISTS (
        SELECT 1 FROM integraciones.bsale_invoice_sales_order_links link
        JOIN integraciones.bsale_documents inv
          ON inv.company_id = link.company_id AND inv.bsale_id = link.invoice_bsale_id
         AND inv.document_type_id = 5
        WHERE link.company_id = c.company_id AND link.sales_order_bsale_id = d.bsale_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_exclusions e
        WHERE e.company_id = c.company_id AND e.active = true
          AND (e.bsale_nv_id = c.bsale_nv_id OR e.bsale_nv_id = c.current_bsale_nv_id
            OR (c.canonical_bsale_token IS NOT NULL AND EXISTS (
              SELECT 1 FROM integraciones.bsale_documents excluded_nv
              WHERE excluded_nv.company_id = e.company_id
                AND excluded_nv.bsale_id = e.bsale_nv_id
                AND excluded_nv.document_type_id = 23
                AND NULLIF(btrim(excluded_nv.raw_json ->> 'token'), '') = c.canonical_bsale_token
            )))
      )
      -- In this candidate set the NV exists and closed_at is NULL. Therefore
      -- readiness is BLOCKED for 8888, INCIDENTS for OPEN, otherwise restricted.
      AND (c.status <> 'AUDITED' OR d.state IS DISTINCT FROM 0 OR EXISTS (
        SELECT 1 FROM logistica.sales_order_preparation_incidents i
        WHERE i.company_id = c.company_id AND i.card_id = c.id AND i.status = 'OPEN'
      ))
  )
  SELECT c.id, c.company_id, c.status, c.priority, c.assigned_user_id,
    c.route_date, c.normalized_city, c.nv_id, c.nv_number,
    c.emission_date, c.generation_date, client.company::text,
    c.raw_json ->> 'city', c.raw_json ->> 'municipality', c.raw_json ->> 'address',
    (c.raw_json -> 'user' ->> 'id')::integer, seller.name::text,
    (SELECT sum(x.quantity) FROM integraciones.bsale_document_details x
     WHERE x.company_id = c.company_id AND x.bsale_document_id = c.nv_id),
    c.total_amount, NULL::text, false, c.created_at, c.updated_at,
    c.net_amount, c.tax_amount, c.total_amount, c.locked_by_user_id, c.locked_at,
    c.operational_readiness
  FROM eligible_cards c
  LEFT JOIN integraciones.bsale_clients client
    ON client.company_id = c.company_id AND client.bsale_client_id = c.client_id
  LEFT JOIN integraciones.bsale_sellers seller
    ON seller.company_id = c.company_id
   AND seller.bsale_id = (c.raw_json -> 'user' ->> 'id')::integer
  ORDER BY c.priority DESC, c.emission_date ASC;
  -- board:end
END;
$function$;

REVOKE ALL ON FUNCTION logistica.get_operator_preparation_board_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION logistica.get_operator_preparation_board_v1(uuid) TO authenticated;

COMMENT ON FUNCTION logistica.get_operator_preparation_board_v1(uuid) IS
  'Operational operator board with invoker RLS; visible NV fields preserved; restricted columns and invoice/guide processing excluded.';

COMMIT;
