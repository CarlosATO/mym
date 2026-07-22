CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS comercial.commission_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  default_commission_percent numeric(7,4) NOT NULL DEFAULT 1.0000,
  base_amount text NOT NULL DEFAULT 'NET',
  require_full_payment boolean NOT NULL DEFAULT true,
  historical_cutoff_date date NOT NULL,
  first_eligible_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT uq_commission_settings_company UNIQUE (company_id),
  CONSTRAINT chk_commission_settings_base_amount CHECK (base_amount = 'NET'),
  CONSTRAINT chk_commission_settings_require_full_payment CHECK (require_full_payment),
  CONSTRAINT chk_commission_settings_dates CHECK (first_eligible_date = historical_cutoff_date + 1)
);

CREATE TABLE IF NOT EXISTS comercial.commission_seller_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  seller_bsale_id bigint NOT NULL,
  seller_name text NOT NULL,
  is_commissionable boolean NOT NULL DEFAULT false,
  seller_type text NOT NULL DEFAULT 'OTHER',
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT uq_commission_seller_profiles_company_seller UNIQUE (company_id, seller_bsale_id),
  CONSTRAINT chk_commission_seller_profiles_type CHECK (seller_type IN ('FIELD', 'ADMIN', 'MANAGEMENT', 'DISPATCH', 'OTHER'))
);

CREATE TABLE IF NOT EXISTS comercial.commission_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  supplier_id uuid REFERENCES adquisiciones.suppliers(id) ON DELETE SET NULL,
  parent_supplier_id uuid REFERENCES adquisiciones.suppliers(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT uq_commission_groups_company_code UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS comercial.commission_group_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  commission_group_id uuid NOT NULL REFERENCES comercial.commission_groups(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
  valid_from date NOT NULL,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT chk_commission_group_products_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT ex_commission_group_products_active_period EXCLUDE USING gist (
    company_id WITH =,
    product_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (is_active)
);

CREATE TABLE IF NOT EXISTS comercial.commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  rule_scope text NOT NULL,
  seller_profile_id uuid REFERENCES comercial.commission_seller_profiles(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES adquisiciones.suppliers(id) ON DELETE RESTRICT,
  commission_group_id uuid REFERENCES comercial.commission_groups(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES adquisiciones.products(id) ON DELETE RESTRICT,
  rule_type text NOT NULL,
  range_basis text NOT NULL,
  min_amount numeric(18,2),
  max_amount numeric(18,2),
  min_quantity numeric(18,3),
  max_quantity numeric(18,3),
  commission_percent numeric(7,4) NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT chk_commission_rules_scope CHECK (rule_scope IN ('GENERAL', 'SUPPLIER', 'GROUP', 'PRODUCT')),
  CONSTRAINT chk_commission_rules_type CHECK (rule_type IN ('FIXED_PERCENT', 'RANGE_BY_AMOUNT', 'RANGE_BY_QUANTITY')),
  CONSTRAINT chk_commission_rules_range_basis CHECK (range_basis IN ('NONE', 'AMOUNT', 'QUANTITY')),
  CONSTRAINT chk_commission_rules_percent CHECK (commission_percent >= 0 AND commission_percent <= 100),
  CONSTRAINT chk_commission_rules_priority CHECK (priority >= 0),
  CONSTRAINT chk_commission_rules_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT chk_commission_rules_scope_target CHECK (
    (rule_scope = 'GENERAL' AND supplier_id IS NULL AND commission_group_id IS NULL AND product_id IS NULL)
    OR (rule_scope = 'SUPPLIER' AND supplier_id IS NOT NULL AND commission_group_id IS NULL AND product_id IS NULL)
    OR (rule_scope = 'GROUP' AND supplier_id IS NULL AND commission_group_id IS NOT NULL AND product_id IS NULL)
    OR (rule_scope = 'PRODUCT' AND supplier_id IS NULL AND commission_group_id IS NULL AND product_id IS NOT NULL)
  ),
  CONSTRAINT chk_commission_rules_range CHECK (
    (rule_type = 'FIXED_PERCENT' AND range_basis = 'NONE' AND min_amount IS NULL AND max_amount IS NULL AND min_quantity IS NULL AND max_quantity IS NULL)
    OR (rule_type = 'RANGE_BY_AMOUNT' AND range_basis = 'AMOUNT' AND min_amount IS NOT NULL AND (max_amount IS NULL OR max_amount >= min_amount) AND min_quantity IS NULL AND max_quantity IS NULL)
    OR (rule_type = 'RANGE_BY_QUANTITY' AND range_basis = 'QUANTITY' AND min_quantity IS NOT NULL AND (max_quantity IS NULL OR max_quantity >= min_quantity) AND min_amount IS NULL AND max_amount IS NULL)
  )
);

COMMENT ON TABLE comercial.commission_rules IS 'Las reglas solapadas se validaran en la funcion transaccional de guardado de reglas de la fase UI.';

CREATE TABLE IF NOT EXISTS comercial.commission_settlement_sequences (
  company_id uuid PRIMARY KEY REFERENCES core.companies(id) ON DELETE CASCADE,
  last_settlement_number bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_commission_settlement_sequences_last_number CHECK (last_settlement_number >= 0)
);

CREATE TABLE IF NOT EXISTS comercial.commission_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  settlement_number bigint,
  settlement_code text NOT NULL,
  seller_profile_id uuid REFERENCES comercial.commission_seller_profiles(id) ON DELETE RESTRICT,
  seller_bsale_id bigint,
  seller_name text,
  period_from date NOT NULL,
  period_to date NOT NULL,
  period_label text NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  issued_at timestamptz,
  issued_by uuid,
  total_net_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_commission_amount numeric(18,2) NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT chk_commission_settlements_status CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED')),
  CONSTRAINT chk_commission_settlements_source CHECK (source IN ('NORMAL', 'HISTORICAL', 'ADJUSTMENT')),
  CONSTRAINT chk_commission_settlements_dates CHECK (period_to >= period_from),
  CONSTRAINT chk_commission_settlements_historical CHECK (
    (source = 'HISTORICAL' AND settlement_code = 'HISTORICO' AND status = 'ISSUED' AND seller_profile_id IS NULL AND seller_bsale_id IS NULL AND seller_name IS NULL AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
    OR (source IN ('NORMAL', 'ADJUSTMENT') AND seller_bsale_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_settlements_company_code ON comercial.commission_settlements(company_id, settlement_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_settlements_company_number ON comercial.commission_settlements(company_id, settlement_number) WHERE settlement_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_settlements_historical_company ON comercial.commission_settlements(company_id) WHERE source = 'HISTORICAL';
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_settlements_normal_draft_seller ON comercial.commission_settlements(company_id, seller_bsale_id) WHERE status = 'DRAFT' AND source = 'NORMAL';

CREATE TABLE IF NOT EXISTS comercial.commission_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES core.companies(id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL REFERENCES comercial.commission_settlements(id) ON DELETE RESTRICT,
  line_type text NOT NULL,
  seller_profile_id uuid,
  seller_bsale_id bigint,
  seller_name text,
  invoice_bsale_id bigint,
  invoice_number bigint,
  invoice_document_id uuid,
  invoice_line_id uuid,
  client_bsale_id bigint,
  customer_id uuid REFERENCES comercial.customers(id) ON DELETE SET NULL,
  customer_name text,
  product_id uuid REFERENCES adquisiciones.products(id) ON DELETE SET NULL,
  sku text,
  product_name text,
  supplier_id uuid REFERENCES adquisiciones.suppliers(id) ON DELETE SET NULL,
  commission_group_id uuid REFERENCES comercial.commission_groups(id) ON DELETE SET NULL,
  quantity numeric(18,3) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL DEFAULT 0,
  commission_base_amount numeric(18,2) NOT NULL DEFAULT 0,
  commission_percent numeric(7,4),
  commission_amount numeric(18,2),
  rule_id uuid REFERENCES comercial.commission_rules(id) ON DELETE SET NULL,
  payment_completed_at timestamptz,
  source_document_bsale_id bigint,
  source_document_number bigint,
  source_document_type_id integer,
  source_document_line_id uuid,
  original_invoice_bsale_id bigint,
  original_invoice_number bigint,
  eligibility_locked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT chk_commission_settlement_lines_type CHECK (line_type IN ('INVOICE', 'CREDIT_NOTE', 'HISTORICAL_MARK')),
  CONSTRAINT chk_commission_settlement_lines_shape CHECK (
    (line_type = 'INVOICE' AND invoice_bsale_id IS NOT NULL AND invoice_line_id IS NOT NULL AND quantity >= 0 AND net_amount >= 0 AND commission_base_amount >= 0 AND (commission_amount IS NULL OR commission_amount >= 0))
    OR (line_type = 'CREDIT_NOTE' AND source_document_bsale_id IS NOT NULL AND original_invoice_bsale_id IS NOT NULL AND net_amount <= 0 AND commission_base_amount <= 0 AND (commission_amount IS NULL OR commission_amount <= 0))
    OR (line_type = 'HISTORICAL_MARK' AND invoice_bsale_id IS NOT NULL AND invoice_line_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_locked_invoice_line
  ON comercial.commission_settlement_lines(company_id, invoice_line_id)
  WHERE line_type IN ('INVOICE', 'HISTORICAL_MARK') AND eligibility_locked_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_locked_credit_note_line
  ON comercial.commission_settlement_lines(company_id, source_document_line_id)
  WHERE line_type = 'CREDIT_NOTE' AND source_document_line_id IS NOT NULL AND eligibility_locked_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commission_seller_profiles_company_status ON comercial.commission_seller_profiles(company_id, active, is_commissionable);
CREATE INDEX IF NOT EXISTS idx_commission_groups_company_active ON comercial.commission_groups(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_commission_group_products_company_product ON comercial.commission_group_products(company_id, product_id);
CREATE INDEX IF NOT EXISTS idx_commission_group_products_company_group ON comercial.commission_group_products(company_id, commission_group_id);
CREATE INDEX IF NOT EXISTS idx_commission_rules_company_active_dates ON comercial.commission_rules(company_id, is_active, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_commission_rules_scope_seller ON comercial.commission_rules(company_id, rule_scope, seller_profile_id);
CREATE INDEX IF NOT EXISTS idx_commission_settlements_company_seller_status_period ON comercial.commission_settlements(company_id, seller_bsale_id, status, period_to DESC);
CREATE INDEX IF NOT EXISTS idx_commission_lines_settlement ON comercial.commission_settlement_lines(settlement_id);
CREATE INDEX IF NOT EXISTS idx_commission_lines_company_seller ON comercial.commission_settlement_lines(company_id, seller_bsale_id);
CREATE INDEX IF NOT EXISTS idx_commission_lines_company_invoice ON comercial.commission_settlement_lines(company_id, invoice_bsale_id);
CREATE INDEX IF NOT EXISTS idx_commission_lines_company_original_invoice ON comercial.commission_settlement_lines(company_id, original_invoice_bsale_id);
CREATE INDEX IF NOT EXISTS idx_commission_lines_company_type ON comercial.commission_settlement_lines(company_id, line_type);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commission_settings',
    'commission_seller_profiles',
    'commission_groups',
    'commission_group_products',
    'commission_rules',
    'commission_settlement_sequences',
    'commission_settlements',
    'commission_settlement_lines'
  ]
  LOOP
    EXECUTE format('ALTER TABLE comercial.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE comercial.%I FROM anon', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE comercial.%I TO authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE comercial.%I TO service_role', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "commission company select" ON comercial.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "commission company insert" ON comercial.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS "commission company update" ON comercial.%I', table_name);
    EXECUTE format('CREATE POLICY "commission company select" ON comercial.%I FOR SELECT TO authenticated USING (core.has_company_access(auth.uid(), company_id))', table_name);
    EXECUTE format('CREATE POLICY "commission company insert" ON comercial.%I FOR INSERT TO authenticated WITH CHECK (core.has_company_access(auth.uid(), company_id))', table_name);
    EXECUTE format('CREATE POLICY "commission company update" ON comercial.%I FOR UPDATE TO authenticated USING (core.has_company_access(auth.uid(), company_id)) WITH CHECK (core.has_company_access(auth.uid(), company_id))', table_name);
  END LOOP;
END $$;

CREATE TRIGGER set_commission_settings_updated_at BEFORE UPDATE ON comercial.commission_settings FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_seller_profiles_updated_at BEFORE UPDATE ON comercial.commission_seller_profiles FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_groups_updated_at BEFORE UPDATE ON comercial.commission_groups FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_group_products_updated_at BEFORE UPDATE ON comercial.commission_group_products FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_rules_updated_at BEFORE UPDATE ON comercial.commission_rules FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_settlement_sequences_updated_at BEFORE UPDATE ON comercial.commission_settlement_sequences FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_settlements_updated_at BEFORE UPDATE ON comercial.commission_settlements FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
CREATE TRIGGER set_commission_settlement_lines_updated_at BEFORE UPDATE ON comercial.commission_settlement_lines FOR EACH ROW EXECUTE PROCEDURE portal.set_updated_at();
