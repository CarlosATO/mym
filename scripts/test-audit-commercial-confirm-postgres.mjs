// Requires test-audit-commercial-acceptance-postgres.sql in the isolated test DB.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import ts from 'typescript'
import { buildAuditCommercialPreview, buildAuditCommercialReview } from '../src/lib/logistica/audit-commercial-preview.ts'
import { signAuditCommercialReview, verifyAuditCommercialReview } from '../src/lib/logistica/audit-commercial-review-token.ts'
import { fingerprintCommercialVersion } from '../src/lib/logistica/preparation-commercial-version.ts'

const host = process.env.AUDIT_TEST_PGHOST
const port = process.env.AUDIT_TEST_PGPORT
const database = process.env.AUDIT_TEST_PGDATABASE
if (host !== '/var/folders/fv/h7c_389x6xd7_yc8z8dfs6940000gn/T/opencode' || port !== '56437' || database !== 'audit_test') throw new Error('Disposable PostgreSQL socket, port and database required')
const ids = { companyId: '00000000-0000-0000-0000-000000000001', cardId: '00000000-0000-0000-0000-000000000002', auditId: '00000000-0000-0000-0000-000000000003', actorId: '00000000-0000-0000-0000-000000000004' }
const secret = Buffer.alloc(32, 42).toString('base64url')

test('vista previa → confirmación y reintento con Bsale simulado y PostgreSQL aislado', async () => {
  const client = new pg.Client({ host, port: Number(port), database })
  await client.connect()
  try {
    await client.query('ALTER TABLE logistica.sales_order_preparation_cards ADD COLUMN bsale_nv_folio text')
    await client.query("UPDATE logistica.sales_order_preparation_cards SET bsale_nv_folio='5172'")
    await client.query("UPDATE logistica.sales_order_audit_lines SET audit_quantity=4,prepared_quantity_snapshot=4 WHERE bsale_variant_id=1")
    await client.query('DELETE FROM logistica.sales_order_audit_commercial_acceptance_requests')
    await client.query('DELETE FROM logistica.sales_order_preparation_commercial_versions WHERE sequence_no=2')
    await client.query("UPDATE logistica.sales_order_audit_commercial_verifications SET is_current=true WHERE id='00000000-0000-0000-0000-000000000010'")
    const makeDocument = (id, state, net, tax, total, generationDate) => ({ id, number: 5172, state, token: 'token', document_type: { id: '23' }, netAmount: net, taxAmount: tax, totalAmount: total, exemptAmount: 0, generationDate })
    const old = makeDocument(93141, 1, 39650, 7534, 47184, 1)
    const current = makeDocument(10, 0, 38920, 7395, 46315, 2)
    const lists = {
      '/documents.json': [old, current],
      '/documents/10/details.json': [{ id: 1, variant: { id: '1', code: 'P317' }, quantity: 4, netUnitValue: 730, netAmount: 2920, taxAmount: 555, totalAmount: 3475, netDiscount: 0 }, { id: 2, variant: { id: '2', code: 'AUT.' }, quantity: 12, netUnitValue: 3000, netAmount: 36000, taxAmount: 6840, totalAmount: 42840, netDiscount: 0 }],
      '/documents/93141/document_taxes.json': [{ id: 111, tax: { id: '1' }, totalAmount: 7534, exemptAmount: 0 }],
      '/documents/10/document_taxes.json': [{ id: 112, tax: { id: '1' }, totalAmount: 7395, exemptAmount: 0 }],
      '/products/101/product_taxes.json': [{ id: 21, tax: { id: '1' } }], '/products/102/product_taxes.json': [{ id: 22, tax: { id: '1' } }],
    }
    const resources = { '/documents/93141.json': old, '/documents/10.json': current, '/taxes/1.json': { id: 1, code: '14', percentage: '19.0', state: 0 }, '/variants/1.json': { id: 1, code: 'P317', product: { id: '101' } }, '/variants/2.json': { id: 2, code: 'AUT.', product: { id: '102' } } }
    let allowed = true; let reads = 0; let bsaleDown = false
    const from = table => {
      const state = { columns: '*', conditions: [], params: [], order: '', limit: '' }
      const execute = async (single = false) => {
        try {
          const result = await client.query(`SELECT ${state.columns} FROM logistica.${table}${state.conditions.length ? ` WHERE ${state.conditions.join(' AND ')}` : ''}${state.order}${state.limit}`, state.params)
          return { data: single ? result.rows[0] ?? null : result.rows, error: null }
        } catch (error) { return { data: null, error: { message: error.message, code: error.code } } }
      }
      const builder = {
        select: columns => { state.columns = columns; return builder },
        eq: (name, value) => { state.params.push(value); state.conditions.push(`${name}=$${state.params.length}`); return builder },
        order: (name, options) => { state.order = ` ORDER BY ${name} ${options.ascending ? 'ASC' : 'DESC'}`; return builder },
        limit: count => { state.limit = ` LIMIT ${Number(count)}`; return builder },
        maybeSingle: () => execute(true), then: (resolve, reject) => execute().then(resolve, reject),
        insert: async row => { try { const names = Object.keys(row); await client.query(`INSERT INTO logistica.${table} (${names.join(',')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row).map(value => value && typeof value === 'object' ? JSON.stringify(value) : value)); return { error: null } } catch (error) { return { error: { message: error.message, code: error.code } } } },
      }
      return builder
    }
    const rpc = async (name, args) => {
      try { const entries = Object.entries(args); const result = await client.query(`SELECT logistica.${name}(${entries.map(([key], i) => `${key} := $${i + 1}`).join(',')}) AS value`, entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value)); return { data: result.rows[0].value, error: null } } catch (error) { return { data: null, error: { message: error.message, code: error.code } } }
    }
    const mocks = {
      '@/lib/supabase/admin': { createAdminClient: () => ({ schema: () => ({ from, rpc }) }) },
      '@/lib/bsale/client': { bsaleFetchResourceForCompany: async ({ path, params, cache }) => { assert.equal(cache, 'no-store'); reads++; if (bsaleDown) throw new Error('BSALE_UNAVAILABLE'); if (path in lists) return { count: lists[path].length, offset: params.offset, items: structuredClone(lists[path].slice(params.offset, params.offset + 1)) }; if (!(path in resources)) throw new Error('BSALE_UNAVAILABLE'); return structuredClone(resources[path]) } },
      '@/lib/logistica/audit-commercial-preview': { buildAuditCommercialPreview, buildAuditCommercialReview },
      '@/lib/logistica/audit-commercial-review-token': { signAuditCommercialReview, verifyAuditCommercialReview },
      '@/lib/logistica/preparation-commercial-version': { fingerprintCommercialVersion },
      './authorization': { requireWmsPermission: async () => { if (!allowed) throw new Error('No autorizado'); return { companyId: ids.companyId, user: { id: ids.actorId } } }, requirePreparationCardAccess: async () => {} },
      'node:crypto': { randomUUID },
    }
    const load = path => { const source = readFileSync(new URL(path, import.meta.url), 'utf8'); const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const exports = {}; vm.runInNewContext(compiled, { exports, require: name => { if (!mocks[name]) throw new Error(`Unexpected import ${name}`); return mocks[name] }, AbortSignal, Number, Error, process: { env: { AUDIT_COMMERCIAL_REVIEW_SECRET: secret } } }); return exports }
    const preview = load('../src/app/actions/logistica/sales-order-audit-commercial-preview.ts').previewSalesOrderAuditCommercialAcceptance
    const confirm = load('../src/app/actions/logistica/sales-order-audit-commercial-confirm.ts').confirmSalesOrderAuditCommercialAcceptance
    const args = { companyId: ids.companyId, cardId: ids.cardId, auditId: ids.auditId }
    const reviewed = await preview(args)
    assert.equal(reviewed.error, null); assert.equal(reviewed.data.eligible, true)
    const request = { ...args, reviewedReference: reviewed.data.reviewedReference }
    assert.equal((await confirm({ ...request, reviewedReference: `${request.reviewedReference}x` })).error, 'AUDIT_REVIEW_INVALID')
    const expiredPayload = verifyAuditCommercialReview(request.reviewedReference, secret, { ...args, actorId: ids.actorId, cycleNo: 2 })
    const expired = signAuditCommercialReview({ ...expiredPayload, issuedAt: Date.now() - 900001 }, secret)
    assert.equal((await confirm({ ...request, reviewedReference: expired })).error, 'AUDIT_REVIEW_INVALID')
    lists['/documents/10/details.json'][0].netDiscount = 1
    assert.equal((await confirm(request)).error, 'AUDIT_COMMERCIAL_REVIEW_CHANGED')
    lists['/documents/10/details.json'][0].netDiscount = 0
    bsaleDown = true; assert.equal((await confirm(request)).error, 'BSALE_UNAVAILABLE'); bsaleDown = false
    await client.query('UPDATE logistica.sales_order_audits SET package_count=9')
    assert.equal((await confirm(request)).error, 'AUDIT_PHYSICAL_SNAPSHOT_CHANGED')
    await client.query('UPDATE logistica.sales_order_audits SET package_count=8')
    await client.query('UPDATE logistica.sales_order_audit_lines SET audit_quantity=3,prepared_quantity_snapshot=3 WHERE bsale_variant_id=1')
    assert.equal((await confirm(request)).error, 'AUDIT_PHYSICAL_SNAPSHOT_CHANGED')
    await client.query('UPDATE logistica.sales_order_audit_lines SET audit_quantity=4,prepared_quantity_snapshot=4 WHERE bsale_variant_id=1')
    allowed = false; assert.equal((await confirm(request)).error, 'No autorizado'); allowed = true
    await client.query("UPDATE logistica.sales_order_audit_incidents SET status='OPEN'")
    assert.equal((await confirm(request)).error, 'AUDIT_OPEN_INCIDENTS')
    assert.equal((await client.query("SELECT status FROM logistica.sales_order_audit_incidents")).rows[0].status, 'OPEN')
    await client.query("UPDATE logistica.sales_order_audit_incidents SET status='RESOLVED'")
    await client.query("UPDATE logistica.sales_order_preparation_incidents SET status='OPEN'")
    assert.equal((await confirm(request)).error, 'AUDIT_OPEN_INCIDENTS')
    assert.equal((await client.query("SELECT status FROM logistica.sales_order_preparation_incidents")).rows[0].status, 'OPEN')
    await client.query("UPDATE logistica.sales_order_preparation_incidents SET status='RESOLVED'")
    await client.query("UPDATE logistica.sales_order_audits SET status='CLOSED'")
    assert.equal((await confirm(request)).error, 'AUDIT_NOT_OPEN')
    await client.query("UPDATE logistica.sales_order_audits SET status='OPEN'")
    const beforeReads = reads
    const accepted = await confirm(request); assert.equal(accepted.error, null); assert.equal(accepted.data.status, 'ACCEPTED'); assert.ok(reads > beforeReads)
    const afterAcceptance = await client.query('SELECT count(*) AS n FROM logistica.sales_order_audit_commercial_verifications WHERE is_current')
    assert.equal(afterAcceptance.rows[0].n, '0')
    await client.query("INSERT INTO logistica.sales_order_audit_commercial_verifications VALUES ('00000000-0000-0000-0000-000000000020',$1,$2,$3,true)", [ids.companyId, ids.cardId, ids.auditId])
    const retried = await confirm(request); assert.equal(retried.error, null); assert.equal(retried.data.status, 'ALREADY_ACCEPTED'); assert.equal(retried.data.versionId, accepted.data.versionId)
    allowed = false; assert.equal((await confirm(request)).error, 'No autorizado'); allowed = true
    assert.equal((await confirm({ ...request, reviewedReference: expired })).error, 'AUDIT_REVIEW_INVALID')
    await client.query('UPDATE logistica.sales_order_audits SET package_count=9')
    assert.equal((await confirm(request)).error, 'AUDIT_PHYSICAL_SNAPSHOT_CHANGED')
    await client.query('UPDATE logistica.sales_order_audits SET package_count=8')
    const state = await client.query("SELECT (SELECT count(*) FROM logistica.sales_order_preparation_commercial_versions) AS versions, (SELECT count(*) FROM logistica.sales_order_audit_commercial_verifications WHERE is_current) AS current_verifications, (SELECT package_count FROM logistica.sales_order_audits) AS packages, (SELECT cycle_no FROM logistica.sales_order_audits) AS cycle, (SELECT sum(audit_quantity) FROM logistica.sales_order_audit_lines) AS quantity, (SELECT status FROM logistica.sales_order_audits) AS status, (SELECT version_snapshot->'lines'->0->>'quantity' FROM logistica.sales_order_preparation_commercial_versions WHERE sequence_no=1) AS old_quantity")
    assert.deepEqual(state.rows[0], { versions: '2', current_verifications: '1', packages: 8, cycle: 2, quantity: '16', status: 'OPEN', old_quantity: '5' })
    const persisted = await client.query('SELECT approval_evidence::text AS approval, version_snapshot::text AS snapshot FROM logistica.sales_order_audit_commercial_acceptance_requests WHERE id=$1', [expiredPayload.requestId])
    assert.equal(persisted.rows.length, 1)
    assert.equal(persisted.rows[0].approval.includes(request.reviewedReference), false)
    assert.equal(persisted.rows[0].snapshot.includes(request.reviewedReference), false)
  } finally { await client.end() }
})
