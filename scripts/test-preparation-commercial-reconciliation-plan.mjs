import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPreparationCommercialReconciliationPlan,
} from '../src/lib/logistica/preparation-commercial-reconciliation-plan.ts'
import { compareCommercialVersions } from '../src/lib/logistica/preparation-commercial-version.ts'

const identity = { canonicalToken: 'token-5129', historicalBsaleId: 92706, currentBsaleId: 92714, folio: '5129' }
const card = { cardId: 'card-5129', companyId: 'company-caylo', status: 'IN_PREPARATION' }

function line(variantId, sku, quantity, extra = {}) {
  return { variantId, sku, productName: sku, quantity, unitNetValue: 1000, lineNetAmount: quantity * 1000, lineTaxAmount: quantity * 190, lineGrossAmount: quantity * 1190, ...extra }
}

function version(physicalId, lines, token = identity.canonicalToken) {
  return {
    identity: { ...identity, canonicalToken: token },
    physicalId,
    lines,
    netAmount: lines.reduce((sum, item) => sum + (item.lineNetAmount ?? 0), 0),
    taxAmount: lines.reduce((sum, item) => sum + (item.lineTaxAmount ?? 0), 0),
    totalAmount: lines.reduce((sum, item) => sum + (item.lineGrossAmount ?? 0), 0),
  }
}

function prep(id, source, requested, prepared = null, status = 'PENDING', excluded = false) {
  return {
    id,
    bsale_detail_id: source.detailId ?? id.length,
    bsale_variant_id: source.variantId ?? null,
    sku: source.sku ?? null,
    product_name: source.productName ?? String(source.sku ?? 'Producto'),
    requested_quantity: requested,
    prepared_quantity: prepared,
    line_status: status,
    excluded_from_dispatch: excluded,
  }
}

function plan(options = {}) {
  const oldLines = options.oldLines ?? baseOld
  const newLines = options.newLines ?? oldLines
  const preparationLines = options.preparationLines ?? []
  const incidents = options.incidents ?? []
  const status = options.status ?? card.status
  const acceptedVersion = Object.hasOwn(options, 'acceptedVersion') ? options.acceptedVersion : version(92706, oldLines)
  const currentVersion = Object.hasOwn(options, 'currentVersion') ? options.currentVersion : version(92714, newLines)
  const comparison = Object.hasOwn(options, 'comparison') ? options.comparison : acceptedVersion && currentVersion ? compareCommercialVersions(acceptedVersion, currentVersion) : null
  const snapshotComplete = options.snapshotComplete ?? true
  return buildPreparationCommercialReconciliationPlan({
    card: { ...card, status }, identity, acceptedVersion, currentVersion, preparationLines, incidents, comparison, snapshotComplete,
  })
}

const baseOld = [line(1, 'A', 1), line(2, 'B', 1), line(3, 'C', 1)]

test('NV 5129 planifica MGMYM retirado y MUESTRA/PW12401 agregados sin trabajo operativo', () => {
  const oldLines = [line(1, 'A', 1), line(2, 'B', 1), line(6594, 'MGMYM', 1), line(4, 'D', 1)]
  const newLines = [line(1, 'A', 1), line(2, 'B', 1), line(4, 'D', 1), line(5729, 'MUESTRA', 1), line(3184, 'PW12401', 1)]
  const result = plan({ oldLines, newLines, preparationLines: oldLines.map((item, index) => prep(`line-${index}`, item, item.quantity)) })
  assert.equal(result.status, 'READY')
  assert.deepEqual(result.actions.filter(action => action.kind === 'REMOVE').map(action => action.previous?.sku), ['MGMYM'])
  assert.deepEqual(result.actions.filter(action => action.kind === 'ADD').map(action => action.current?.sku), ['MUESTRA', 'PW12401'])
})

test('producto nuevo se planifica como ADD', () => {
  const result = plan({ oldLines: baseOld, newLines: [...baseOld, line(4, 'D', 2)], preparationLines: baseOld.map((item, index) => prep(`line-${index}`, item, item.quantity)) })
  assert.equal(result.status, 'READY')
  assert.equal(result.impact.added, 1)
})

test('producto eliminado sin preparar se planifica como REMOVE', () => {
  const result = plan({ oldLines: baseOld, newLines: baseOld.slice(0, 2), preparationLines: baseOld.map((item, index) => prep(`line-${index}`, item, item.quantity)) })
  assert.equal(result.status, 'READY')
  assert.equal(result.impact.removed, 1)
})

test('producto sin cambios conserva una línea preparada', () => {
  const result = plan({ oldLines: baseOld, newLines: baseOld, preparationLines: baseOld.map((item, index) => prep(`line-${index}`, item, item.quantity, item.quantity, 'CONFIRMED')) })
  assert.equal(result.status, 'READY')
  assert.equal(result.actions.filter(action => action.kind === 'KEEP').length, 3)
})

test('cantidad aumentada produce UPDATE_QUANTITY', () => {
  const result = plan({ oldLines: [line(1, 'A', 2)], newLines: [line(1, 'A', 4)], preparationLines: [prep('line-a', line(1, 'A', 2), 2, 2, 'CONFIRMED')] })
  assert.equal(result.status, 'READY')
  assert.equal(result.actions[0].kind, 'UPDATE_QUANTITY')
  assert.equal(result.actions[0].newRequestedQuantity, 4)
})

test('cantidad reducida compatible con lo preparado produce UPDATE_QUANTITY', () => {
  const result = plan({ oldLines: [line(1, 'A', 5)], newLines: [line(1, 'A', 3)], preparationLines: [prep('line-a', line(1, 'A', 5), 5, 2, 'CONFIRMED')] })
  assert.equal(result.status, 'READY')
  assert.equal(result.actions[0].kind, 'UPDATE_QUANTITY')
})

test('cantidad reducida por debajo de lo preparado bloquea', () => {
  const result = plan({ oldLines: [line(1, 'A', 5)], newLines: [line(1, 'A', 3)], preparationLines: [prep('line-a', line(1, 'A', 5), 5, 4, 'CONFIRMED')] })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.conflicts[0].reason, 'QUANTITY_BELOW_PREPARED')
})

test('producto eliminado con preparación confirmada bloquea y preserva el trabajo', () => {
  const result = plan({ oldLines: [line(1, 'A', 2)], newLines: [], preparationLines: [prep('line-a', line(1, 'A', 2), 2, 1, 'CONFIRMED')] })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.conflicts[0].reason, 'REMOVAL_WOULD_DISCARD_WORK')
})

test('producto eliminado con incidencia bloquea sin modificarla', () => {
  const result = plan({ oldLines: [line(1, 'A', 2)], newLines: [], preparationLines: [prep('line-a', line(1, 'A', 2), 2)], incidents: [{ id: 'incident-a', preparation_line_id: 'line-a', status: 'OPEN', incident_type: 'LINE_EXCLUDED' }] })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
  assert.deepEqual(result.conflicts[0].incidentIds, ['incident-a'])
})

test('incidencia sobre producto sin cambios se conserva sin bloquear', () => {
  const result = plan({ oldLines: [line(1, 'A', 2)], newLines: [line(1, 'A', 2)], preparationLines: [prep('line-a', line(1, 'A', 2), 2, 0, 'INCIDENT')], incidents: [{ id: 'incident-a', preparation_line_id: 'line-a', status: 'OPEN' }] })
  assert.equal(result.status, 'READY')
  assert.equal(result.actions[0].kind, 'KEEP')
  assert.deepEqual(result.actions[0].incidentIds, ['incident-a'])
})

test('línea excluida no se elimina automáticamente', () => {
  const result = plan({ oldLines: [line(1, 'A', 2)], newLines: [], preparationLines: [prep('line-a', line(1, 'A', 2), 2, 0, 'INCIDENT', true)] })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
})

test('variante repetida sin emparejamiento inequívoco queda AMBIGUOUS', () => {
  const oldLines = [line(1, 'A', 1), line(1, 'A', 1)]
  const newLines = [line(1, 'A', 2)]
  const comparison = compareCommercialVersions(version(92706, oldLines), version(92714, newLines))
  const result = plan({ oldLines, newLines, comparison, preparationLines: oldLines.map((item, index) => prep(`line-${index}`, item, item.quantity)) })
  assert.equal(result.status, 'AMBIGUOUS')
})

test('snapshot incompleto no genera acciones', () => {
  const result = plan({ acceptedVersion: null, comparison: null, snapshotComplete: false })
  assert.equal(result.status, 'AMBIGUOUS')
  assert.equal(result.conflicts[0].reason, 'SNAPSHOT_INCOMPLETE')
  assert.deepEqual(result.actions, [])
})

test('Auditoría devuelve NOT_APPLICABLE', () => {
  const result = plan({ status: 'IN_AUDIT' })
  assert.equal(result.status, 'NOT_APPLICABLE')
  assert.deepEqual(result.actions, [])
})

test('versión vigente distinta de la evaluada invalida el plan', () => {
  const accepted = version(92706, [line(1, 'A', 1)])
  const evaluated = version(92714, [line(1, 'A', 1)])
  const comparison = compareCommercialVersions(accepted, evaluated)
  const changedAgain = version(92718, [line(1, 'A', 2)])
  const result = plan({ acceptedVersion: accepted, currentVersion: changedAgain, comparison, oldLines: accepted.lines, newLines: changedAgain.lines })
  assert.equal(result.status, 'AMBIGUOUS')
  assert.equal(result.conflicts[0].reason, 'CURRENT_VERSION_CHANGED')
})

test('unavailable vigente devuelve UNAVAILABLE', () => {
  const result = plan({ currentVersion: null, comparison: null })
  assert.equal(result.status, 'UNAVAILABLE')
})

test('ejecuciones repetidas son deterministas', () => {
  const input = { oldLines: baseOld, newLines: [...baseOld, line(4, 'D', 1)], preparationLines: baseOld.map((item, index) => prep(`line-${index}`, item, item.quantity)) }
  assert.deepEqual(plan(input), plan(input))
})

test('NV 5148 (92753 -> 92799): WG85765 de 3 a 2 y ajuste comercial en USA651 produce READY sin conflictos y totalDelta -1750', () => {
  const nv5148Identity = {
    canonicalToken: '2f2ce3af5035',
    historicalBsaleId: 92753,
    currentBsaleId: 92799,
    folio: '5148',
  }
  const unchangedLines92753 = [
    line(2000, '70501', 3, {
      detailId: 336245,
      unitNetValue: 4896,
      lineNetAmount: 14689,
      lineTaxAmount: 2791,
      lineGrossAmount: 17480,
    }),
    ...Array.from({ length: 11 }, (_, idx) => line(2001 + idx, `L${String(idx + 2).padStart(2, '0')}`, 2, {
      detailId: 336252 + idx,
      unitNetValue: 6000,
      lineNetAmount: 12000,
      lineTaxAmount: 2280,
      lineGrossAmount: 14280,
    })),
    line(2012, 'L13', 1, {
      detailId: 336263,
      unitNetValue: 18893,
      lineNetAmount: 18893,
      lineTaxAmount: 3590,
      lineGrossAmount: 22481,
    }),
  ]
  const unchangedLines92799 = unchangedLines92753.map((item, idx) => ({
    ...item,
    detailId: 336480 + idx,
  }))
  const oldLines = [
    ...unchangedLines92753,
    line(5777, 'USA651', 5, {
      detailId: 336251,
      unitNetValue: 16419,
      lineNetAmount: 82097,
      lineTaxAmount: 15598,
      lineGrossAmount: 97698,
    }),
    line(6839, 'WG85765', 3, {
      detailId: 336247,
      unitNetValue: 1470,
      lineNetAmount: 4409,
      lineTaxAmount: 838,
      lineGrossAmount: 5246,
    }),
  ]
  const newLines = [
    ...unchangedLines92799,
    line(5777, 'USA651', 5, {
      detailId: 336475,
      unitNetValue: 16419,
      lineNetAmount: 82097,
      lineTaxAmount: 15598,
      lineGrossAmount: 97697,
    }),
    line(6839, 'WG85765', 2, {
      detailId: 336471,
      unitNetValue: 1470,
      lineNetAmount: 2939,
      lineTaxAmount: 558,
      lineGrossAmount: 3497,
    }),
  ]
  const acceptedVersion = {
    ...version(92753, oldLines, nv5148Identity.canonicalToken),
    identity: nv5148Identity,
  }
  const currentVersion = {
    ...version(92799, newLines, nv5148Identity.canonicalToken),
    identity: nv5148Identity,
  }
  assert.equal(acceptedVersion.netAmount, 252088)
  assert.equal(acceptedVersion.taxAmount, 47897)
  assert.equal(acceptedVersion.totalAmount, 299985)
  assert.equal(currentVersion.netAmount, 250618)
  assert.equal(currentVersion.taxAmount, 47617)
  assert.equal(currentVersion.totalAmount, 298235)

  const comparison = compareCommercialVersions(acceptedVersion, currentVersion)
  const preparationLines = oldLines.map((item, idx) => prep(`line-5148-${idx}`, item, item.quantity, null, 'PENDING', false))
  const result = buildPreparationCommercialReconciliationPlan({
    card: { cardId: '6b6214e6-281b-4fde-92d9-4f90ff3e2098', companyId: 'company-mym', status: 'IN_PREPARATION' },
    identity: nv5148Identity,
    acceptedVersion,
    currentVersion,
    preparationLines,
    incidents: [],
    comparison,
    snapshotComplete: true,
  })

  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.impact.quantityUpdates, 1)
  assert.equal(result.impact.conflicts, 0)
  assert.equal(result.impact.totalDelta, -1750)
  assert.equal(result.actions.filter(a => a.kind === 'KEEP').length, 14)
  const wgAction = result.actions.find(a => a.kind === 'UPDATE_QUANTITY')
  assert.ok(wgAction)
  assert.equal(wgAction.previousRequestedQuantity, 3)
  assert.equal(wgAction.newRequestedQuantity, 2)
  assert.equal(wgAction.quantityDelta, -1)
  const usaAction = result.actions.find(a => a.kind === 'KEEP' && a.current?.sku === 'USA651')
  assert.ok(usaAction)
  assert.equal(usaAction.newRequestedQuantity, 5)
  assert.equal(result.differences.some(d => d.kind === 'VALUE_CHANGED' && d.current?.sku === 'USA651'), true)
})

test('cambio solo de precio produce KEEP, conserva preparación e historial trazable', () => {
  const oldItem = line(10, 'SKU-PRECIO', 4, { unitNetValue: 1000, lineNetAmount: 4000, lineTaxAmount: 760, lineGrossAmount: 4760 })
  const newItem = line(10, 'SKU-PRECIO', 4, { unitNetValue: 2500, lineNetAmount: 10000, lineTaxAmount: 1900, lineGrossAmount: 11900 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-precio', oldItem, 4, 3, 'CONFIRMED')],
  })
  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.actions.length, 1)
  assert.equal(result.actions[0].kind, 'KEEP')
  assert.equal(result.actions[0].preparationLineId, 'line-precio')
  assert.equal(result.actions[0].preparedQuantity, 3)
  assert.equal(result.actions[0].newRequestedQuantity, 4)
  assert.equal(result.impact.totalDelta, 7140)
  assert.notEqual(result.acceptedFingerprint, result.currentFingerprint)
  assert.equal(result.differences.length, 1)
  assert.equal(result.differences[0].kind, 'VALUE_CHANGED')
})

test('cambio solo de descuento produce KEEP y conserva estado operativo', () => {
  const oldItem = line(11, 'SKU-DESC', 2, { unitNetValue: 5000, lineNetAmount: 10000, lineTaxAmount: 1900, lineGrossAmount: 11900 })
  const newItem = line(11, 'SKU-DESC', 2, { unitNetValue: 5000, lineNetAmount: 8000, lineTaxAmount: 1520, lineGrossAmount: 9520 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-desc', oldItem, 2, 2, 'CONFIRMED')],
  })
  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.actions[0].kind, 'KEEP')
  assert.equal(result.actions[0].preparedQuantity, 2)
  assert.equal(result.impact.totalDelta, -2380)
})

test('cambio solo de impuesto produce KEEP sin bloquear', () => {
  const oldItem = line(12, 'SKU-TAX', 3, { unitNetValue: 2000, lineNetAmount: 6000, lineTaxAmount: 1140, lineGrossAmount: 7140 })
  const newItem = line(12, 'SKU-TAX', 3, { unitNetValue: 2000, lineNetAmount: 6000, lineTaxAmount: 1200, lineGrossAmount: 7200 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-tax', oldItem, 3, 1, 'CONFIRMED')],
  })
  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.actions[0].kind, 'KEEP')
  assert.equal(result.actions[0].preparedQuantity, 1)
  assert.equal(result.impact.totalDelta, 60)
})

test('cambio simultáneo de cantidad y precio seguro produce un único UPDATE_QUANTITY sin conflicto comercial', () => {
  const oldItem = line(13, 'SKU-COMBO', 5, { unitNetValue: 1000, lineNetAmount: 5000, lineTaxAmount: 950, lineGrossAmount: 5950 })
  const newItem = line(13, 'SKU-COMBO', 3, { unitNetValue: 1400, lineNetAmount: 4200, lineTaxAmount: 798, lineGrossAmount: 4998 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-combo', oldItem, 5, 2, 'CONFIRMED')],
  })
  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.actions.length, 1)
  assert.equal(result.actions[0].kind, 'UPDATE_QUANTITY')
  assert.equal(result.actions[0].previousRequestedQuantity, 5)
  assert.equal(result.actions[0].newRequestedQuantity, 3)
  assert.equal(result.actions[0].preparedQuantity, 2)
  assert.equal(result.differences.length, 2)
})

test('cambio simultáneo de cantidad inferior a lo preparado y precio bloquea únicamente por QUANTITY_BELOW_PREPARED', () => {
  const oldItem = line(14, 'SKU-COMBO-BLOCK', 5, { unitNetValue: 1000, lineNetAmount: 5000, lineTaxAmount: 950, lineGrossAmount: 5950 })
  const newItem = line(14, 'SKU-COMBO-BLOCK', 2, { unitNetValue: 1500, lineNetAmount: 3000, lineTaxAmount: 570, lineGrossAmount: 3570 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-combo-block', oldItem, 5, 4, 'CONFIRMED')],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'QUANTITY_BELOW_PREPARED')
})

test('sustitución posicional de producto bloquea con COMMERCIAL_SUBSTITUTION', () => {
  const oldItem = line(20, 'SKU-ORIGINAL', 2, { lineNumber: 1 })
  const newItem = line(21, 'SKU-SUSTITUTO', 2, { lineNumber: 1 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-sub', oldItem, 2)],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'COMMERCIAL_SUBSTITUTION')
})

test('cambio de SKU sobre la misma variante bloquea por identidad de producto no equivalente', () => {
  const oldItem = line(30, 'SKU-ANTIGUO', 2, { unitNetValue: 1000, lineNetAmount: 2000, lineTaxAmount: 380, lineGrossAmount: 2380 })
  const newItem = line(30, 'SKU-NUEVO', 2, { unitNetValue: 1000, lineNetAmount: 2000, lineTaxAmount: 380, lineGrossAmount: 2380 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-sku-mismatch', oldItem, 2)],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'COMMERCIAL_SUBSTITUTION')
})

test('línea sin variante ni SKU identificable con cambio de valor bloquea', () => {
  const oldItem = line(null, null, 1, { detailId: 901, productName: 'Glosa libre', unitNetValue: 1000, lineNetAmount: 1000, lineTaxAmount: 190, lineGrossAmount: 1190 })
  const newItem = line(null, null, 1, { detailId: 901, productName: 'Glosa libre', unitNetValue: 2000, lineNetAmount: 2000, lineTaxAmount: 380, lineGrossAmount: 2380 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-unkeyed', oldItem, 1)],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'UNKEYED_COMMERCIAL_LINE')
})
