-- Preparacion operacional: snapshot de lineas, cantidades reales e incidencias.
-- No modifica Bsale ni altera datos del espejo integraciones.*.

CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE CASCADE,
    bsale_nv_id bigint NOT NULL,
    bsale_detail_id bigint NOT NULL,
    bsale_variant_id bigint,
    sku text,
    product_name text NOT NULL,
    requested_quantity numeric NOT NULL CHECK (requested_quantity >= 0),
    prepared_quantity numeric CHECK (prepared_quantity IS NULL OR (prepared_quantity >= 0 AND prepared_quantity <= requested_quantity)),
    line_status text NOT NULL DEFAULT 'PENDING' CHECK (line_status IN ('PENDING', 'CONFIRMED', 'INCIDENT')),
    excluded_from_dispatch boolean NOT NULL DEFAULT false,
    confirmed_by uuid,
    confirmed_at timestamptz,
    source_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_order_preparation_lines_card_detail_key UNIQUE (company_id, card_id, bsale_detail_id),
    CONSTRAINT sales_order_preparation_lines_status_consistency CHECK (
        (line_status = 'PENDING' AND prepared_quantity IS NULL AND confirmed_by IS NULL AND confirmed_at IS NULL)
        OR (line_status IN ('CONFIRMED', 'INCIDENT') AND prepared_quantity IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_lines_card
    ON logistica.sales_order_preparation_lines(company_id, card_id, bsale_detail_id);

CREATE TABLE IF NOT EXISTS logistica.sales_order_preparation_incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id),
    card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id) ON DELETE RESTRICT,
    preparation_line_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_lines(id) ON DELETE RESTRICT,
    bsale_nv_id bigint NOT NULL,
    nv_folio text,
    bsale_detail_id bigint NOT NULL,
    bsale_variant_id bigint,
    sku text,
    product_name text NOT NULL,
    incident_type text NOT NULL CHECK (incident_type IN ('QUANTITY_REDUCTION', 'LINE_EXCLUDED')),
    reason_code text NOT NULL CHECK (reason_code IN ('SIN_STOCK', 'STOCK_INSUFICIENTE', 'PRODUCTO_DANADO', 'PRODUCTO_VENCIDO_NO_APTO', 'ERROR_PEDIDO', 'SOLICITUD_CLIENTE', 'OTRO')),
    observation text,
    requested_quantity numeric NOT NULL CHECK (requested_quantity >= 0),
    prepared_quantity numeric NOT NULL CHECK (prepared_quantity >= 0 AND prepared_quantity <= requested_quantity),
    difference_quantity numeric NOT NULL,
    required_bsale_action text NOT NULL CHECK (required_bsale_action IN ('SET_QUANTITY', 'REMOVE_LINE')),
    expected_bsale_quantity numeric NOT NULL CHECK (expected_bsale_quantity >= 0),
    status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUPERSEDED')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,
    issued_at timestamptz,
    issued_by uuid,
    admin_applied_at timestamptz,
    admin_applied_by uuid,
    verification_status text,
    last_verified_at timestamptz,
    bsale_observed_quantity numeric,
    bsale_observed_snapshot jsonb
);

CREATE INDEX IF NOT EXISTS idx_sales_order_preparation_incidents_card
    ON logistica.sales_order_preparation_incidents(company_id, card_id, preparation_line_id, status);

ALTER TABLE logistica.sales_order_preparation_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.sales_order_preparation_incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_order_preparation_lines_select ON logistica.sales_order_preparation_lines;
CREATE POLICY sales_order_preparation_lines_select
    ON logistica.sales_order_preparation_lines FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));
DROP POLICY IF EXISTS sales_order_preparation_lines_service ON logistica.sales_order_preparation_lines;
CREATE POLICY sales_order_preparation_lines_service
    ON logistica.sales_order_preparation_lines FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_order_preparation_incidents_select ON logistica.sales_order_preparation_incidents;
CREATE POLICY sales_order_preparation_incidents_select
    ON logistica.sales_order_preparation_incidents FOR SELECT TO authenticated
    USING (core.has_company_access(auth.uid(), company_id));
DROP POLICY IF EXISTS sales_order_preparation_incidents_service ON logistica.sales_order_preparation_incidents;
CREATE POLICY sales_order_preparation_incidents_service
    ON logistica.sales_order_preparation_incidents FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE logistica.sales_order_preparation_lines FROM anon;
GRANT SELECT ON TABLE logistica.sales_order_preparation_lines TO authenticated;
GRANT ALL ON TABLE logistica.sales_order_preparation_lines TO service_role;
REVOKE ALL ON TABLE logistica.sales_order_preparation_incidents FROM anon;
GRANT SELECT ON TABLE logistica.sales_order_preparation_incidents TO authenticated;
GRANT ALL ON TABLE logistica.sales_order_preparation_incidents TO service_role;

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
    v_inserted integer;
BEGIN
    SELECT * INTO v_card
    FROM logistica.sales_order_preparation_cards
    WHERE id = p_card_id AND company_id = p_company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta no encontrada para la empresa.'; END IF;

    INSERT INTO logistica.sales_order_preparation_lines (
        company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id,
        sku, product_name, requested_quantity, source_snapshot
    )
    SELECT i.company_id, v_card.id, i.nv_bsale_id, i.detail_id, i.variant_id,
           i.sku, i.product_name, i.quantity,
           to_jsonb(i)
    FROM integraciones.vw_bsale_sales_order_items_for_preparation i
    WHERE i.company_id = p_company_id AND i.nv_bsale_id = v_card.bsale_nv_id
    ON CONFLICT (company_id, card_id, bsale_detail_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION logistica.get_sales_order_preparation_lines(
    p_company_id uuid,
    p_card_id uuid
)
RETURNS SETOF logistica.sales_order_preparation_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    SELECT * INTO v_card FROM logistica.sales_order_preparation_cards WHERE id = p_card_id AND company_id = p_company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tarjeta no encontrada.'; END IF;
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
    RETURN QUERY SELECT * FROM logistica.sales_order_preparation_lines
      WHERE company_id = p_company_id AND card_id = p_card_id ORDER BY bsale_detail_id;
END;
$$;

CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_preparation_line(
    p_company_id uuid,
    p_line_id uuid,
    p_prepared_quantity numeric,
    p_reason_code text DEFAULT NULL,
    p_observation text DEFAULT NULL,
    p_excluded boolean DEFAULT false
)
RETURNS logistica.sales_order_preparation_lines
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = logistica, public
AS $$
DECLARE
    v_actor uuid := auth.uid();
    v_line logistica.sales_order_preparation_lines%ROWTYPE;
    v_card logistica.sales_order_preparation_cards%ROWTYPE;
    v_incident_type text;
BEGIN
    IF v_actor IS NULL OR NOT core.has_company_access(v_actor, p_company_id) THEN
        RAISE EXCEPTION 'Sin acceso a la empresa indicada.';
    END IF;
    SELECT l.* INTO v_line FROM logistica.sales_order_preparation_lines l
      WHERE l.id = p_line_id AND l.company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linea de preparacion no encontrada.'; END IF;
    SELECT c.* INTO v_card FROM logistica.sales_order_preparation_cards c
      WHERE c.id = v_line.card_id AND c.company_id = p_company_id FOR UPDATE;
    IF NOT FOUND OR v_card.status <> 'IN_PREPARATION' THEN
        RAISE EXCEPTION 'La tarjeta debe estar En preparacion.';
    END IF;
    IF p_prepared_quantity IS NULL OR p_prepared_quantity < 0 OR p_prepared_quantity > v_line.requested_quantity THEN
        RAISE EXCEPTION 'La cantidad a despachar debe estar entre 0 y la cantidad solicitada.';
    END IF;
    IF p_excluded AND p_prepared_quantity <> 0 THEN
        RAISE EXCEPTION 'Una linea excluida debe quedar con cantidad 0.';
    END IF;
    IF (p_prepared_quantity < v_line.requested_quantity OR p_excluded)
       AND (p_reason_code IS NULL OR btrim(p_reason_code) = '') THEN
        RAISE EXCEPTION 'El motivo es obligatorio para una diferencia o exclusion.';
    END IF;
    IF p_reason_code = 'OTRO' AND (p_observation IS NULL OR btrim(p_observation) = '') THEN
        RAISE EXCEPTION 'La observacion es obligatoria para el motivo OTRO.';
    END IF;
    IF p_reason_code IS NOT NULL AND p_reason_code NOT IN ('SIN_STOCK', 'STOCK_INSUFICIENTE', 'PRODUCTO_DANADO', 'PRODUCTO_VENCIDO_NO_APTO', 'ERROR_PEDIDO', 'SOLICITUD_CLIENTE', 'OTRO') THEN
        RAISE EXCEPTION 'Motivo de incidencia invalido.';
    END IF;

    UPDATE logistica.sales_order_preparation_incidents
       SET status = 'SUPERSEDED', updated_at = now()
     WHERE company_id = p_company_id AND preparation_line_id = v_line.id AND status = 'OPEN';

    IF p_excluded OR p_prepared_quantity < v_line.requested_quantity THEN
        v_incident_type := CASE WHEN p_excluded THEN 'LINE_EXCLUDED' ELSE 'QUANTITY_REDUCTION' END;
        INSERT INTO logistica.sales_order_preparation_incidents (
            company_id, card_id, preparation_line_id, bsale_nv_id, nv_folio,
            bsale_detail_id, bsale_variant_id, sku, product_name, incident_type,
            reason_code, observation, requested_quantity, prepared_quantity,
            difference_quantity, required_bsale_action, expected_bsale_quantity,
            created_by
        ) VALUES (
            p_company_id, v_line.card_id, v_line.id, v_line.bsale_nv_id, v_card.bsale_nv_folio,
            v_line.bsale_detail_id, v_line.bsale_variant_id, v_line.sku, v_line.product_name,
            v_incident_type, p_reason_code, NULLIF(btrim(p_observation), ''),
            v_line.requested_quantity, p_prepared_quantity, p_prepared_quantity - v_line.requested_quantity,
            CASE WHEN p_excluded THEN 'REMOVE_LINE' ELSE 'SET_QUANTITY' END,
            p_prepared_quantity, v_actor
        );
    END IF;

    UPDATE logistica.sales_order_preparation_lines
       SET prepared_quantity = p_prepared_quantity,
           line_status = CASE WHEN p_excluded OR p_prepared_quantity < requested_quantity THEN 'INCIDENT' ELSE 'CONFIRMED' END,
           excluded_from_dispatch = p_excluded,
           confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
     WHERE id = v_line.id
     RETURNING * INTO v_line;
    RETURN v_line;
END;
$$;

REVOKE ALL ON FUNCTION logistica.materialize_sales_order_preparation_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.materialize_sales_order_preparation_snapshot(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION logistica.get_sales_order_preparation_lines(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.get_sales_order_preparation_lines(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION logistica.confirm_sales_order_preparation_line(uuid, uuid, numeric, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION logistica.confirm_sales_order_preparation_line(uuid, uuid, numeric, text, text, boolean) TO authenticated, service_role;

-- La materializacion queda dentro del mismo commit de la transicion a preparacion.
CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
  p_company_id uuid, p_card_id uuid, p_to_status text, p_observation text,
  p_user_id uuid, p_user_name text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = logistica, public AS $$
DECLARE
  v_card logistica.sales_order_preparation_cards%ROWTYPE;
  v_from_status text;
  v_pending integer;
BEGIN
  SELECT * INTO v_card FROM logistica.sales_order_preparation_cards WHERE id = p_card_id FOR UPDATE;
  IF NOT FOUND OR v_card.company_id <> p_company_id THEN RAISE EXCEPTION 'Tarjeta no encontrada o empresa invalida.'; END IF;
  v_from_status := v_card.status;
  IF v_from_status = 'PENDING_ROUTE_PREP' AND p_to_status <> 'IN_PREPARATION' THEN RAISE EXCEPTION 'Desde Pendiente solo se puede pasar a En Preparacion.'; END IF;
  IF v_from_status = 'IN_PREPARATION' AND p_to_status NOT IN ('IN_AUDIT', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde En Preparacion.'; END IF;
  IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN ('IN_PREPARATION', 'PENDING_ROUTE_PREP') THEN RAISE EXCEPTION 'Transicion invalida desde Auditoria.'; END IF;
  IF p_to_status = v_from_status THEN RAISE EXCEPTION 'La tarjeta ya se encuentra en el estado indicado.'; END IF;
  IF p_to_status IN ('PENDING_ROUTE_PREP', 'IN_PREPARATION') AND v_from_status = 'IN_AUDIT' OR p_to_status = 'PENDING_ROUTE_PREP' THEN
    IF p_observation IS NULL OR btrim(p_observation) = '' THEN RAISE EXCEPTION 'Se requiere observacion para retroceder.'; END IF;
  END IF;
  IF p_to_status = 'IN_PREPARATION' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
  ELSIF p_to_status = 'IN_AUDIT' THEN
    PERFORM logistica.materialize_sales_order_preparation_snapshot(p_company_id, p_card_id);
    SELECT count(*) INTO v_pending FROM logistica.sales_order_preparation_lines
      WHERE company_id = p_company_id AND card_id = p_card_id
        AND (line_status = 'PENDING' OR prepared_quantity IS NULL);
    IF v_pending > 0 THEN RAISE EXCEPTION 'Faltan % productos por confirmar.', v_pending; END IF;
  END IF;
  INSERT INTO logistica.sales_order_preparation_movements (
    company_id, card_id, from_status, to_status, moved_by, movement_source, observation, metadata
  ) VALUES (p_company_id, p_card_id, v_from_status, p_to_status, p_user_id, 'USER', p_observation,
    jsonb_build_object('moved_by_name', p_user_name));
  UPDATE logistica.sales_order_preparation_cards SET status = p_to_status, last_moved_by = p_user_id,
    last_moved_at = now(), updated_at = now() WHERE id = p_card_id;
  RETURN jsonb_build_object('card_id', p_card_id, 'from_status', v_from_status, 'to_status', p_to_status);
END;
$$;
REVOKE ALL ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION logistica.move_sales_order_preparation_card(uuid, uuid, text, text, uuid, text) TO service_role;
