-- MIGRATION: 20260628000002_route_settlements.sql

-- 1. Create permissions
INSERT INTO portal.permissions (code, name, description) VALUES
('adquisiciones.route_settlements.view', 'Ver Rendiciones', 'Permite ver rendiciones de rutas'),
('adquisiciones.route_settlements.create', 'Crear Rendiciones', 'Permite crear rendiciones de rutas desde guías despachadas'),
('adquisiciones.route_settlements.update', 'Actualizar Rendiciones', 'Permite actualizar y cuadrar rendiciones de rutas en borrador'),
('adquisiciones.route_settlements.close', 'Cerrar Rendiciones', 'Permite cerrar rendiciones de rutas (cuadradas o con diferencias)'),
('adquisiciones.route_settlements.print', 'Imprimir Rendiciones', 'Permite imprimir el detalle de rendiciones de rutas'),
('adquisiciones.route_settlements.cancel', 'Anular Rendiciones', 'Permite anular rendiciones de rutas')
ON CONFLICT (code) DO NOTHING;

-- Assign permissions to roles
DO $$
DECLARE
    v_super_role_id uuid;
    v_gerencia_role_id uuid;
    v_finanzas_role_id uuid;
    v_adquisiciones_role_id uuid;
    v_role_id uuid;
BEGIN
    SELECT id INTO v_super_role_id FROM portal.roles WHERE name = 'SUPER_USUARIO';
    SELECT id INTO v_gerencia_role_id FROM portal.roles WHERE name = 'GERENCIA';
    SELECT id INTO v_finanzas_role_id FROM portal.roles WHERE name = 'FINANZAS';
    SELECT id INTO v_adquisiciones_role_id FROM portal.roles WHERE name = 'ADQUISICIONES';

    -- SUPER_USUARIO & GERENCIA
    FOR v_role_id IN SELECT unnest(ARRAY[v_super_role_id, v_gerencia_role_id]) LOOP
        IF v_role_id IS NOT NULL THEN
            INSERT INTO portal.role_permissions (role_id, permission_id)
            SELECT v_role_id, p.id FROM portal.permissions p
            WHERE p.code IN (
                'adquisiciones.route_settlements.view',
                'adquisiciones.route_settlements.create',
                'adquisiciones.route_settlements.update',
                'adquisiciones.route_settlements.close',
                'adquisiciones.route_settlements.print',
                'adquisiciones.route_settlements.cancel'
            )
            AND NOT EXISTS (
                SELECT 1 FROM portal.role_permissions rp 
                WHERE rp.role_id = v_role_id AND rp.permission_id = p.id
            );
        END IF;
    END LOOP;

    -- FINANZAS & ADQUISICIONES
    FOR v_role_id IN SELECT unnest(ARRAY[v_finanzas_role_id, v_adquisiciones_role_id]) LOOP
        IF v_role_id IS NOT NULL THEN
            INSERT INTO portal.role_permissions (role_id, permission_id)
            SELECT v_role_id, p.id FROM portal.permissions p
            WHERE p.code IN (
                'adquisiciones.route_settlements.view',
                'adquisiciones.route_settlements.create',
                'adquisiciones.route_settlements.update',
                'adquisiciones.route_settlements.close',
                'adquisiciones.route_settlements.print'
            )
            AND NOT EXISTS (
                SELECT 1 FROM portal.role_permissions rp 
                WHERE rp.role_id = v_role_id AND rp.permission_id = p.id
            );
        END IF;
    END LOOP;
END $$;

-- 2. Schema and Tables

CREATE SCHEMA IF NOT EXISTS adquisiciones;
GRANT ALL ON SCHEMA adquisiciones TO authenticated, service_role;

-- 2.1 Route Settlement Counters
CREATE TABLE IF NOT EXISTS adquisiciones.route_settlement_counters (
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_year integer NOT NULL,
    last_sequence integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, settlement_year)
);

-- 2.2 Route Settlements
CREATE TABLE IF NOT EXISTS adquisiciones.route_settlements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    route_guide_id uuid NOT NULL UNIQUE REFERENCES logistica.route_guides(id),
    
    settlement_number text NOT NULL,
    settlement_year integer NOT NULL,
    settlement_sequence integer NOT NULL,
    settlement_date date NOT NULL,
    
    status varchar(30) NOT NULL CHECK (status IN ('IN_REVIEW', 'SETTLED', 'SETTLED_WITH_DIFFERENCE', 'CLOSED', 'CANCELLED')),
    
    received_by uuid NOT NULL REFERENCES portal.users(id),
    reviewed_by uuid REFERENCES portal.users(id),
    closed_by uuid REFERENCES portal.users(id),
    notes text,
    
    -- Totales esperados
    total_route_amount numeric(14,2) NOT NULL DEFAULT 0,
    total_cash_expected numeric(14,2) NOT NULL DEFAULT 0,
    total_check_expected numeric(14,2) NOT NULL DEFAULT 0,
    total_transfer_expected numeric(14,2) NOT NULL DEFAULT 0,
    total_credit_amount numeric(14,2) NOT NULL DEFAULT 0,
    
    -- Totales recibidos/confirmados
    total_cash_received numeric(14,2) NOT NULL DEFAULT 0,
    total_check_received numeric(14,2) NOT NULL DEFAULT 0,
    total_transfer_confirmed numeric(14,2) NOT NULL DEFAULT 0,
    
    -- Totales pendientes y diferencias
    total_cash_difference numeric(14,2) NOT NULL DEFAULT 0,
    total_check_difference numeric(14,2) NOT NULL DEFAULT 0,
    total_transfer_pending numeric(14,2) NOT NULL DEFAULT 0,
    
    total_pending numeric(14,2) NOT NULL DEFAULT 0,
    total_difference numeric(14,2) NOT NULL DEFAULT 0,
    
    -- Contadores de control
    total_invoices integer NOT NULL DEFAULT 0,
    paid_count integer NOT NULL DEFAULT 0,
    pending_count integer NOT NULL DEFAULT 0,
    difference_count integer NOT NULL DEFAULT 0,
    transfer_pending_count integer NOT NULL DEFAULT 0,
    check_count integer NOT NULL DEFAULT 0,
    
    created_by uuid REFERENCES portal.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    
    CONSTRAINT uq_route_settlements_number UNIQUE(company_id, settlement_number),
    CONSTRAINT uq_route_settlements_year_seq UNIQUE(company_id, settlement_year, settlement_sequence)
);

CREATE INDEX idx_route_settlements_status ON adquisiciones.route_settlements (company_id, status);
CREATE INDEX idx_route_settlements_date ON adquisiciones.route_settlements (company_id, settlement_date DESC);

-- 2.3 Route Settlement Items
CREATE TABLE IF NOT EXISTS adquisiciones.route_settlement_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
    settlement_id uuid NOT NULL REFERENCES adquisiciones.route_settlements(id) ON DELETE CASCADE,
    route_guide_item_id uuid NOT NULL UNIQUE REFERENCES logistica.route_guide_items(id),
    
    -- Snapshots from guide
    invoice_number text NOT NULL,
    customer_name text NOT NULL,
    expected_payment_method text NOT NULL,
    expected_amount numeric(14,2) NOT NULL,
    
    -- Actual received
    received_payment_method text,
    received_amount numeric(14,2) NOT NULL DEFAULT 0,
    difference_amount numeric(14,2) NOT NULL DEFAULT 0,
    
    status varchar(30) NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'PAID_CASH', 'TRANSFER_CONFIRMED', 'TRANSFER_PENDING', 'CHECK_RECEIVED', 'CREDIT_REGISTERED', 'PARTIAL_PAYMENT', 'DIFFERENCE', 'NOT_DELIVERED', 'REVIEW_REQUIRED')),
    notes text,
    
    -- Transfer details
    transfer_confirmed boolean NOT NULL DEFAULT false,
    transfer_confirmed_at timestamptz,
    transfer_reference text,
    
    -- Check details
    check_received boolean NOT NULL DEFAULT false,
    check_bank text,
    check_number text,
    check_date date,
    check_amount numeric(14,2),
    
    -- Control
    is_pending boolean NOT NULL DEFAULT false,
    requires_followup boolean NOT NULL DEFAULT false,
    
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_route_settlement_items_settlement ON adquisiciones.route_settlement_items (company_id, settlement_id);
CREATE INDEX idx_route_settlement_items_status ON adquisiciones.route_settlement_items (company_id, status);

-- 3. Triggers
CREATE TRIGGER update_route_settlement_counters_updated_at BEFORE UPDATE ON adquisiciones.route_settlement_counters FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_settlements_updated_at BEFORE UPDATE ON adquisiciones.route_settlements FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER update_route_settlement_items_updated_at BEFORE UPDATE ON adquisiciones.route_settlement_items FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();

-- 4. RLS
ALTER TABLE adquisiciones.route_settlement_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE adquisiciones.route_settlement_items ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA adquisiciones TO authenticated, service_role;

CREATE POLICY "Users can view route_settlement_counters if company access" ON adquisiciones.route_settlement_counters FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_settlements if company access" ON adquisiciones.route_settlements FOR SELECT USING (core.has_company_access(auth.uid(), company_id));
CREATE POLICY "Users can view route_settlement_items if company access" ON adquisiciones.route_settlement_items FOR SELECT USING (core.has_company_access(auth.uid(), company_id));

-- Note: mutation access is strictly via RPC

-- 5. RPCs

-- 5.1 Create Route Settlement from Guide
CREATE OR REPLACE FUNCTION adquisiciones.create_route_settlement_from_guide(
    p_route_guide_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_year integer;
    v_seq integer;
    v_number text;
    v_settlement_id uuid;
BEGIN
    -- 1. Get guide info
    SELECT company_id, status INTO v_company_id, v_status
    FROM logistica.route_guides
    WHERE id = p_route_guide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guía de ruta no encontrada';
    END IF;

    -- 2. Validations
    IF auth.uid() != p_user_id THEN
        RAISE EXCEPTION 'Usuario no coincide con la sesión';
    END IF;
    
    IF NOT core.has_company_access(p_user_id, v_company_id) THEN
        RAISE EXCEPTION 'No tiene acceso a la empresa de esta guía';
    END IF;
    
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.create') THEN
        RAISE EXCEPTION 'No tiene permiso para crear rendiciones';
    END IF;

    IF v_status != 'DISPATCHED' THEN
        RAISE EXCEPTION 'Solo se pueden rendir guías despachadas';
    END IF;

    IF EXISTS (SELECT 1 FROM adquisiciones.route_settlements WHERE route_guide_id = p_route_guide_id AND status != 'CANCELLED') THEN
        RAISE EXCEPTION 'Ya existe una rendición activa para esta guía';
    END IF;

    -- 3. Sequence and Number
    v_year := extract(year from current_date);
    
    INSERT INTO adquisiciones.route_settlement_counters (company_id, settlement_year, last_sequence)
    VALUES (v_company_id, v_year, 1)
    ON CONFLICT (company_id, settlement_year) 
    DO UPDATE SET last_sequence = adquisiciones.route_settlement_counters.last_sequence + 1
    RETURNING last_sequence INTO v_seq;

    v_number := 'RR-' || v_year::text || '-' || lpad(v_seq::text, 6, '0');

    -- 4. Insert Header
    INSERT INTO adquisiciones.route_settlements (
        company_id, route_guide_id, settlement_number, settlement_year, settlement_sequence,
        settlement_date, status, received_by, created_by
    ) VALUES (
        v_company_id, p_route_guide_id, v_number, v_year, v_seq,
        current_date, 'IN_REVIEW', p_user_id, p_user_id
    ) RETURNING id INTO v_settlement_id;

    -- 5. Insert Items (Initialization logic based on requested conditions)
    INSERT INTO adquisiciones.route_settlement_items (
        company_id, settlement_id, route_guide_item_id,
        invoice_number, customer_name, expected_payment_method, expected_amount,
        status, received_amount, difference_amount, is_pending
    )
    SELECT 
        v_company_id, v_settlement_id, i.id,
        i.invoice_number, i.customer_name, i.payment_method_normalized, i.amount,
        CASE 
            WHEN i.payment_method_normalized = 'CASH' THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'CHECK' THEN 'PENDING_PAYMENT'
            WHEN i.payment_method_normalized = 'TRANSFER' THEN 'TRANSFER_PENDING'
            WHEN i.payment_method_normalized = 'CREDIT' THEN 'CREDIT_REGISTERED'
            ELSE 'REVIEW_REQUIRED'
        END,
        0, -- received_amount
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN i.amount ELSE 0 END, -- difference_amount
        CASE WHEN i.payment_method_normalized IN ('CASH', 'CHECK') THEN true ELSE false END -- is_pending
    FROM logistica.route_guide_items i
    WHERE i.route_guide_id = p_route_guide_id
      AND i.invoice_number != ''; -- ignore empty rows

    -- 6. Recalculate totals (We use the update logic here or do it directly)
    -- We can call the recalculation function directly or inline it. Let's do it in a shared way or just inline here since it's initial.
    UPDATE adquisiciones.route_settlements s
    SET 
        total_invoices = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_route_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id),
        total_cash_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_expected = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        total_credit_amount = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CREDIT'),
        
        total_cash_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method = 'TRANSFER'),
        
        total_difference = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = v_settlement_id AND expected_payment_method IN ('CASH', 'CHECK'))
    WHERE s.id = v_settlement_id;

    -- 7. Audit
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (v_company_id, p_user_id, 'ROUTE_SETTLEMENT_CREATED', 'ROUTE_SETTLEMENT', v_settlement_id, jsonb_build_object('settlement_number', v_number, 'route_guide_id', p_route_guide_id));

    RETURN jsonb_build_object('success', true, 'id', v_settlement_id, 'settlement_number', v_number);
END;
$$;


-- 5.2 Update Route Settlement
CREATE OR REPLACE FUNCTION adquisiciones.update_route_settlement(
    p_settlement_id uuid,
    p_items jsonb,
    p_notes text,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_item jsonb;
    v_item_id uuid;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.update') THEN RAISE EXCEPTION 'No tiene permisos'; END IF;
    IF v_status != 'IN_REVIEW' THEN RAISE EXCEPTION 'Rendición no está en edición (IN_REVIEW)'; END IF;

    -- Update Items
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_item_id := (v_item->>'id')::uuid;
        
        UPDATE adquisiciones.route_settlement_items
        SET
            received_amount = (v_item->>'received_amount')::numeric,
            difference_amount = expected_amount - (v_item->>'received_amount')::numeric,
            status = v_item->>'status',
            notes = v_item->>'notes',
            
            transfer_confirmed = COALESCE((v_item->>'transfer_confirmed')::boolean, transfer_confirmed),
            transfer_reference = v_item->>'transfer_reference',
            
            check_received = COALESCE((v_item->>'check_received')::boolean, check_received),
            check_bank = v_item->>'check_bank',
            check_number = v_item->>'check_number',
            check_date = (v_item->>'check_date')::date,
            check_amount = (v_item->>'check_amount')::numeric,
            
            is_pending = COALESCE((v_item->>'is_pending')::boolean, is_pending),
            requires_followup = COALESCE((v_item->>'requires_followup')::boolean, requires_followup)
        WHERE id = v_item_id AND settlement_id = p_settlement_id;
    END LOOP;

    -- Recalculate totals
    UPDATE adquisiciones.route_settlements s
    SET 
        notes = p_notes,
        total_cash_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_received = (SELECT coalesce(sum(received_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_confirmed = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = true),
        
        total_cash_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CASH'),
        total_check_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'CHECK'),
        total_transfer_pending = (SELECT coalesce(sum(expected_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        
        total_difference = (SELECT coalesce(sum(difference_amount), 0) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method IN ('CASH', 'CHECK')),
        
        paid_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND status IN ('PAID_CASH', 'CHECK_RECEIVED')),
        pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND is_pending = true),
        difference_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND difference_amount > 0 AND expected_payment_method IN ('CASH', 'CHECK')),
        transfer_pending_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND expected_payment_method = 'TRANSFER' AND transfer_confirmed = false),
        check_count = (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND check_received = true)
    WHERE s.id = p_settlement_id;

    -- Audit
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (v_company_id, p_user_id, 'ROUTE_SETTLEMENT_UPDATED', 'ROUTE_SETTLEMENT', p_settlement_id, '{}');

    RETURN jsonb_build_object('success', true);
END;
$$;


-- 5.3 Close Route Settlement
CREATE OR REPLACE FUNCTION adquisiciones.close_route_settlement(
    p_settlement_id uuid,
    p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_company_id uuid;
    v_status varchar;
    v_total_difference numeric;
    v_transfer_pending_count integer;
    v_pending_count integer;
    v_review_required integer;
    v_new_status varchar;
BEGIN
    SELECT company_id, status INTO v_company_id, v_status
    FROM adquisiciones.route_settlements
    WHERE id = p_settlement_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'Rendición no encontrada'; END IF;
    IF auth.uid() != p_user_id THEN RAISE EXCEPTION 'Usuario no coincide'; END IF;
    IF NOT portal.user_has_permission(p_user_id, 'adquisiciones.route_settlements.close') THEN RAISE EXCEPTION 'No tiene permisos para cerrar rendición'; END IF;
    IF v_status != 'IN_REVIEW' THEN RAISE EXCEPTION 'Solo se puede cerrar rendición en edición'; END IF;

    -- Ensure latest recalculation
    SELECT 
        total_difference, 
        transfer_pending_count, 
        pending_count,
        (SELECT count(*) FROM adquisiciones.route_settlement_items WHERE settlement_id = p_settlement_id AND status = 'REVIEW_REQUIRED')
    INTO 
        v_total_difference, 
        v_transfer_pending_count, 
        v_pending_count,
        v_review_required
    FROM adquisiciones.route_settlements WHERE id = p_settlement_id;

    IF v_review_required > 0 THEN
        RAISE EXCEPTION 'Hay formas de pago desconocidas (UNKNOWN) que requieren revisión antes de cerrar.';
    END IF;

    IF v_total_difference > 0 OR v_transfer_pending_count > 0 OR v_pending_count > 0 THEN
        v_new_status := 'SETTLED_WITH_DIFFERENCE';
    ELSE
        v_new_status := 'SETTLED';
    END IF;

    UPDATE adquisiciones.route_settlements
    SET 
        status = v_new_status,
        closed_by = p_user_id,
        closed_at = now()
    WHERE id = p_settlement_id;

    -- Audit
    INSERT INTO portal.audit_logs (company_id, user_id, action, entity_type, entity_id, details)
    VALUES (v_company_id, p_user_id, 'ROUTE_SETTLEMENT_CLOSED', 'ROUTE_SETTLEMENT', p_settlement_id, jsonb_build_object('new_status', v_new_status));

    RETURN jsonb_build_object('success', true, 'status', v_new_status);
END;
$$;
