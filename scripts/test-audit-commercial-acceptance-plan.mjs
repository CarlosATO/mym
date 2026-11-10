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
const plan = (previous, current, lines = auditedLines) => planAuditCommercialAcceptance({ previous, current, auditedLines: lines })

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
  assert.ok(plan(version(5), current).errors.includes('lineTaxAmount_CHANGED_OR_MISSING'))
})

test('fixture de dos productos: reducción 5 a 4 y otra línea sin cambios en 12', () => {
  const previous = version(5)
  const current = version(4)
  const other = { detailId: 2, variantId: 2, sku: 'B', quantity: 12, unitNetValue: 10, lineNetAmount: 120, lineTaxAmount: 24, lineGrossAmount: 144 }
  for (const item of [previous, current]) {
    item.lines.push(other)
    item.sourceDetails.push({ id: 2, netDiscount: 0 })
    item.netAmount += 120; item.taxAmount += 24; item.totalAmount += 144
  }
  assert.equal(plan(previous, current, [...auditedLines, { bsale_detail_id: 2, bsale_variant_id: 2, sku: 'B', product_name: 'B', audit_quantity: 12 }]).eligible, true)
})
