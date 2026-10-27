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
