import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/20261029141403_logistica_operator_preparation_board.sql')
const canonicalMigration = await read('supabase/migrations/20261021100000_logistica_canonical_bsale_identity.sql')
const boardMigration = await read('supabase/migrations/20261026120000_logistica_optimize_sales_order_preparation_board.sql')
const body = migration.split('-- board:start')[1].split('-- board:end')[0].trim().replace(/;$/, '')
const authorization = migration.split('-- authorization:start')[1].split('-- authorization:end')[0]
  .replace(/INTO v_allowed;/, '')

test('invoker RPC guards identity, active profile/company, company role and both permission gates', () => {
  assert.match(migration, /STABLE\s+SECURITY INVOKER\s+SET search_path = pg_catalog/)
  for (const fragment of ["auth.role() = 'authenticated'", 'u.deleted_at IS NULL',
    'co.is_active = true', "uca.role = 'OPERADOR_BODEGA'", 'uca.is_active = true',
    'uca.user_id = v_actor AND uca.company_id = p_company_id',
    'core.has_company_access', 'portal.user_has_permission', 'core.has_permission_for_company']) {
    assert.ok(authorization.includes(fragment), fragment)
  }
  assert.match(migration, /IF v_allowed IS DISTINCT FROM true THEN\s+RAISE EXCEPTION USING ERRCODE = '42501'/)
  assert.match(migration, /REVOKE ALL ON FUNCTION .* FROM PUBLIC/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION .* TO authenticated/)
})

test('only creates the RPC; no table writes, policies, shared views, indexes or timeout changes', () => {
  const sql = migration.replace(/--[^\n]*/g, '')
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|ALTER|DROP)\b/i)
  assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE (?:OR REPLACE )?VIEW|CREATE INDEX|CREATE POLICY|statement_timeout|service_role/i)
  assert.doesNotMatch(body, /sales_order_invoice_attempts|route_guide_items|route_guides|vw_bsale_sales_orders_for_preparation/)
  const initial = body.split('), eligible_cards')[0]
  assert.match(initial, /canonical_documents AS MATERIALIZED/)
  assert.match(initial, /DISTINCT ON \(d\.raw_json ->> 'token'\)/)
  assert.match(initial, /c\.company_id = p_company_id/)
  assert.match(initial, /c\.closed_at IS NULL/)
  assert.match(initial, /'PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED'/)
  assert.match(body, /NOT EXISTS \([\s\S]*bsale_invoice_sales_order_links/)
  assert.doesNotMatch(body, /INVOICED_READY_FOR_ROUTE|READY_TO_INVOICE/)
  assert.doesNotMatch(body, /inv\.(state|raw_json)/)
  assert.match(body, /c\.total_amount, NULL::text, false/)
})

// Optional integration mode: use ONLY the already configured runtime DSN.
// These tests execute SELECTs over synthetic CTEs, never production table data.
// No CREATE, temporary objects, role switching, migrations or fixture inserts.
const enabled = process.env.PERF03A_READ_ONLY_SQL === '1'
const A = 'd1000000-0000-0000-0000-000000000001'
const B = 'd3000000-0000-0000-0000-000000000003'
const actor = '00000000-0000-0000-0000-000000000001'
const uuid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const literal = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
const fixture = (name, rows, columns) => `${name} AS (SELECT * FROM jsonb_to_recordset(${literal(rows)}) AS x(${columns}))`
const relations = {
  'integraciones.vw_bsale_sales_order_documents_canonical': 'canonical',
  'integraciones.vw_bsale_sales_orders_for_preparation': 'nv',
  'integraciones.bsale_documents': 'documents',
  'integraciones.bsale_document_details': 'details',
  'integraciones.bsale_clients': 'clients',
  'integraciones.bsale_sellers': 'sellers',
  'integraciones.bsale_invoice_sales_order_links': 'links',
  'logistica.sales_order_preparation_cards': 'cards',
  'logistica.sales_order_preparation_exclusions': 'exclusions',
  'logistica.sales_order_preparation_incidents': 'incidents',
  'logistica.sales_order_invoice_attempts': 'attempts',
  'logistica.route_guide_items': 'guide_items',
  'logistica.route_guides': 'guides',
}
const substitute = sql => Object.entries(relations).reduce((s, [from, to]) => s.replaceAll(from, to), sql)
const view = (sql, name) => sql.split(`CREATE OR REPLACE VIEW ${name} AS`)[1]
  .split(/\nALTER VIEW|\nGRANT /)[0].trim().replace(/;$/, '')

async function withReadOnlyDatabase(run) {
  assert.ok(process.env.DATABASE_RUNTIME_DSN, 'Existing DATABASE_RUNTIME_DSN required')
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: process.env.DATABASE_RUNTIME_DSN, connectionTimeoutMillis: 8000, query_timeout: 8000 })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    await db.query('SET LOCAL statement_timeout = 3000')
    assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
    await run(db)
  } finally {
    await db.query('ROLLBACK')
    await db.end()
  }
}

test('SQL fixtures: actual query equals the existing views plus operator readiness filter', { skip: !enabled }, async () => {
  const cards = [], documents = [], links = [], exclusions = [], incidents = [], details = []
  const expected = new Map()
  const cases = [
    ['pending', 'PENDING_ROUTE_PREP', true], ['preparing', 'IN_PREPARATION', true],
    ['audit', 'IN_AUDIT', true], ['audited-ready', 'AUDITED', false],
    ['audited-open', 'AUDITED', true, 'INCIDENTS'], ['audited-blocked', 'AUDITED', true, 'BLOCKED'],
    ['audited-closed-incident', 'AUDITED', false], ['invoiced-stage', 'INVOICED_READY_FOR_ROUTE', false],
    ['cancelled', 'CANCELLED', false], ['closed-card', 'IN_PREPARATION', false],
    ['other-company', 'IN_PREPARATION', false], ['null-token', 'IN_PREPARATION', false],
    ['blank-token', 'IN_PREPARATION', false], ['missing-document', 'IN_PREPARATION', false],
    ['bad-state', 'IN_PREPARATION', false], ['valid-8888', 'IN_PREPARATION', true],
    ['stale-pointer', 'IN_PREPARATION', false], ['current-pointer', 'IN_PREPARATION', true],
    ['null-generation-loses', 'IN_PREPARATION', false], ['null-generation-wins', 'IN_PREPARATION', true],
    ['equal-generation-loses', 'IN_PREPARATION', false], ['newer-invalid-state', 'IN_PREPARATION', false],
    ['raw-token-partition', 'IN_PREPARATION', true], ['invoice', 'IN_PREPARATION', false],
    ['cancelled-invoice', 'IN_PREPARATION', false], ['missing-invoice', 'IN_PREPARATION', true],
    ['wrong-invoice-type', 'IN_PREPARATION', true], ['other-company-invoice', 'IN_PREPARATION', true],
    ['exclude-historical', 'IN_PREPARATION', false], ['exclude-current', 'IN_PREPARATION', false],
    ['exclude-token', 'IN_PREPARATION', false], ['inactive-exclusion', 'IN_PREPARATION', true],
    ['other-company-exclusion', 'IN_PREPARATION', true], ['no-details', 'IN_PREPARATION', true],
    ['blocked-with-incident', 'AUDITED', true, 'BLOCKED'], ['closed-audited', 'AUDITED', false],
  ]
  for (const [index, [name, status, visible, readiness = null]] of cases.entries()) {
    const n = index + 1, id = n * 10
    const company = name === 'other-company' ? B : A
    const card = { id: uuid(n), company_id: company, status, priority: n % 3, bsale_nv_id: id,
      current_bsale_nv_id: null, canonical_bsale_token: `token-${n}`, normalized_city: 'SANTIAGO',
      route_date: '2026-10-29', created_at: '2026-10-28T12:00:00Z', updated_at: '2026-10-29T12:00:00Z' }
    const doc = { company_id: company, bsale_id: id, number: n, document_type_id: 23, state: 0,
      client_id: 1, emission_date: '2026-10-29', generation_date: '2026-10-28T12:00:00Z',
      total_amount: 119, net_amount: 100, tax_amount: 19,
      raw_json: { token: `token-${n}`, city: 'Santiago', municipality: 'Centro', address: 'Test', user: { id: 1 } } }
    if (['closed-card', 'closed-audited'].includes(name)) card.closed_at = '2026-10-29T12:00:00Z'
    if (name === 'null-token') doc.raw_json.token = null
    if (name === 'blank-token') doc.raw_json.token = '   '
    if (name === 'bad-state') doc.state = 1
    if (['valid-8888', 'audited-blocked', 'blocked-with-incident'].includes(name)) doc.state = 8888
    if (['stale-pointer', 'current-pointer', 'null-generation-loses', 'equal-generation-loses', 'newer-invalid-state', 'raw-token-partition'].includes(name)) {
      const newer = { ...doc, bsale_id: id + 1, generation_date: '2026-10-29T12:00:00Z', raw_json: { ...doc.raw_json } }
      if (name === 'current-pointer') card.current_bsale_nv_id = id + 1
      if (name === 'null-generation-loses') doc.generation_date = null
      if (name === 'equal-generation-loses') newer.generation_date = doc.generation_date
      if (name === 'newer-invalid-state') newer.state = 1
      if (name === 'raw-token-partition') newer.raw_json.token = ` ${doc.raw_json.token} `
      documents.push(newer)
    }
    if (name === 'null-generation-wins') {
      doc.generation_date = null
      documents.push({ ...doc, bsale_id: id - 1 })
    }
    if (['exclude-historical', 'exclude-current'].includes(name)) {
      card.bsale_nv_id = id - 1
      card.current_bsale_nv_id = id
    }
    if (name.includes('invoice') && name !== 'invoiced-stage') {
      const invoiceId = 10000 + id
      const invoiceCompany = name === 'other-company-invoice' ? B : A
      if (name !== 'missing-invoice') documents.push({ ...doc, company_id: invoiceCompany, bsale_id: invoiceId,
        document_type_id: name === 'wrong-invoice-type' ? 6 : 5,
        state: name === 'cancelled-invoice' ? 1 : 0, raw_json: { cancellationStatus: '1' } })
      links.push({ company_id: A, sales_order_bsale_id: id, invoice_bsale_id: invoiceId })
      links.push({ company_id: A, sales_order_bsale_id: id, invoice_bsale_id: invoiceId })
    }
    if (name.startsWith('exclude-') || name.endsWith('-exclusion')) {
      let excludedId = name === 'exclude-historical' ? id - 1 : id
      if (name === 'exclude-token') {
        excludedId = id - 1
        documents.push({ ...doc, bsale_id: excludedId, generation_date: null, raw_json: { token: ` ${doc.raw_json.token} ` } })
      }
      exclusions.push({ company_id: name === 'other-company-exclusion' ? B : A,
        bsale_nv_id: excludedId, active: name !== 'inactive-exclusion' })
    }
    if (['audited-open', 'blocked-with-incident', 'audited-closed-incident'].includes(name)) {
      incidents.push({ company_id: A, card_id: card.id, status: name === 'audited-closed-incident' ? 'RESOLVED' : 'OPEN' })
    }
    cards.push(card)
    if (name !== 'missing-document') documents.push(doc)
    if (name !== 'no-details') details.push(
      { company_id: company, bsale_document_id: card.current_bsale_nv_id ?? id, quantity: 2.5 },
      { company_id: company, bsale_document_id: card.current_bsale_nv_id ?? id, quantity: 1 },
      { company_id: B, bsale_document_id: id, quantity: 1000 },
    )
    if (visible) expected.set(card.id, { name, readiness, nv: card.current_bsale_nv_id ?? id, quantity: name === 'no-details' ? null : '3.5' })
  }
  const ctes = [
    fixture('cards', cards, 'id uuid, company_id uuid, status text, priority integer, assigned_user_id uuid, route_date date, normalized_city text, bsale_nv_id bigint, current_bsale_nv_id bigint, canonical_bsale_token text, created_at timestamptz, updated_at timestamptz, locked_by_user_id uuid, locked_at timestamptz, closed_at timestamptz'),
    fixture('documents', documents, 'company_id uuid, bsale_id integer, number integer, document_type_id integer, state integer, client_id integer, office_id integer, emission_date date, generation_date timestamptz, total_amount numeric, net_amount numeric, tax_amount numeric, raw_json jsonb'),
    fixture('details', details, 'company_id uuid, bsale_document_id integer, quantity numeric'),
    fixture('links', links, 'company_id uuid, sales_order_bsale_id integer, invoice_bsale_id integer'),
    fixture('exclusions', exclusions, 'company_id uuid, bsale_nv_id bigint, active boolean'),
    fixture('incidents', incidents, 'company_id uuid, card_id uuid, status text'),
    fixture('clients', [{ company_id: A, bsale_client_id: 1, company: 'Fixture client' }], 'company_id uuid, bsale_client_id integer, company text, code text, city text, commune text'),
    fixture('sellers', [{ company_id: A, bsale_id: 1, name: 'Fixture seller' }], 'company_id uuid, bsale_id integer, name text'),
    fixture('attempts', [], 'company_id uuid, card_id uuid, bsale_invoice_id integer, status text, confirmed_at timestamptz, created_at timestamptz'),
    fixture('guide_items', [], 'company_id uuid, route_guide_id uuid, validation_status text, invoice_bsale_id integer, invoice_number text'),
    fixture('guides', [], 'id uuid, company_id uuid, status text'),
    `canonical AS (${substitute(view(canonicalMigration, 'integraciones.vw_bsale_sales_order_documents_canonical'))})`,
    `nv AS (${substitute(view(canonicalMigration, 'integraciones.vw_bsale_sales_orders_for_preparation'))})`,
    `old_board AS (${substitute(view(boardMigration, 'logistica.vw_sales_order_preparation_board'))})`,
  ]
  const outputColumns = migration.split('RETURNS TABLE (')[1].split(')\nLANGUAGE')[0]
    .split(',').map(s => s.trim().split(/\s+/)[0]).join(',')
  const query = `WITH ${ctes.join(',\n')},
    proposed(${outputColumns}) AS (${substitute(body).replaceAll('p_company_id', '$1::uuid')}),
    baseline AS (
      SELECT b.* FROM old_board b WHERE b.company_id = $1::uuid
        AND b.status IN ('PENDING_ROUTE_PREP','IN_PREPARATION','IN_AUDIT','AUDITED')
        AND (b.status <> 'AUDITED' OR EXISTS (
          SELECT 1 FROM cards c JOIN documents d
            ON d.company_id=c.company_id AND d.bsale_id=COALESCE(c.current_bsale_nv_id,c.bsale_nv_id)
           AND d.document_type_id=23
          WHERE c.id=b.card_id AND (d.state IS DISTINCT FROM 0 OR EXISTS (
            SELECT 1 FROM incidents i WHERE i.card_id=c.id AND i.status='OPEN'
          ))
        ))
    )
    SELECT 'proposed' AS source, to_jsonb(p) AS row FROM proposed p
    UNION ALL SELECT 'baseline', to_jsonb(b) FROM baseline b`
  await withReadOnlyDatabase(async db => {
    const { rows } = await db.query(query, [A])
    const actual = rows.filter(r => r.source === 'proposed').map(r => r.row)
    const baseline = rows.filter(r => r.source === 'baseline').map(r => r.row)
    const redact = row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'route_readiness'))
    const sorted = rows => rows.map(redact).sort((a, b) => a.card_id.localeCompare(b.card_id))
    assert.deepEqual(sorted(actual), sorted(baseline), 'all operational fields must equal the old SQL views')
    assert.deepEqual(actual.map(r => r.card_id).sort(), [...expected.keys()].sort())
    for (const row of actual) {
      const want = expected.get(row.card_id)
      assert.equal(row.route_readiness, want.readiness, want.name)
      assert.equal(row.nv_bsale_id, want.nv, want.name)
      assert.equal(row.total_quantity == null ? null : String(row.total_quantity), want.quantity, want.name)
      // The operator's four visible columns already display these NV amounts;
      // restricted rows and invoice/guide data are what the RPC excludes.
      assert.equal(row.total_amount, 119, want.name)
      assert.equal(row.gross_amount, 119, want.name)
      assert.equal(row.net_amount, 100, want.name)
      assert.equal(row.tax_amount, 19, want.name)
      assert.equal(row.invoice_folio, null, want.name)
      assert.equal(row.is_invoiced, false, want.name)
    }
    // Compare ordering separately: final UNION ALL is not an ordering contract.
    const ordered = await db.query(`WITH ${ctes.join(',\n')}, proposed(${outputColumns}) AS (${substitute(body).replaceAll('p_company_id', '$1::uuid')}) SELECT card_id,priority,nv_emission_date FROM proposed`, [A])
    for (let i = 1; i < ordered.rows.length; i++) assert.ok(ordered.rows[i - 1].priority >= ordered.rows[i].priority)
  })
})

test('SQL authorization predicate: deny foreign/inactive roles and explicit permission failures', { skip: !enabled }, async () => {
  await withReadOnlyDatabase(async db => {
    const scenarios = [
      ['operator', {}, true], ['anonymous', { actor: null }, false],
      ['null-company', { company: null }, false], ['non-authenticated', { authRole: 'anon' }, false],
      ['service-role', { authRole: 'service_role' }, false],
      ['foreign-user', { user: uuid(999) }, false], ['foreign-company', { accessCompany: B }, false],
      ['inactive-access', { accessActive: false }, false], ['wrong-effective-role', { role: 'SUPER_USUARIO' }, false],
      ['inactive-profile', { profileActive: false }, false], ['deleted-profile', { deleted: '2026-10-29' }, false],
      ['inactive-company', { companyActive: false }, false], ['company-access-denied', { access: false }, false],
      ['global-denial', { global: false }, false], ['company-denial', { permission: false }, false],
      ['null-permission', { permission: null }, false],
    ]
    for (const [name, override, expected] of scenarios) {
      const s = { actor, user: actor, company: A, accessCompany: A, authRole: 'authenticated', role: 'OPERADOR_BODEGA',
        accessActive: true, profileActive: true, deleted: null, companyActive: true, access: true, global: true, permission: true, ...override }
      const bool = value => value === null ? 'NULL::boolean' : String(value)
      const predicate = authorization.replaceAll('portal.users', 'profiles').replaceAll('core.companies', 'companies')
        .replaceAll('core.user_company_access', 'accesses')
        .replace("auth.role()", '$3::text')
        .replace('core.has_company_access(v_actor, p_company_id)', bool(s.access))
        .replace("portal.user_has_permission(v_actor, 'module.logistica.view')", bool(s.global))
        .replace("core.has_permission_for_company(v_actor, p_company_id, 'module.logistica.view')", bool(s.permission))
        .replaceAll('v_actor', '$1::uuid').replaceAll('p_company_id', '$2::uuid')
      const ctes = [
        fixture('profiles', [{ id: actor, is_active: s.profileActive, deleted_at: s.deleted }], 'id uuid,is_active boolean,deleted_at timestamptz'),
        fixture('companies', [{ id: A, is_active: s.companyActive }], 'id uuid,is_active boolean'),
        fixture('accesses', [{ user_id: s.user, company_id: s.accessCompany, is_active: s.accessActive, role: s.role }], 'user_id uuid,company_id uuid,is_active boolean,role text'),
      ]
      const result = await db.query(`WITH ${ctes.join(',')} SELECT (${predicate}) IS TRUE AS allowed`, [s.actor, s.company, s.authRole])
      assert.equal(result.rows[0].allowed, expected, name)
    }
  })
})
