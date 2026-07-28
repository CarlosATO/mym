-- Inventory Engine phase 01: session root, declarative scope, participants,
-- and operational snapshots. Later phases add zones, tasks, counts, and RLS policies.

CREATE SCHEMA IF NOT EXISTS inventarios;

GRANT USAGE ON SCHEMA inventarios TO authenticated, service_role;

COMMENT ON SCHEMA inventarios IS
    'Inventory Engine domain. Owns inventory process data and references ERP masters without modifying them.';

-- ============================================================================
-- Session root
-- ============================================================================

CREATE TABLE inventarios.sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_number integer NOT NULL,
    name text NOT NULL,
    inventory_type text NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT',
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    bsale_office_id integer NOT NULL,
    scope_mode text NOT NULL,
    responsible_user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    original_session_id uuid,
    notes text,
    prepared_at timestamptz,
    started_at timestamptz,
    reviewed_at timestamptz,
    approved_at timestamptz,
    approved_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    exported_at timestamptz,
    reconciled_at timestamptz,
    cancelled_at timestamptz,
    cancelled_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    cancellation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_sessions_company_number UNIQUE (company_id, session_number),
    CONSTRAINT uq_inventarios_sessions_company_id UNIQUE (company_id, id),
    CONSTRAINT fk_inventarios_sessions_original_company
        FOREIGN KEY (company_id, original_session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_sessions_number_positive
        CHECK (session_number > 0),
    CONSTRAINT chk_inventarios_sessions_type
        CHECK (inventory_type IN ('GENERAL', 'PARTIAL', 'CYCLIC', 'CONTROL', 'RECOUNT')),
    CONSTRAINT chk_inventarios_sessions_status
        CHECK (status IN ('DRAFT', 'PREPARED', 'COUNTING', 'UNDER_REVIEW', 'APPROVED', 'EXPORTED', 'RECONCILED', 'CANCELLED')),
    CONSTRAINT chk_inventarios_sessions_scope_mode
        CHECK (scope_mode IN ('GENERAL', 'PARTIAL')),
    CONSTRAINT chk_inventarios_sessions_v1_type_scope
        CHECK (
            (inventory_type = 'GENERAL' AND scope_mode = 'GENERAL')
            OR (inventory_type = 'PARTIAL' AND scope_mode = 'PARTIAL')
            OR inventory_type IN ('CYCLIC', 'CONTROL', 'RECOUNT')
        ),
    CONSTRAINT chk_inventarios_sessions_not_self_rectification
        CHECK (original_session_id IS NULL OR original_session_id <> id),
    CONSTRAINT chk_inventarios_sessions_cancelled
        CHECK (
            (status <> 'CANCELLED')
            OR (
                cancelled_at IS NOT NULL
                AND cancelled_by IS NOT NULL
                AND cancellation_reason IS NOT NULL
                AND approved_at IS NULL
                AND exported_at IS NULL
                AND reconciled_at IS NULL
            )
        ),
    CONSTRAINT chk_inventarios_sessions_cancelled_fields
        CHECK ((cancelled_at IS NULL AND cancelled_by IS NULL) OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
    CONSTRAINT chk_inventarios_sessions_approved
        CHECK ((approved_at IS NULL AND approved_by IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
    CONSTRAINT chk_inventarios_sessions_status_dates
        CHECK (
            status = 'DRAFT'
            OR (status = 'PREPARED' AND prepared_at IS NOT NULL)
            OR (status = 'COUNTING' AND prepared_at IS NOT NULL AND started_at IS NOT NULL)
            OR (status = 'UNDER_REVIEW' AND prepared_at IS NOT NULL AND started_at IS NOT NULL AND reviewed_at IS NOT NULL)
            OR (status = 'APPROVED' AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
            OR (status = 'EXPORTED' AND exported_at IS NOT NULL AND approved_at IS NOT NULL)
            OR (status = 'RECONCILED' AND reconciled_at IS NOT NULL AND exported_at IS NOT NULL)
            OR status = 'CANCELLED'
        ),
    CONSTRAINT chk_inventarios_sessions_lifecycle_dates
        CHECK (
            (prepared_at IS NULL OR prepared_at >= created_at)
            AND (started_at IS NULL OR (prepared_at IS NOT NULL AND started_at >= prepared_at))
            AND (reviewed_at IS NULL OR (started_at IS NOT NULL AND reviewed_at >= started_at))
            AND (approved_at IS NULL OR (reviewed_at IS NOT NULL AND approved_at >= reviewed_at))
            AND (exported_at IS NULL OR (approved_at IS NOT NULL AND exported_at >= approved_at))
            AND (reconciled_at IS NULL OR (exported_at IS NOT NULL AND reconciled_at >= exported_at))
        )
);

COMMENT ON TABLE inventarios.sessions IS
    'Inventory session aggregate root. State transitions, immutable approval, and scoped RLS policies are enforced by future RPCs and triggers.';
COMMENT ON COLUMN inventarios.sessions.original_session_id IS
    'Original session referenced by a rectification. The original session is never modified.';
COMMENT ON COLUMN inventarios.sessions.bsale_office_id IS
    'Bsale office identifier used as the official stock scope for this session.';

CREATE INDEX idx_inventarios_sessions_company_status_created
    ON inventarios.sessions(company_id, status, created_at DESC);
CREATE INDEX idx_inventarios_sessions_company_warehouse_status
    ON inventarios.sessions(company_id, warehouse_id, status);
CREATE INDEX idx_inventarios_sessions_company_original
    ON inventarios.sessions(company_id, original_session_id)
    WHERE original_session_id IS NOT NULL;

-- ============================================================================
-- Declarative session scope. This is not an operational zone or task.
-- ============================================================================

CREATE TABLE inventarios.session_product_scopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    bsale_variant_id integer NOT NULL,
    inclusion_type text NOT NULL DEFAULT 'INCLUDED',
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_product_scopes_session_company
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_product_scopes_variant
        UNIQUE (company_id, session_id, bsale_variant_id),
    CONSTRAINT chk_inventarios_product_scopes_inclusion
        CHECK (inclusion_type IN ('INCLUDED', 'EXCLUDED')),
    CONSTRAINT chk_inventarios_product_scopes_exclusion_reason
        CHECK (inclusion_type <> 'EXCLUDED' OR reason IS NOT NULL)
);

COMMENT ON TABLE inventarios.session_product_scopes IS
    'Explicit product scope for partial sessions. GENERAL scope is represented by session rules and may have no rows.';

CREATE INDEX idx_inventarios_product_scopes_session_type
    ON inventarios.session_product_scopes(company_id, session_id, inclusion_type);

CREATE TABLE inventarios.session_location_scopes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    location_id uuid NOT NULL REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    inclusion_type text NOT NULL DEFAULT 'INCLUDED',
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_location_scopes_session_company
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_location_scopes_location
        UNIQUE (company_id, session_id, location_id),
    CONSTRAINT chk_inventarios_location_scopes_inclusion
        CHECK (inclusion_type IN ('INCLUDED', 'EXCLUDED')),
    CONSTRAINT chk_inventarios_location_scopes_exclusion_reason
        CHECK (inclusion_type <> 'EXCLUDED' OR reason IS NOT NULL)
);

COMMENT ON TABLE inventarios.session_location_scopes IS
    'Declarative location scope only. It does not create zones, tasks, assignments, QR codes, or counting state.';

CREATE INDEX idx_inventarios_location_scopes_session_type
    ON inventarios.session_location_scopes(company_id, session_id, inclusion_type);

-- ============================================================================
-- Authorized participants. Functional role is scoped to a session.
-- ============================================================================

CREATE TABLE inventarios.session_participants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    functional_role text NOT NULL,
    active_from timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_by uuid REFERENCES portal.users(id) ON DELETE RESTRICT,
    revocation_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_participants_session_company
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_participants_company_access
        FOREIGN KEY (user_id, company_id)
        REFERENCES core.user_company_access(user_id, company_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_inventarios_participants_role
        CHECK (functional_role IN ('COUNTER', 'SUPERVISOR', 'ADMINISTRATOR', 'MANAGER')),
    CONSTRAINT chk_inventarios_participants_revocation
        CHECK ((revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

COMMENT ON TABLE inventarios.session_participants IS
    'Authorized users and functional roles for one session. Global portal roles remain an additional authorization requirement.';

CREATE UNIQUE INDEX uq_inventarios_participants_active_role
    ON inventarios.session_participants(company_id, session_id, user_id, functional_role)
    WHERE revoked_at IS NULL;
CREATE INDEX idx_inventarios_participants_company_user
    ON inventarios.session_participants(company_id, user_id, session_id)
    WHERE revoked_at IS NULL;

-- ============================================================================
-- Operational Snapshot. Snapshot content is historical and must not be updated
-- after a future completion trigger/RPC marks it complete.
-- ============================================================================

CREATE TABLE inventarios.operational_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    session_id uuid NOT NULL,
    bsale_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id) ON DELETE RESTRICT,
    snapshot_version smallint NOT NULL DEFAULT 1,
    completion_status text NOT NULL DEFAULT 'PENDING',
    captured_at timestamptz NOT NULL DEFAULT now(),
    captured_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    content_hash char(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshots_session_company
        FOREIGN KEY (company_id, session_id)
        REFERENCES inventarios.sessions(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshots_session
        UNIQUE (company_id, session_id),
    CONSTRAINT uq_inventarios_snapshots_company_id
        UNIQUE (company_id, id),
    CONSTRAINT chk_inventarios_snapshots_version
        CHECK (snapshot_version > 0),
    CONSTRAINT chk_inventarios_snapshots_status
        CHECK (completion_status IN ('PENDING', 'COMPLETED', 'FAILED')),
    CONSTRAINT chk_inventarios_snapshots_completed_hash
        CHECK (completion_status <> 'COMPLETED' OR content_hash IS NOT NULL)
);

COMMENT ON TABLE inventarios.operational_snapshots IS
    'Immutable operational reference captured at session start. Complex immutability protection is added in a later phase.';
COMMENT ON COLUMN inventarios.operational_snapshots.bsale_sync_run_id IS
    'Bsale synchronization run used as snapshot provenance; same-company validation is enforced by a future RPC.';

CREATE INDEX idx_inventarios_snapshots_company_sync_run
    ON inventarios.operational_snapshots(company_id, bsale_sync_run_id)
    WHERE bsale_sync_run_id IS NOT NULL;

CREATE TABLE inventarios.snapshot_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
    bsale_variant_id integer NOT NULL,
    sku text NOT NULL,
    barcode text,
    name text NOT NULL,
    product_metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_products_snapshot_company
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshot_products_company_snapshot_id
        UNIQUE (company_id, snapshot_id, id),
    CONSTRAINT uq_inventarios_snapshot_products_variant
        UNIQUE (company_id, snapshot_id, bsale_variant_id)
);

COMMENT ON TABLE inventarios.snapshot_products IS
    'Historical product identity and labels at capture time. product_id is a live optional reference, not a duplicated master.';
COMMENT ON COLUMN inventarios.snapshot_products.product_metadata IS
    'Only variable source payload context not represented by stable snapshot columns.';

CREATE INDEX idx_inventarios_snapshot_products_sku
    ON inventarios.snapshot_products(company_id, snapshot_id, sku);

CREATE TABLE inventarios.snapshot_stocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    office_id integer NOT NULL,
    theoretical_quantity numeric(14,3) NOT NULL,
    source_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id) ON DELETE RESTRICT,
    source_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_stocks_snapshot_company
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_stocks_product_company
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshot_stocks_product_office
        UNIQUE (company_id, snapshot_id, snapshot_product_id, office_id),
    CONSTRAINT chk_inventarios_snapshot_stocks_quantity
        CHECK (theoretical_quantity >= 0)
);

COMMENT ON TABLE inventarios.snapshot_stocks IS
    'Frozen Bsale theoretical stock by snapshot product and office. Variant identity is inherited from snapshot_products.';

CREATE INDEX idx_inventarios_snapshot_stocks_source_sync_run
    ON inventarios.snapshot_stocks(company_id, source_sync_run_id)
    WHERE source_sync_run_id IS NOT NULL;

CREATE TABLE inventarios.snapshot_costs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    snapshot_product_id uuid NOT NULL,
    sku text NOT NULL,
    unit_cost numeric(14,2),
    source_type text NOT NULL,
    fallback_priority smallint NOT NULL,
    cost_unavailable boolean NOT NULL DEFAULT false,
    bsale_reception_detail_id uuid REFERENCES integraciones.bsale_reception_details(id) ON DELETE RESTRICT,
    bsale_reception_id uuid REFERENCES integraciones.bsale_receptions(id) ON DELETE RESTRICT,
    bsale_reception_detail_external_id integer,
    bsale_reception_external_id integer,
    source_reference_id uuid,
    source_received_at date,
    source_document text,
    source_sync_run_id uuid REFERENCES integraciones.bsale_sync_runs(id) ON DELETE RESTRICT,
    provenance_metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_costs_snapshot_company
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_costs_product_company
        FOREIGN KEY (company_id, snapshot_id, snapshot_product_id)
        REFERENCES inventarios.snapshot_products(company_id, snapshot_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshot_costs_product
        UNIQUE (company_id, snapshot_id, snapshot_product_id),
    CONSTRAINT chk_inventarios_snapshot_costs_source
        CHECK (source_type IN ('BSALE_RECEIPT', 'INTERNAL_RECEIPT_OR_KARDEX', 'BSALE_AVERAGE', 'SUPPLIER_MAPPING', 'UNAVAILABLE')),
    CONSTRAINT chk_inventarios_snapshot_costs_priority
        CHECK (
            (source_type = 'BSALE_RECEIPT' AND fallback_priority = 1)
            OR (source_type = 'INTERNAL_RECEIPT_OR_KARDEX' AND fallback_priority = 2)
            OR (source_type = 'BSALE_AVERAGE' AND fallback_priority = 3)
            OR (source_type = 'SUPPLIER_MAPPING' AND fallback_priority = 4)
            OR (source_type = 'UNAVAILABLE' AND fallback_priority = 5)
        ),
    CONSTRAINT chk_inventarios_snapshot_costs_value
        CHECK (
            (cost_unavailable = true AND unit_cost IS NULL AND source_type = 'UNAVAILABLE' AND fallback_priority = 5)
            OR
            (cost_unavailable = false AND unit_cost IS NOT NULL AND unit_cost >= 0 AND source_type <> 'UNAVAILABLE')
        ),
    CONSTRAINT chk_inventarios_snapshot_costs_bsale_receipt_origin
        CHECK (
            source_type <> 'BSALE_RECEIPT'
            OR (
                bsale_reception_detail_id IS NOT NULL
                AND bsale_reception_id IS NOT NULL
                AND bsale_reception_detail_external_id IS NOT NULL
                AND bsale_reception_external_id IS NOT NULL
            )
        ),
    CONSTRAINT chk_inventarios_snapshot_costs_fallback_origin
        CHECK (
            source_type NOT IN ('INTERNAL_RECEIPT_OR_KARDEX', 'SUPPLIER_MAPPING')
            OR source_reference_id IS NOT NULL
        ),
    CONSTRAINT chk_inventarios_snapshot_costs_average_origin
        CHECK (source_type <> 'BSALE_AVERAGE' OR source_sync_run_id IS NOT NULL)
);

COMMENT ON TABLE inventarios.snapshot_costs IS
    'Frozen unit cost historically reported by Bsale or an explicitly identified fallback; never a net accounting cost by name.';
COMMENT ON COLUMN inventarios.snapshot_costs.unit_cost IS
    'May be NULL only when no approved source exists. Unknown cost is never silently represented as zero.';
COMMENT ON COLUMN inventarios.snapshot_costs.provenance_metadata IS
    'Variable technical provenance only; stable receipt, document, variant, SKU, sync, and source fields remain columns.';

CREATE INDEX idx_inventarios_snapshot_costs_sku
    ON inventarios.snapshot_costs(company_id, snapshot_id, sku);
CREATE INDEX idx_inventarios_snapshot_costs_bsale_detail
    ON inventarios.snapshot_costs(company_id, bsale_reception_detail_id)
    WHERE bsale_reception_detail_id IS NOT NULL;
CREATE INDEX idx_inventarios_snapshot_costs_bsale_reception
    ON inventarios.snapshot_costs(company_id, bsale_reception_id)
    WHERE bsale_reception_id IS NOT NULL;
CREATE INDEX idx_inventarios_snapshot_costs_source_sync_run
    ON inventarios.snapshot_costs(company_id, source_sync_run_id)
    WHERE source_sync_run_id IS NOT NULL;

CREATE TABLE inventarios.snapshot_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    location_id uuid NOT NULL REFERENCES logistica.locations(id) ON DELETE RESTRICT,
    warehouse_id uuid NOT NULL REFERENCES adquisiciones.warehouses(id) ON DELETE RESTRICT,
    code text NOT NULL,
    name text,
    aisle text,
    rack text,
    level text,
    position text,
    is_active boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_locations_snapshot_company
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshot_locations_location
        UNIQUE (company_id, snapshot_id, location_id)
);

COMMENT ON TABLE inventarios.snapshot_locations IS
    'Frozen physical context of live logistica.locations references. Later location changes do not alter this history.';

CREATE INDEX idx_inventarios_snapshot_locations_warehouse
    ON inventarios.snapshot_locations(company_id, snapshot_id, warehouse_id);

CREATE TABLE inventarios.snapshot_configurations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL,
    scope_rule jsonb NOT NULL,
    rules jsonb NOT NULL,
    provider_configuration jsonb NOT NULL,
    participant_context jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_inventarios_snapshot_configurations_snapshot_company
        FOREIGN KEY (company_id, snapshot_id)
        REFERENCES inventarios.operational_snapshots(company_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT uq_inventarios_snapshot_configurations_snapshot
        UNIQUE (company_id, snapshot_id),
    CONSTRAINT chk_inventarios_snapshot_configurations_objects
        CHECK (
            jsonb_typeof(scope_rule) = 'object'
            AND jsonb_typeof(rules) = 'object'
            AND jsonb_typeof(provider_configuration) = 'object'
            AND (participant_context IS NULL OR jsonb_typeof(participant_context) = 'object')
        )
);

COMMENT ON TABLE inventarios.snapshot_configurations IS
    'Frozen variable rules and provider context. Structured data is stored in dedicated snapshot tables.';

-- ============================================================================
-- Security baseline. RLS is enabled immediately. Policies and write RPCs are
-- intentionally introduced with the operational phases to avoid partial access.
-- ============================================================================

ALTER TABLE inventarios.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.session_product_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.session_location_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.operational_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.snapshot_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.snapshot_stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.snapshot_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.snapshot_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventarios.snapshot_configurations ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA inventarios TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA inventarios TO authenticated;
