import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { randomUUID } from 'node:crypto'
import { buildAuditCommercialPreview } from '../src/lib/logistica/audit-commercial-preview.ts'
import { fingerprintCommercialVersion } from '../src/lib/logistica/preparation-commercial-version.ts'
import { signAuditCommercialReview, verifyAuditCommercialReview } from '../src/lib/logistica/audit-commercial-review-token.ts'

const line = (variantId, sku, quantity, net, tax, gross, unit, detailId) => ({ detailId, variantId, sku, quantity, unitNetValue: unit, lineNetAmount: net, lineTaxAmount: tax, lineGrossAmount: gross })
const previous = { identity: { canonicalToken: 'fixture', historicalBsaleId: 93141, currentBsaleId: 93141, folio: '5172' }, physicalId: 93141,
  lines: [line(5869, 'P317', 5, 3650, 694, 4344, 730, 1), line(4733, 'AUT.', 12, 36000, 6840, 42840, 3000, 2)],
  sourceDocument: { id: 93141, number: 5172, token: 'fixture', document_type: { id: '23' } }, sourceDetails: [{ id: 1, netDiscount: 0 }, { id: 2, netDiscount: 0 }], netAmount: 39650, taxAmount: 7534, totalAmount: 47184 }
const input = { canonicalToken: 'fixture', folio: '5172', historicalBsaleId: 93141, previousVersionId: 'version-1', previousFingerprint: fingerprintCommercialVersion(previous).value, previous,
  previousRecord: { id: 'version-1', companyId: 'company', cardId: 'card', canonicalToken: 'fixture', historicalBsaleId: 93141, currentBsaleId: 93141 },
  auditContext: { companyId: 'company', cardId: 'card', auditId: 'audit', packageCount: 8 },
  auditedLines: [{ bsale_detail_id: 1, bsale_variant_id: 5869, sku: 'P317', product_name: 'P317', audit_quantity: 4 }, { bsale_detail_id: 2, bsale_variant_id: 4733, sku: 'AUT.', product_name: 'AUT.', audit_quantity: 12 }] }
const document = (id, state, net, tax, total, generationDate) => ({ id, number: 5172, state, token: 'fixture', document_type: { id: '23' }, netAmount: net, taxAmount: tax, totalAmount: total, exemptAmount: 0, generationDate })
const detail = (id, variantId, code, quantity, netUnitValue, netAmount, taxAmount, totalAmount) => ({ id, variant: { id: String(variantId), code }, quantity, netUnitValue, netAmount, taxAmount, totalAmount, netDiscount: 0 })
function fixture() {
  const old = { ...document(93141, 8888, 39650, 7534, 47184, 1), number: 0, token: 'historical-token' }
  const current = document(93200, 0, 38920, 7395, 46315, 2)
  const lists = {
    '/documents.json': [old, current],
    '/documents/93141/details.json': [detail(1, 5869, 'P317', 5, 730, 3650, 694, 4344), detail(2, 4733, 'AUT.', 12, 3000, 36000, 6840, 42840)],
    '/documents/93200/details.json': [detail(11, 5869, 'P317', 4, 730, 2920, 555, 3475), detail(12, 4733, 'AUT.', 12, 3000, 36000, 6840, 42840)],
    '/documents/93141/document_taxes.json': [{ id: 111, tax: { id: '1' }, totalAmount: 7534, exemptAmount: 0 }],
    '/documents/93200/document_taxes.json': [{ id: 112, tax: { id: '1' }, totalAmount: 7395, exemptAmount: 0 }],
    '/products/2183/product_taxes.json': [{ id: '21', tax: { id: '1' } }],
    '/products/2910/product_taxes.json': [{ id: '22', tax: { id: '1' } }],
  }
  const resources = { '/documents/93141.json': old, '/documents/93200.json': current, '/taxes/1.json': { id: 1, code: '14', percentage: '19.0', state: 0 }, '/variants/5869.json': { id: 5869, code: 'P317', product: { id: '2183' } }, '/variants/4733.json': { id: 4733, code: 'AUT.', product: { id: '2910' } } }
  const fetch = async (path, params) => {
    if (path in lists) return { count: lists[path].length, offset: params.offset, items: structuredClone(lists[path].slice(params.offset, params.offset + 1)) }
    if (!(path in resources)) throw new Error('unexpected endpoint')
    return structuredClone(resources[path])
  }
  return { lists, resources, fetch }
}

test('NV 5172: lectura paginada, documento histórico inactivo y evidencia fiscal', async () => {
  const f = fixture(); const result = await buildAuditCommercialPreview(input, f.fetch)
  assert.equal(result.eligible, true); assert.equal(result.currentBsaleId, 93200)
  assert.equal(result.historicalTaxRateCertified, false); assert.match(result.reviewedReference, /^[0-9a-f]{64}$/)
  assert.equal(result.comparison.previous.totalAmount, 47184); assert.equal(result.comparison.current.totalAmount, 46315)
  assert.deepEqual(result.comparison.previous.lines.map(line => [line.sku, line.quantity, line.netDiscount]), [['P317', 5, 0], ['AUT.', 12, 0]])
  assert.deepEqual(result.comparison.current.lines.map(line => [line.sku, line.quantity, line.netDiscount]), [['P317', 4, 0], ['AUT.', 12, 0]])
  assert.equal('sourceDetails' in result.comparison.current, false)
  assert.ok(result.differences.some(item => item.kind === 'QUANTITY_DECREASED'))
  assert.equal(result.reviewedReference, (await buildAuditCommercialPreview(input, f.fetch)).reviewedReference)
  assert.notEqual(result.reviewedReference, (await buildAuditCommercialPreview({ ...input, auditContext: { ...input.auditContext, packageCount: 9 } }, f.fetch)).reviewedReference)
  assert.notEqual(result.reviewedReference, (await buildAuditCommercialPreview({ ...input, auditContext: { ...input.auditContext, auditId: 'other' } }, f.fetch)).reviewedReference)
  assert.notEqual(result.reviewedReference, (await buildAuditCommercialPreview({ ...input, auditedLines: [{ ...input.auditedLines[0], audit_quantity: 3 }, input.auditedLines[1]] }, f.fetch)).reviewedReference)
})

test('cambios tributarios, identidad y fuente incompleta bloquean', async () => {
  for (const mutate of [
    f => { f.lists['/documents/93200/document_taxes.json'][0].tax.id = '2' },
    f => { f.lists['/products/2183/product_taxes.json'][0].tax.id = '2' },
    f => { f.resources['/documents/93141.json'].netAmount = 1 },
    f => { f.resources['/variants/5869.json'].id = 2 },
    f => { f.resources['/taxes/1.json'].percentage = '' },
    f => { f.resources['/documents/93200.json'].state = 1 },
    f => { f.lists['/documents/93141/document_taxes.json'][0].exemptAmount = 1 },
  ]) { const f = fixture(); mutate(f); await assert.rejects(buildAuditCommercialPreview(input, f.fetch)) }
  const f = fixture()
  await assert.rejects(buildAuditCommercialPreview(input, async (path, params) => path === '/documents.json' ? { count: 3, offset: 0, items: [] } : f.fetch(path, params)), /PAGINATION_INCOMPLETE/)
  await assert.rejects(buildAuditCommercialPreview(input, async () => { throw new Error('network') }), /network/)
})

test('histórico reemplazado exige registro vinculado y evidencia persistida íntegra', async () => {
  for (const record of [
    { ...input.previousRecord, companyId: 'other' }, { ...input.previousRecord, cardId: 'other' },
    { ...input.previousRecord, id: 'other' }, { ...input.previousRecord, currentBsaleId: 42 },
    { ...input.previousRecord, historicalBsaleId: 42 }, { ...input.previousRecord, canonicalToken: 'other' },
  ]) await assert.rejects(buildAuditCommercialPreview({ ...input, previousRecord: record }, fixture().fetch), /BSALE_HISTORICAL_IDENTITY_UNVERIFIED/)
  for (const mutate of [
    f => { f.resources['/documents/93141.json'].id = 123 },
    f => { f.resources['/documents/93141.json'].state = 1 },
    f => { f.resources['/documents/93141.json'].number = 123 },
    f => { f.lists['/documents/93141/details.json'][0].quantity = 6 },
    f => { f.lists['/documents/93141/details.json'][0].netDiscount = 1 },
    f => { f.lists['/documents/93141/details.json'][1].id = 1 },
    f => { f.resources['/documents/93200.json'].number = 0 },
    f => { f.resources['/documents/93200.json'].token = 'other' },
    f => { f.resources['/documents/93200.json'].state = 8888 },
  ]) { const f = fixture(); mutate(f); await assert.rejects(buildAuditCommercialPreview(input, f.fetch)) }
  const wrongSource = { ...previous, sourceDocument: { ...previous.sourceDocument, id: 99 } }
  await assert.rejects(buildAuditCommercialPreview({ ...input, previous: wrongSource, previousFingerprint: fingerprintCommercialVersion(wrongSource).value }, fixture().fetch), /BSALE_HISTORICAL_IDENTITY_UNVERIFIED/)
  await assert.rejects(buildAuditCommercialPreview({ ...input, previousFingerprint: 'incorrect' }, fixture().fetch), /BSALE_HISTORICAL_IDENTITY_UNVERIFIED/)
  const ordinary = fixture(); ordinary.resources['/documents/93141.json'].number = 5172; ordinary.resources['/documents/93141.json'].token = 'fixture'; ordinary.resources['/documents/93141.json'].state = 1
  assert.equal((await buildAuditCommercialPreview(input, ordinary.fetch)).eligible, true)
  await assert.rejects(buildAuditCommercialPreview({ ...input, previousRecord: { ...input.previousRecord, cardId: 'other' } }, ordinary.fetch), /BSALE_HISTORICAL_IDENTITY_UNVERIFIED/)
})

test('precio, descuento o cantidades distintos no producen vista previa elegible', async () => {
  for (const mutate of [
    row => { row.netUnitValue = 731 }, row => { row.netDiscount = 1 }, row => { row.quantity = 3 },
  ]) { const f = fixture(); mutate(f.lists['/documents/93200/details.json'][0]); assert.equal((await buildAuditCommercialPreview(input, f.fetch)).eligible, false) }
})

test('la acción exige permisos y solo consulta, sin usar evidencia del navegador', () => {
  const source = readFileSync(new URL('../src/app/actions/logistica/sales-order-audit-commercial-preview.ts', import.meta.url), 'utf8')
  assert.match(source, /requireWmsPermission\('logistica\.audit\.manage'\)/)
  assert.match(source, /requirePreparationCardAccess/)
  assert.match(source, /cache: 'no-store'/)
  assert.doesNotMatch(source, /\.insert\(|\.update\(/)
  assert.match(source, /audit_commercial_physical_snapshot_v1/)
})

test('acción real: vista previa simulada, autorización, auditoría cerrada e incidencia', async () => {
  const f = fixture()
  const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  const companyId = uid(1), cardId = uid(2), auditId = uid(3), actorId = uid(4), versionId = uid(5)
  const secret = Buffer.alloc(32, 42).toString('base64url')
  const rows = {
    sales_order_preparation_cards: { id: cardId, status: 'IN_AUDIT', bsale_nv_id: 93141, bsale_nv_folio: '5172', canonical_bsale_token: 'fixture', current_bsale_nv_id: 93200 },
    sales_order_audits: { id: auditId, status: 'OPEN', package_count: 8, cycle_no: 2 },
    sales_order_preparation_commercial_versions: { id: versionId, company_id: companyId, card_id: cardId, canonical_bsale_token: 'fixture', historical_bsale_nv_id: 93141, current_bsale_nv_id: 93141, fingerprint: fingerprintCommercialVersion(previous).value, version_snapshot: previous },
    sales_order_preparation_incidents: [], sales_order_audit_incidents: [],
  }
  const physical = { companyId, cardId, auditId, cycleNo: 2, packageCount: 8, lines: input.auditedLines.map((row, index) => ({ id: uid(10 + index), companyId, cardId, preparationLineId: uid(20 + index), bsaleDetailId: row.bsale_detail_id, bsaleVariantId: row.bsale_variant_id, sku: row.sku, productName: row.product_name, requestedQuantity: index ? 12 : 5, preparedQuantity: row.audit_quantity, excluded: false, auditQuantity: row.audit_quantity, lineStatus: 'CONFIRMED' })) }
  let allowed = true
  const mocks = {
    '@/lib/supabase/admin': { createAdminClient: () => ({ schema: () => ({ rpc: async name => { assert.equal(name, 'audit_commercial_physical_snapshot_v1'); return { data: structuredClone(physical), error: null } }, from: name => {
      const builder = { select: () => builder, eq: () => builder, order: () => builder, limit: () => builder, maybeSingle: () => Promise.resolve({ data: rows[name], error: null }), then: (resolve, reject) => Promise.resolve({ data: rows[name], error: null }).then(resolve, reject) }
      return builder
    } }) }) },
    '@/lib/bsale/client': { bsaleFetchResourceForCompany: ({ path, params, cache }) => { assert.equal(cache, 'no-store'); return f.fetch(path, params) } },
    '@/lib/logistica/audit-commercial-preview': { buildAuditCommercialPreview },
    '@/lib/logistica/audit-commercial-review-token': { signAuditCommercialReview },
    'node:crypto': { randomUUID },
    './authorization': { requireWmsPermission: async () => { if (!allowed) throw new Error('No autorizado'); return { companyId, user: { id: actorId } } }, requirePreparationCardAccess: async () => {} },
  }
  const source = readFileSync(new URL('../src/app/actions/logistica/sales-order-audit-commercial-preview.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const env = { AUDIT_COMMERCIAL_REVIEW_SECRET: secret }
  vm.runInNewContext(compiled, { exports, require: name => { if (!mocks[name]) throw new Error(`Unexpected import ${name}`); return mocks[name] }, AbortSignal, Number, Error, process: { env } })
  const run = () => exports.previewSalesOrderAuditCommercialAcceptance({ companyId, cardId, auditId })
  const response = await run(); assert.equal(response.data.eligible, true)
  const reviewed = verifyAuditCommercialReview(response.data.reviewedReference, secret, { companyId, cardId, auditId, actorId, cycleNo: 2 })
  assert.deepEqual(reviewed.auditPhysical, physical); assert.equal(reviewed.previousVersionId, versionId)
  assert.match(reviewed.commercialReference, /^[a-f0-9]{64}$/)
  f.lists['/documents/93200/details.json'][0].netDiscount = 1
  const ineligible = await run(); assert.equal(ineligible.data.eligible, false); assert.equal(ineligible.data.reviewedReference, null)
  f.lists['/documents/93200/details.json'][0].netDiscount = 0
  env.AUDIT_COMMERCIAL_REVIEW_SECRET = ''
  assert.equal((await run()).error, 'AUDIT_REVIEW_SECRET_NOT_CONFIGURED')
  env.AUDIT_COMMERCIAL_REVIEW_SECRET = secret
  physical.cycleNo = 3; assert.equal((await run()).error, 'AUDIT_PHYSICAL_SNAPSHOT_INVALID'); physical.cycleNo = 2
  allowed = false; assert.equal((await run()).error, 'No autorizado'); allowed = true
  rows.sales_order_audits.status = 'CLOSED'; assert.equal((await run()).error, 'AUDIT_NOT_OPEN'); rows.sales_order_audits.status = 'OPEN'
  rows.sales_order_audit_incidents.push({ id: 'incident' }); assert.equal((await run()).error, 'AUDIT_OPEN_INCIDENTS')
})
