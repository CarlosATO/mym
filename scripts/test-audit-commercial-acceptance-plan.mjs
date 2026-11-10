import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintAuditCommercialApproval, planAuditCommercialAcceptance } from '../src/lib/logistica/audit-commercial-acceptance-plan.ts'

const identity = { canonicalToken: 'fixture', historicalBsaleId: 1, currentBsaleId: 1, folio: '1' }
const version = (quantity, unit = 100) => ({
  identity, physicalId: 1,
  lines: [{ detailId: 1, variantId: 1, sku: 'A', quantity, unitNetValue: unit, lineNetAmount: unit * quantity, lineTaxAmount: 19 * quantity, lineGrossAmount: (unit + 19) * quantity }],
  netAmount: unit * quantity, taxAmount: 19 * quantity, totalAmount: (unit + 19) * quantity,
  sourceDetails: [{ id: 1, netDiscount: 0 }],
})
const auditedLines = [{ bsale_detail_id: 1, bsale_variant_id: 1, sku: 'A', product_name: 'A', audit_quantity: 4 }]
const evidence = (previous, current) => ({
  canonicalToken: previous.identity.canonicalToken, fetchedAt: '2026-11-10T12:00:00Z',
  tax: { id: 1, code: '14', percentage: 19, active: true, source: '/taxes/1.json' },
  previousDocument: { id: previous.physicalId, taxIds: [1], exemptAmount: 0, taxAmount: previous.taxAmount, source: `/documents/${previous.physicalId}/document_taxes.json` },
  currentDocument: { id: current.physicalId, taxIds: [1], exemptAmount: 0, taxAmount: current.taxAmount, source: `/documents/${current.physicalId}/document_taxes.json` },
  products: current.lines.map(line => ({ variantId: line.variantId, productId: line.variantId + 100, taxIds: [1], source: `/products/${line.variantId + 100}/product_taxes.json` })),
})
const plan = (previous, current, lines = auditedLines, taxEvidence = evidence(previous, current)) => planAuditCommercialAcceptance({ previous, current, auditedLines: lines, taxEvidence })

test('reducción proporcional con cantidades auditadas coincidentes', () => {
  const result = plan(version(5), version(4))
  assert.equal(result.eligible, true)
  assert.ok(result.differences.some(item => item.kind === 'QUANTITY_DECREASED'))
})

test('diferencia física o precio independiente bloquean', () => {
  assert.ok(plan(version(5), version(4), [{ ...auditedLines[0], audit_quantity: 3 }]).errors.includes('AUDITED_QUANTITIES_MISMATCH'))
  assert.ok(plan(version(5), version(4, 120)).errors.includes('UNIT_PRICE_CHANGED_OR_MISSING'))
})

test('ausencia o cambio de descuento bloquea y cambia fingerprint', () => {
  const current = version(4)
  const changed = { ...current, sourceDetails: [{ id: 1, netDiscount: 1 }] }
  assert.notEqual(fingerprintAuditCommercialApproval(current), fingerprintAuditCommercialApproval(changed))
  assert.ok(plan(version(5), changed).errors.includes('DISCOUNT_CHANGED'))
  assert.ok(plan(version(5), { ...current, sourceDetails: [] }).errors.includes('DISCOUNT_EVIDENCE_MISSING'))
  assert.ok(plan(current, changed).errors.includes('DISCOUNT_CHANGED'))
})

test('descuento ausente no satisface el contrato SQL de evidencia', () => {
  const previous = { ...version(5), sourceDetails: [{ id: 1 }] }
  const current = { ...version(4), sourceDetails: [{ id: 1 }] }
  assert.ok(plan(previous, current).errors.includes('DISCOUNT_EVIDENCE_MISSING'))
  const discounted = { ...previous, lines: [{ ...previous.lines[0], lineNetAmount: 490 }] }
  assert.ok(plan(discounted, current).errors.includes('DISCOUNT_EVIDENCE_MISSING'))
})

test('redondeos no proporcionales se rechazan conservadoramente', () => {
  const current = version(4)
  current.lines[0].lineTaxAmount = 77
  current.taxAmount = 77
  assert.ok(plan(version(5), current).errors.includes('TAX_AMOUNT_INVALID'))
})

test('fixture fiscal 5172: 694 → 555 redondeado y AUT 12 sin cambio', () => {
  const oldIdentity = { ...identity, currentBsaleId: 93141 }
  const newIdentity = { ...identity, currentBsaleId: 93200 }
  const aut = { detailId: 2, variantId: 4733, sku: 'AUT.', quantity: 12, unitNetValue: 3000, lineNetAmount: 36000, lineTaxAmount: 6840, lineGrossAmount: 42840 }
  const p = (quantity, net, tax, gross) => ({ detailId: 1, variantId: 5869, sku: 'P317', quantity, unitNetValue: 730, lineNetAmount: net, lineTaxAmount: tax, lineGrossAmount: gross })
  const previous = { identity: oldIdentity, physicalId: 93141, lines: [p(5,3650,694,4344),aut], sourceDetails: [{id:1,netDiscount:0},{id:2,netDiscount:0}], netAmount:39650, taxAmount:7534, totalAmount:47184 }
  const current = { identity: newIdentity, physicalId: 93200, lines: [p(4,2920,555,3475),aut], sourceDetails: [{id:1,netDiscount:0},{id:2,netDiscount:0}], netAmount:38920, taxAmount:7395, totalAmount:46315 }
  const lines = [{bsale_detail_id:1,bsale_variant_id:5869,sku:'P317',product_name:'P317',audit_quantity:4},{bsale_detail_id:2,bsale_variant_id:4733,sku:'AUT.',product_name:'AUT.',audit_quantity:12}]
  const result = plan(previous,current,lines)
  assert.equal(result.eligible, true)
  assert.equal(result.humanApprovalRequired, true)
  assert.equal(result.historicalTaxRateCertified, false)
  assert.match(result.taxEvidenceFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(planAuditCommercialAcceptance({previous,current,auditedLines:lines}).eligible, false)
  const multiple = evidence(previous,current); multiple.currentDocument.taxIds = [1,2]
  assert.equal(plan(previous,current,lines,multiple).eligible, false)
  const exempt = evidence(previous,current); exempt.previousDocument.exemptAmount = 1
  assert.equal(plan(previous,current,lines,exempt).eligible, false)
  const wrongProductTax = evidence(previous,current); wrongProductTax.products[0].taxIds = [2]
  assert.equal(plan(previous,current,lines,wrongProductTax).eligible, false)
  const wrongSource = evidence(previous,current); wrongSource.tax.source = '/unverified'
  assert.equal(plan(previous,current,lines,wrongSource).eligible, false)
  const wrongRate = evidence(previous,current); wrongRate.tax.percentage = 18
  assert.equal(plan(previous,current,lines,wrongRate).eligible, false)
  const incorrect = structuredClone(current); incorrect.lines[0].lineTaxAmount = 556
  assert.equal(plan(previous,incorrect,lines).eligible, false)
  const changedDiscount = structuredClone(current); changedDiscount.sourceDetails[0].netDiscount = 1
  assert.equal(plan(previous,changedDiscount,lines).eligible, false)
  const changedPrice = structuredClone(current); changedPrice.lines[0].unitNetValue = 731
  assert.equal(plan(previous,changedPrice,lines).eligible, false)
})

test('normaliza detalles anidados en raw_json sin usar el id del registro local', () => {
  const previous = { ...version(5), sourceDetails: [{ id: 'local-row', raw_json: { id: 1, netDiscount: 0 } }] }
  const current = { ...version(4), sourceDetails: [{ id: 1, netDiscount: 0 }] }
  assert.equal(plan(previous, current).eligible, true)
})

test('fixture de dos productos: reducción 5 a 4 y otra línea sin cambios en 12', () => {
  const previous = version(5)
  const current = version(4)
  const other = { detailId: 2, variantId: 2, sku: 'B', quantity: 12, unitNetValue: 10, lineNetAmount: 120, lineTaxAmount: 23, lineGrossAmount: 143 }
  for (const item of [previous, current]) {
    item.lines.push(other)
    item.sourceDetails.push({ id: 2, netDiscount: 0 })
    item.netAmount += 120; item.taxAmount += 23; item.totalAmount += 143
  }
  assert.equal(plan(previous, current, [...auditedLines, { bsale_detail_id: 2, bsale_variant_id: 2, sku: 'B', product_name: 'B', audit_quantity: 12 }]).eligible, true)
})
