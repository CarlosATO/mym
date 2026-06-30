-- MIGRATION: 20260627200000_route_guides_module.sql

-- 1. Route Vehicles
CREATE TABLE IF NOT EXISTS logistica.route_vehicles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    vehicle_name text NOT NULL,
    plate_number text,
    description text,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_route_vehicles_name UNIQUE(company_id, vehicle_name)
);
CREATE UNIQUE INDEX idx_route_vehicles_plate ON logistica.route_vehicles (company_id, lower(plate_number)) WHERE plate_number IS NOT NULL;

-- 2. Delivery Routes
CREATE TABLE IF NOT EXISTS logistica.delivery_routes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_name text NOT NULL,
    description text,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_delivery_routes_name UNIQUE(company_id, route_name)
);

-- 3. Route Personnel
CREATE TABLE IF NOT EXISTS logistica.route_personnel (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    person_name text NOT NULL,
    person_type varchar(30) NOT NULL CHECK (person_type IN ('DRIVER', 'SELLER', 'DISPATCHER', 'OTHER')),
    phone text,
    email text,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_route_personnel_name_type UNIQUE(company_id, person_name, person_type)
);

-- 4. Route Guide Counters
CREATE TABLE IF NOT EXISTS logistica.route_guide_counters (
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    guide_year integer NOT NULL,
    last_sequence integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, guide_year)
);

-- 5. Route Guides
CREATE TABLE IF NOT EXISTS logistica.route_guides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    guide_year integer NOT NULL,
    guide_sequence integer NOT NULL,
    guide_number text NOT NULL,
    guide_date date NOT NULL,
    
    route_id uuid NOT NULL REFERENCES logistica.delivery_routes(id),
    route_name_snapshot text NOT NULL,
    
    vehicle_id uuid NOT NULL REFERENCES logistica.route_vehicles(id),
    vehicle_name_snapshot text NOT NULL,
    
    driver_id uuid NOT NULL REFERENCES logistica.route_personnel(id),
    driver_name_snapshot text NOT NULL,
    
    dispatcher_id uuid NOT NULL REFERENCES logistica.route_personnel(id),
    dispatcher_name_snapshot text NOT NULL,
    
    notes text,
    status varchar(30) NOT NULL CHECK (status IN ('DRAFT', 'DISPATCHED', 'CANCELLED')),
    
    total_invoices integer NOT NULL DEFAULT 0,
    total_amount numeric(14,2) NOT NULL DEFAULT 0,
    total_cash_expected numeric(14,2) NOT NULL DEFAULT 0,
    total_check_expected numeric(14,2) NOT NULL DEFAULT 0,
    total_credit numeric(14,2) NOT NULL DEFAULT 0,
    total_transfer numeric(14,2) NOT NULL DEFAULT 0,
    total_unknown_payment numeric(14,2) NOT NULL DEFAULT 0,
    
    error_count integer NOT NULL DEFAULT 0,
    duplicate_count integer NOT NULL DEFAULT 0,
    
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    dispatched_at timestamptz,
    
    CONSTRAINT uq_route_guides_year_seq UNIQUE(company_id, guide_year, guide_sequence),
    CONSTRAINT uq_route_guides_number UNIQUE(company_id, guide_number)
);

CREATE INDEX idx_route_guides_date ON logistica.route_guides (company_id, guide_date DESC);
CREATE INDEX idx_route_guides_status ON logistica.route_guides (company_id, status);
CREATE INDEX idx_route_guides_route ON logistica.route_guides (company_id, route_id);
CREATE INDEX idx_route_guides_vehicle ON logistica.route_guides (company_id, vehicle_id);
CREATE INDEX idx_route_guides_driver ON logistica.route_guides (company_id, driver_id);

-- 6. Route Guide Items
CREATE TABLE IF NOT EXISTS logistica.route_guide_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_guide_id uuid NOT NULL REFERENCES logistica.route_guides(id) ON DELETE CASCADE,
    line_number integer NOT NULL,
    invoice_number text NOT NULL,
    customer_name text NOT NULL,
    customer_address text NOT NULL,
    commune text NOT NULL,
    amount numeric(14,2) NOT NULL,
    payment_method_original text,
    payment_method_normalized varchar(30) NOT NULL CHECK (payment_method_normalized IN ('CASH', 'CHECK', 'TRANSFER', 'CREDIT', 'UNKNOWN')),
    requires_settlement boolean NOT NULL DEFAULT false,
    validation_status varchar(30) NOT NULL CHECK (validation_status IN ('VALID', 'INVALID')),
    validation_errors jsonb,
    notes text,
    settlement_status varchar(30) NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (settlement_status IN ('PENDING', 'NOT_REQUIRED', 'PENDING_REVIEW')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_route_guide_items_guide ON logistica.route_guide_items (company_id, route_guide_id);
CREATE INDEX idx_route_guide_items_invoice ON logistica.route_guide_items (company_id, invoice_number);
CREATE INDEX idx_route_guide_items_payment ON logistica.route_guide_items (company_id, payment_method_normalized);
CREATE INDEX idx_route_guide_items_settlement ON logistica.route_guide_items (company_id, settlement_status);

-- Triggers for updated_at
CREATE TRIGGER update_route_vehicles_updated_at BEFORE UPDATE ON logistica.route_vehicles FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_routes_updated_at BEFORE UPDATE ON logistica.delivery_routes FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_personnel_updated_at BEFORE UPDATE ON logistica.route_personnel FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_guides_updated_at BEFORE UPDATE ON logistica.route_guides FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_guide_items_updated_at BEFORE UPDATE ON logistica.route_guide_items FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

-- RLS Enable
ALTER TABLE logistica.route_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.delivery_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.route_personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.route_guide_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.route_guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistica.route_guide_items ENABLE ROW LEVEL SECURITY;

-- Grants
GRANT ALL ON ALL TABLES IN SCHEMA logistica TO authenticated, service_role;

-- Policies
CREATE POLICY rls_route_vehicles_select ON logistica.route_vehicles FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_vehicles_insert ON logistica.route_vehicles FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_vehicles_update ON logistica.route_vehicles FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_delivery_routes_select ON logistica.delivery_routes FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_delivery_routes_insert ON logistica.delivery_routes FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_delivery_routes_update ON logistica.delivery_routes FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_route_personnel_select ON logistica.route_personnel FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_personnel_insert ON logistica.route_personnel FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_personnel_update ON logistica.route_personnel FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_route_guide_counters_select ON logistica.route_guide_counters FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guide_counters_insert ON logistica.route_guide_counters FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guide_counters_update ON logistica.route_guide_counters FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_route_guides_select ON logistica.route_guides FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guides_insert ON logistica.route_guides FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guides_update ON logistica.route_guides FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));

CREATE POLICY rls_route_guide_items_select ON logistica.route_guide_items FOR SELECT USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guide_items_insert ON logistica.route_guide_items FOR INSERT WITH CHECK (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guide_items_update ON logistica.route_guide_items FOR UPDATE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));
CREATE POLICY rls_route_guide_items_delete ON logistica.route_guide_items FOR DELETE USING (portal.has_permission('system.admin') OR core.has_company_access(auth.uid(), company_id));


-- Register granular permissions
DO $$
DECLARE
    v_module_id uuid;
BEGIN
    SELECT id INTO v_module_id FROM portal.modules WHERE code = 'logistica';
    
    IF v_module_id IS NOT NULL THEN
        INSERT INTO portal.permissions (code, name, description, module_id)
        VALUES 
        ('logistica.route_guides.view', 'Ver Guías de Ruta', 'Puede ver las guías de ruta', v_module_id),
        ('logistica.route_guides.create', 'Crear Guías de Ruta', 'Puede crear nuevas guías de ruta', v_module_id),
        ('logistica.route_guides.update_draft', 'Editar Borrador de Guías de Ruta', 'Puede editar guías en borrador', v_module_id),
        ('logistica.route_guides.dispatch', 'Despachar Guías de Ruta', 'Puede confirmar el despacho de una guía', v_module_id),
        ('logistica.route_guides.print', 'Imprimir Guías de Ruta', 'Puede imprimir guías de ruta', v_module_id),
        ('logistica.route_guides.cancel', 'Anular Guías de Ruta', 'Puede anular guías de ruta', v_module_id),
        ('logistica.route_catalogs.manage', 'Gestionar Catálogos de Ruta', 'Puede gestionar vehículos, rutas y personal', v_module_id)
        ON CONFLICT (code) DO NOTHING;
    END IF;
END $$;


-- RPCs

-- Inline creations
CREATE OR REPLACE FUNCTION logistica.create_route_vehicle_inline(p_company_id uuid, p_vehicle_name text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO logistica.route_vehicles (company_id, vehicle_name, created_by)
    VALUES (p_company_id, p_vehicle_name, p_user_id)
    RETURNING id INTO v_id;
    
    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_id FROM logistica.route_vehicles WHERE company_id = p_company_id AND lower(vehicle_name) = lower(p_vehicle_name);
        RETURN jsonb_build_object('success', true, 'id', v_id);
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_delivery_route_inline(p_company_id uuid, p_route_name text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO logistica.delivery_routes (company_id, route_name, created_by)
    VALUES (p_company_id, p_route_name, p_user_id)
    RETURNING id INTO v_id;
    
    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_id FROM logistica.delivery_routes WHERE company_id = p_company_id AND lower(route_name) = lower(p_route_name);
        RETURN jsonb_build_object('success', true, 'id', v_id);
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION logistica.create_route_person_inline(p_company_id uuid, p_person_name text, p_person_type text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO logistica.route_personnel (company_id, person_name, person_type, created_by)
    VALUES (p_company_id, p_person_name, p_person_type, p_user_id)
    RETURNING id INTO v_id;
    
    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_id FROM logistica.route_personnel WHERE company_id = p_company_id AND lower(person_name) = lower(p_person_name) AND person_type = p_person_type;
        RETURN jsonb_build_object('success', true, 'id', v_id);
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Draft Operations
CREATE OR REPLACE FUNCTION logistica.create_route_guide_draft(
    p_company_id uuid,
    p_guide_data jsonb,
    p_items_data jsonb,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_year integer := date_part('year', (p_guide_data->>'guide_date')::date);
    v_sequence integer;
    v_guide_number text;
    v_guide_id uuid;
    v_item record;
BEGIN
    -- 1. Counter/Lock
    INSERT INTO logistica.route_guide_counters (company_id, guide_year, last_sequence)
    VALUES (p_company_id, v_year, 1)
    ON CONFLICT (company_id, guide_year) DO UPDATE
    SET last_sequence = logistica.route_guide_counters.last_sequence + 1, updated_at = now()
    RETURNING last_sequence INTO v_sequence;

    v_guide_number := 'GR-' || v_year::text || '-' || LPAD(v_sequence::text, 6, '0');

    -- 2. Insert Header
    INSERT INTO logistica.route_guides (
        company_id, guide_year, guide_sequence, guide_number, guide_date,
        route_id, route_name_snapshot,
        vehicle_id, vehicle_name_snapshot,
        driver_id, driver_name_snapshot,
        dispatcher_id, dispatcher_name_snapshot,
        notes, status,
        total_invoices, total_amount, total_cash_expected, total_check_expected, total_credit, total_transfer, total_unknown_payment,
        error_count, duplicate_count, created_by
    ) VALUES (
        p_company_id, v_year, v_sequence, v_guide_number, (p_guide_data->>'guide_date')::date,
        (p_guide_data->>'route_id')::uuid, p_guide_data->>'route_name_snapshot',
        (p_guide_data->>'vehicle_id')::uuid, p_guide_data->>'vehicle_name_snapshot',
        (p_guide_data->>'driver_id')::uuid, p_guide_data->>'driver_name_snapshot',
        (p_guide_data->>'dispatcher_id')::uuid, p_guide_data->>'dispatcher_name_snapshot',
        p_guide_data->>'notes', 'DRAFT',
        COALESCE((p_guide_data->>'total_invoices')::integer, 0),
        COALESCE((p_guide_data->>'total_amount')::numeric, 0),
        COALESCE((p_guide_data->>'total_cash_expected')::numeric, 0),
        COALESCE((p_guide_data->>'total_check_expected')::numeric, 0),
        COALESCE((p_guide_data->>'total_credit')::numeric, 0),
        COALESCE((p_guide_data->>'total_transfer')::numeric, 0),
        COALESCE((p_guide_data->>'total_unknown_payment')::numeric, 0),
        COALESCE((p_guide_data->>'error_count')::integer, 0),
        COALESCE((p_guide_data->>'duplicate_count')::integer, 0),
        p_user_id
    ) RETURNING id INTO v_guide_id;

    -- 3. Insert Items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_data) LOOP
        INSERT INTO logistica.route_guide_items (
            company_id, route_guide_id, line_number, invoice_number,
            customer_name, customer_address, commune, amount,
            payment_method_original, payment_method_normalized, requires_settlement,
            validation_status, validation_errors, notes, settlement_status
        ) VALUES (
            p_company_id, v_guide_id, (v_item.value->>'line_number')::integer, v_item.value->>'invoice_number',
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune', (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized', (v_item.value->>'requires_settlement')::boolean,
            v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb, v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;
    
    -- Audit log
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (p_company_id, p_user_id, 'ROUTE_GUIDE_CREATED', 'route_guide', v_guide_id, jsonb_build_object('guide_number', v_guide_number));

    RETURN jsonb_build_object('success', true, 'id', v_guide_id, 'guide_number', v_guide_number);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


CREATE OR REPLACE FUNCTION logistica.update_route_guide_draft(
    p_company_id uuid,
    p_guide_id uuid,
    p_guide_data jsonb,
    p_items_data jsonb,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_status text;
    v_item record;
BEGIN
    SELECT status INTO v_status FROM logistica.route_guides WHERE id = p_guide_id AND company_id = p_company_id;
    IF v_status IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Guía no encontrada');
    END IF;
    IF v_status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sólo se pueden editar guías en borrador');
    END IF;

    -- Update Header
    UPDATE logistica.route_guides SET
        guide_date = (p_guide_data->>'guide_date')::date,
        route_id = (p_guide_data->>'route_id')::uuid,
        route_name_snapshot = p_guide_data->>'route_name_snapshot',
        vehicle_id = (p_guide_data->>'vehicle_id')::uuid,
        vehicle_name_snapshot = p_guide_data->>'vehicle_name_snapshot',
        driver_id = (p_guide_data->>'driver_id')::uuid,
        driver_name_snapshot = p_guide_data->>'driver_name_snapshot',
        dispatcher_id = (p_guide_data->>'dispatcher_id')::uuid,
        dispatcher_name_snapshot = p_guide_data->>'dispatcher_name_snapshot',
        notes = p_guide_data->>'notes',
        total_invoices = COALESCE((p_guide_data->>'total_invoices')::integer, 0),
        total_amount = COALESCE((p_guide_data->>'total_amount')::numeric, 0),
        total_cash_expected = COALESCE((p_guide_data->>'total_cash_expected')::numeric, 0),
        total_check_expected = COALESCE((p_guide_data->>'total_check_expected')::numeric, 0),
        total_credit = COALESCE((p_guide_data->>'total_credit')::numeric, 0),
        total_transfer = COALESCE((p_guide_data->>'total_transfer')::numeric, 0),
        total_unknown_payment = COALESCE((p_guide_data->>'total_unknown_payment')::numeric, 0),
        error_count = COALESCE((p_guide_data->>'error_count')::integer, 0),
        duplicate_count = COALESCE((p_guide_data->>'duplicate_count')::integer, 0),
        updated_at = now()
    WHERE id = p_guide_id AND company_id = p_company_id;

    -- Replace items
    DELETE FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items_data) LOOP
        INSERT INTO logistica.route_guide_items (
            company_id, route_guide_id, line_number, invoice_number,
            customer_name, customer_address, commune, amount,
            payment_method_original, payment_method_normalized, requires_settlement,
            validation_status, validation_errors, notes, settlement_status
        ) VALUES (
            p_company_id, p_guide_id, (v_item.value->>'line_number')::integer, v_item.value->>'invoice_number',
            v_item.value->>'customer_name', v_item.value->>'customer_address', v_item.value->>'commune', (v_item.value->>'amount')::numeric,
            v_item.value->>'payment_method_original', v_item.value->>'payment_method_normalized', (v_item.value->>'requires_settlement')::boolean,
            v_item.value->>'validation_status', (v_item.value->>'validation_errors')::jsonb, v_item.value->>'notes',
            COALESCE(v_item.value->>'settlement_status', 'NOT_REQUIRED')
        );
    END LOOP;

    -- Audit log
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (p_company_id, p_user_id, 'ROUTE_GUIDE_UPDATED', 'route_guide', p_guide_id, '{}');

    RETURN jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;


CREATE OR REPLACE FUNCTION logistica.dispatch_route_guide(
    p_company_id uuid,
    p_guide_id uuid,
    p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_guide logistica.route_guides%ROWTYPE;
    v_has_errors boolean;
    v_has_unknown boolean;
    v_historical_dup boolean;
    v_internal_dup boolean;
    v_item record;
    
    v_total_invoices int := 0;
    v_total_amount numeric := 0;
    v_total_cash numeric := 0;
    v_total_check numeric := 0;
    v_total_credit numeric := 0;
    v_total_transfer numeric := 0;
BEGIN
    SELECT * INTO v_guide FROM logistica.route_guides WHERE id = p_guide_id AND company_id = p_company_id FOR UPDATE;
    IF v_guide.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Guía no encontrada');
    END IF;
    IF v_guide.status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sólo se pueden despachar guías en borrador');
    END IF;

    -- Validations
    SELECT EXISTS (SELECT 1 FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id AND validation_status = 'INVALID') INTO v_has_errors;
    IF v_has_errors THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar una guía con filas inválidas.');
    END IF;

    SELECT EXISTS (SELECT 1 FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id AND payment_method_normalized = 'UNKNOWN') INTO v_has_unknown;
    IF v_has_unknown THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar con formas de pago desconocidas (UNKNOWN).');
    END IF;

    -- Check internal dupes
    SELECT EXISTS (
        SELECT invoice_number FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id GROUP BY invoice_number HAVING count(*) > 1
    ) INTO v_internal_dup;
    IF v_internal_dup THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar con facturas duplicadas en la misma guía.');
    END IF;

    -- Check historical dupes (other guides that are not cancelled)
    SELECT EXISTS (
        SELECT 1 FROM logistica.route_guide_items rgi
        JOIN logistica.route_guides rg ON rgi.route_guide_id = rg.id
        WHERE rgi.company_id = p_company_id
          AND rg.status IN ('DRAFT', 'DISPATCHED')
          AND rg.id <> p_guide_id
          AND rgi.invoice_number IN (SELECT invoice_number FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id)
    ) INTO v_historical_dup;
    
    IF v_historical_dup THEN
        RETURN jsonb_build_object('success', false, 'error', 'No se puede despachar. Una o más facturas ya están incluidas en otra guía activa.');
    END IF;

    -- Recalculate totals
    FOR v_item IN SELECT * FROM logistica.route_guide_items WHERE route_guide_id = p_guide_id LOOP
        v_total_invoices := v_total_invoices + 1;
        v_total_amount := v_total_amount + v_item.amount;
        
        IF v_item.payment_method_normalized = 'CASH' THEN v_total_cash := v_total_cash + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'CHECK' THEN v_total_check := v_total_check + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'CREDIT' THEN v_total_credit := v_total_credit + v_item.amount;
        ELSIF v_item.payment_method_normalized = 'TRANSFER' THEN v_total_transfer := v_total_transfer + v_item.amount;
        END IF;
    END LOOP;

    -- Dispatch
    UPDATE logistica.route_guides SET
        status = 'DISPATCHED',
        dispatched_at = now(),
        updated_at = now(),
        total_invoices = v_total_invoices,
        total_amount = v_total_amount,
        total_cash_expected = v_total_cash,
        total_check_expected = v_total_check,
        total_credit = v_total_credit,
        total_transfer = v_total_transfer,
        total_unknown_payment = 0,
        error_count = 0,
        duplicate_count = 0
    WHERE id = p_guide_id;

    -- Audit log
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (p_company_id, p_user_id, 'ROUTE_GUIDE_DISPATCHED', 'route_guide', p_guide_id, '{}');

    RETURN jsonb_build_object('success', true, 'id', p_guide_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
