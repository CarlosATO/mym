-- MYM/PetGroup — primera materialización desde NV vigente, preservando versiones aceptadas.
-- Versión remota registrada: 20261028175733 (Supabase production).
-- Compatibilidad: el bloque de aceptación 7A.3-7A.5 permanece intacto.
BEGIN;

CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_preparation_snapshot(p_company_id uuid, p_card_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'logistica', 'integraciones', 'public'
AS $function$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_accepted_version logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_inserted integer;
  v_initial_nv_id bigint;
BEGIN
  SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
   WHERE id = p_card_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tarjeta no encontrada para la empresa.';
  END IF;

  SELECT * INTO v_accepted_version
    FROM logistica.sales_order_preparation_commercial_versions
   WHERE company_id = p_company_id AND card_id = p_card_id
   ORDER BY sequence_no DESC
   LIMIT 1;

  IF FOUND THEN
    -- La tarjeta puede apuntar a una versión física posterior. La versión
    -- aceptada debe ser consistente con su propio snapshot, no con Bsale
    -- actual, que aún no ha sido aceptado.
    IF v_accepted_version.canonical_bsale_token IS DISTINCT FROM v_card.canonical_bsale_token
       OR jsonb_typeof(v_accepted_version.version_snapshot->'identity') IS DISTINCT FROM 'object'
       OR v_accepted_version.version_snapshot->'identity'->>'canonicalToken' IS DISTINCT FROM v_accepted_version.canonical_bsale_token
       OR NULLIF(v_accepted_version.version_snapshot->>'physicalId', '') IS NULL
       OR (v_accepted_version.version_snapshot->>'physicalId') !~ '^[0-9]+$'
       OR jsonb_typeof(v_accepted_version.version_snapshot->'lines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'La versión comercial aceptada no coincide con su propio snapshot.';
    END IF;
    IF v_accepted_version.current_bsale_nv_id IS DISTINCT FROM (v_accepted_version.version_snapshot->>'physicalId')::bigint THEN
      RAISE EXCEPTION 'La versión comercial aceptada tiene un ID físico inconsistente con su snapshot.';
    END IF;

    -- Un snapshot aceptado inválido no puede habilitar un fallback al histórico.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
       WHERE jsonb_typeof(accepted_line.value) <> 'object'
          OR NULLIF(accepted_line.value->>'detailId', '') IS NULL
          OR (accepted_line.value->>'detailId') !~ '^[0-9]+$'
    ) THEN
      RAISE EXCEPTION 'La versión comercial aceptada contiene líneas sin detailId válido.';
    END IF;

    -- La correspondencia operativa es comercial y multiconjunto. detailId no
    -- se compara: puede pertenecer a la versión física histórica 92706.
    IF EXISTS (
      WITH accepted_lines AS (
        SELECT
          NULLIF(value->>'variantId', '')::bigint AS variant_id,
          NULLIF(upper(btrim(value->>'sku')), '') AS sku,
          (value->>'quantity')::numeric AS quantity
        FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS item(value)
      ), active_lines AS (
        SELECT
          bsale_variant_id AS variant_id,
          NULLIF(upper(btrim(sku)), '') AS sku,
          requested_quantity AS quantity
        FROM logistica.sales_order_preparation_lines
        WHERE company_id = p_company_id
          AND card_id = p_card_id
          AND retired_at IS NULL
      ), differences AS (
        (SELECT variant_id, sku, quantity FROM accepted_lines
         EXCEPT ALL
         SELECT variant_id, sku, quantity FROM active_lines)
        UNION ALL
        (SELECT variant_id, sku, quantity FROM active_lines
         EXCEPT ALL
         SELECT variant_id, sku, quantity FROM accepted_lines)
      )
      SELECT 1 FROM differences
    ) THEN
      RAISE EXCEPTION 'Las líneas activas no corresponden comercialmente a la versión aceptada.';
    END IF;

    -- Cuando existen acciones históricas, sus KEEP/UPDATE deben apuntar a una
    -- línea persistente y sus ADD deben aportar una línea comercial. Se vuelve
    -- a comparar como multiconjunto para detectar faltantes, sobrantes y
    -- duplicaciones en las acciones, sin exigir detailId físico.
    IF jsonb_array_length(COALESCE(v_accepted_version.applied_actions, '[]'::jsonb)) > 0 THEN
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_accepted_version.applied_actions) AS action(value)
        LEFT JOIN logistica.sales_order_preparation_lines action_line
          ON action_line.id::text = action.value->>'preparationLineId'
         AND action_line.company_id = p_company_id
         AND action_line.card_id = p_card_id
        WHERE action.value->>'kind' IN ('KEEP', 'UPDATE_QUANTITY')
          AND (
            action_line.id IS NULL
            OR action_line.retired_at IS NOT NULL
            OR action_line.requested_quantity IS DISTINCT FROM (action.value->>'newRequestedQuantity')::numeric
          )
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_accepted_version.applied_actions) AS action(value)
        LEFT JOIN logistica.sales_order_preparation_lines action_line
          ON action_line.id::text = action.value->>'preparationLineId'
         AND action_line.company_id = p_company_id
         AND action_line.card_id = p_card_id
        WHERE action.value->>'kind' = 'REMOVE'
          AND (action_line.id IS NULL OR action_line.retired_at IS NULL)
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_accepted_version.applied_actions) AS action(value)
        WHERE action.value->>'kind' = 'ADD'
          AND (
            action.value->'current' IS NULL
            OR (
              NULLIF(action.value->'current'->>'variantId', '') IS NULL
              AND NULLIF(btrim(action.value->'current'->>'sku'), '') IS NULL
            )
            OR NULLIF(action.value->'current'->>'quantity', '') IS NULL
          )
      ) THEN
        RAISE EXCEPTION 'Las acciones aceptadas no corresponden a líneas persistidas válidas.';
      END IF;

      IF EXISTS (
        WITH accepted_lines AS (
          SELECT
            NULLIF(value->>'variantId', '')::bigint AS variant_id,
            NULLIF(upper(btrim(value->>'sku')), '') AS sku,
            (value->>'quantity')::numeric AS quantity
          FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS item(value)
        ), action_lines AS (
          SELECT
            CASE WHEN action.value->>'kind' = 'ADD'
              THEN NULLIF(action.value->'current'->>'variantId', '')::bigint
              ELSE action_line.bsale_variant_id
            END AS variant_id,
            CASE WHEN action.value->>'kind' = 'ADD'
              THEN NULLIF(upper(btrim(action.value->'current'->>'sku')), '')
              ELSE NULLIF(upper(btrim(action_line.sku)), '')
            END AS sku,
            CASE WHEN action.value->>'kind' = 'ADD'
              THEN (action.value->'current'->>'quantity')::numeric
              ELSE (action.value->>'newRequestedQuantity')::numeric
            END AS quantity
          FROM jsonb_array_elements(v_accepted_version.applied_actions) AS action(value)
          LEFT JOIN logistica.sales_order_preparation_lines action_line
            ON action_line.id::text = action.value->>'preparationLineId'
           AND action_line.company_id = p_company_id
           AND action_line.card_id = p_card_id
          WHERE action.value->>'kind' IN ('KEEP', 'UPDATE_QUANTITY', 'ADD')
        ), differences AS (
          (SELECT variant_id, sku, quantity FROM accepted_lines
           EXCEPT ALL
           SELECT variant_id, sku, quantity FROM action_lines)
          UNION ALL
          (SELECT variant_id, sku, quantity FROM action_lines
           EXCEPT ALL
           SELECT variant_id, sku, quantity FROM accepted_lines)
        )
        SELECT 1 FROM differences
      ) THEN
        RAISE EXCEPTION 'Las acciones aceptadas no corresponden al snapshot comercial.';
      END IF;
    END IF;

    -- No se consulta Bsale ni se rematerializa la versión física pendiente.
    RETURN 0;
  END IF;

  -- No se reconstruye el snapshot histórico para tarjetas que ya llegaron a
  -- Auditoría o a un estado posterior.
  IF v_card.status NOT IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') THEN
    RETURN 0;
  END IF;

  -- Primera materializacion: si Bsale regenero el documento, seleccionar la
  -- version vigente unicamente cuando aun NO existe ninguna linea operativa.
  -- No modificar una preparacion iniciada ni una version aceptada.
  v_initial_nv_id := v_card.bsale_nv_id;
  IF v_card.current_bsale_nv_id IS DISTINCT FROM v_card.bsale_nv_id
     AND NOT EXISTS (
       SELECT 1 FROM logistica.sales_order_preparation_lines l
       WHERE l.company_id = p_company_id AND l.card_id = p_card_id
     ) THEN
    SELECT nv.bsale_id INTO v_initial_nv_id
      FROM integraciones.bsale_documents nv
     WHERE nv.company_id = p_company_id
       AND nv.bsale_id = v_card.current_bsale_nv_id
       AND nv.document_type_id = 23
       AND nv.state = 0
       AND nv.number::text = v_card.bsale_nv_folio
       AND nullif(btrim(nv.raw_json->>'token'), '') = v_card.canonical_bsale_token;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La Nota de Venta vigente no coincide con el folio, token y empresa.';
    END IF;
  END IF;

  -- Sólo se materializa la fotografía inicial cuando todavía no existe una
  -- versión comercial aceptada.
  INSERT INTO logistica.sales_order_preparation_lines (
    company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
    sku, product_name, requested_quantity, source_snapshot
  )
  SELECT i.company_id, v_card.id, i.nv_bsale_id, i.detail_id, i.variant_id,
         i.sku, i.product_name, i.quantity, to_jsonb(i)
    FROM integraciones.vw_bsale_sales_order_items_for_preparation i
   WHERE i.company_id = p_company_id AND i.nv_bsale_id = v_initial_nv_id
   ON CONFLICT (company_id, card_id, bsale_detail_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Impedir que el usuario inicie preparacion si no existe ninguna linea.
  IF v_inserted = 0 AND NOT EXISTS (
    SELECT 1 FROM logistica.sales_order_preparation_lines l
    WHERE l.company_id = p_company_id AND l.card_id = p_card_id
  ) THEN
    RAISE EXCEPTION 'No se encontraron productos de la Nota de Venta; no se puede iniciar la preparacion.';
  END IF;
  RETURN v_inserted;
END;
$function$
;

COMMIT;
