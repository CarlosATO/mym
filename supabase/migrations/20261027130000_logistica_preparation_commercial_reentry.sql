-- Bloque 7A.4: permitir reingreso a preparación con una versión comercial
-- posterior todavía no aceptada.
--
-- La identidad comercial canónica identifica la NV lógica. El ID físico de
-- Bsale identifica una versión concreta y puede cambiar antes de la siguiente
-- aceptación. Mientras exista una versión aceptada, sus líneas materializadas
-- siguen siendo la autoridad operativa.

BEGIN;

CREATE OR REPLACE FUNCTION logistica.materialize_sales_order_preparation_snapshot(
  p_company_id uuid,
  p_card_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, integraciones, public
AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_accepted_version logistica.sales_order_preparation_commercial_versions%ROWTYPE;
  v_inserted integer;
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

    -- Las líneas activas deben seguir siendo exactamente las aceptadas.
    -- No se consulta Bsale ni se materializa la versión física pendiente.
    IF EXISTS (
      SELECT 1
        FROM logistica.sales_order_preparation_lines active_line
       WHERE active_line.company_id = p_company_id
         AND active_line.card_id = p_card_id
         AND active_line.retired_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
            WHERE (accepted_line.value->>'detailId')::bigint = active_line.bsale_detail_id
         )
    ) OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_accepted_version.version_snapshot->'lines') AS accepted_line(value)
       WHERE NOT EXISTS (
         SELECT 1
           FROM logistica.sales_order_preparation_lines active_line
          WHERE active_line.company_id = p_company_id
            AND active_line.card_id = p_card_id
            AND active_line.retired_at IS NULL
            AND active_line.bsale_detail_id = (accepted_line.value->>'detailId')::bigint
       )
    ) THEN
      RAISE EXCEPTION 'Las líneas activas no coinciden con la versión comercial aceptada.';
    END IF;

    RETURN 0;
  END IF;

  -- No se reconstruye el snapshot histórico para tarjetas que ya llegaron a
  -- Auditoría o a un estado posterior.
  IF v_card.status NOT IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') THEN
    RETURN 0;
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
   WHERE i.company_id = p_company_id AND i.nv_bsale_id = v_card.bsale_nv_id
   ON CONFLICT (company_id, card_id, bsale_detail_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

COMMIT;
