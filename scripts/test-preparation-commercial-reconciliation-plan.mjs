import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PREPARATION_RECONCILIATION_INCIDENT_SELECT,
  buildPreparationCommercialReconciliationPlan,
  mapPersistedIncidentToReconciliationIncident,
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

function buildValidMej01bSnapshot(overrides = {}) {
  return {
    historical_nv_id: 92706,
    current_nv_id: 92714,
    document_id: 92714,
    document_state: 0,
    canonical_identity_matched: true,
    sync_proven: true,
    line_link_valid: true,
    full_card_matched: true,
    incident_action_matched: true,
    required_bsale_action: 'SET_QUANTITY',
    expected_bsale_quantity: 4,
    bsale_observed_quantity: 4,
    physically_prepared_quantity: 4,
    preparation_line_id: 'line-red',
    matched_preparation_line_id: 'line-red',
    verification_basis: 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE',
    ...overrides,
  }
}

test('MEJ-01 Bloque 1 — Escenario 1: reducción válida (Original 5, Preparado 4, Bsale 4, incidencia RESOLVED/MATCHED) produce UPDATE_QUANTITY', () => {
  const oldItem = line(501, 'SKU-RED', 5, { detailId: 4001 })
  const newItem = line(501, 'SKU-RED', 4, { detailId: 4002 })
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-resolved-1',
        preparation_line_id: 'line-red',
        company_id: card.companyId,
        card_id: card.cardId,
        bsale_variant_id: 501,
        sku: 'SKU-RED',
        requested_quantity: 5,
        prepared_quantity: 4,
        incident_type: 'QUANTITY_REDUCTION',
        required_bsale_action: 'SET_QUANTITY',
        expected_bsale_quantity: 4,
        bsale_observed_quantity: 4,
        status: 'RESOLVED',
        verification_status: 'MATCHED',
        bsale_observed_snapshot: buildValidMej01bSnapshot(),
      },
    ],
  })
  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.actions.length, 1)
  assert.equal(result.actions[0].kind, 'UPDATE_QUANTITY')
  assert.equal(result.actions[0].preparationLineId, 'line-red')
  assert.equal(result.actions[0].previousRequestedQuantity, 5)
  assert.equal(result.actions[0].newRequestedQuantity, 4)
  assert.equal(result.actions[0].preparedQuantity, 4)
  assert.equal(result.actions[0].quantityDelta, -1)
  assert.deepEqual(result.actions[0].incidentIds, ['inc-resolved-1'])
})

test('MEJ-01 Bloque 1 — Escenario 2: incidencia abierta (Original 5, Preparado 4, Bsale 4, incidencia OPEN) bloquea aceptación', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 4)
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-open-1',
        preparation_line_id: 'line-red',
        incident_type: 'QUANTITY_REDUCTION',
        required_bsale_action: 'SET_QUANTITY',
        expected_bsale_quantity: 4,
        status: 'OPEN',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
  assert.deepEqual(result.conflicts[0].incidentIds, ['inc-open-1'])
})

test('MEJ-01 Bloque 1 — Escenario 3: cantidad en Bsale inferior a lo preparado (Preparado 4, Bsale 3) bloquea incluso con incidencia RESOLVED', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 3)
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-resolved-1',
        preparation_line_id: 'line-red',
        incident_type: 'QUANTITY_REDUCTION',
        required_bsale_action: 'SET_QUANTITY',
        expected_bsale_quantity: 4,
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'QUANTITY_BELOW_PREPARED')
})

test('MEJ-01 Bloque 1 — Escenario 4: incidencia SUPERSEDED sin prueba vigente RESOLVED bloquea la reducción', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 4)
  const result = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-superseded-1',
        preparation_line_id: 'line-red',
        incident_type: 'QUANTITY_REDUCTION',
        required_bsale_action: 'SET_QUANTITY',
        expected_bsale_quantity: 4,
        status: 'SUPERSEDED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(result.status, 'REQUIRES_RESOLUTION')
  assert.equal(result.canAcceptCompletely, false)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
  assert.deepEqual(result.conflicts[0].incidentIds, ['inc-superseded-1'])
})

test('MEJ-01 Bloque 1 — Escenario 5: versión desactualizada frente a la verificada en la incidencia o en la comparación bloquea', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 4)
  const mismatchSnapshotPlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-stale-snapshot',
        preparation_line_id: 'line-red',
        incident_type: 'QUANTITY_REDUCTION',
        required_bsale_action: 'SET_QUANTITY',
        expected_bsale_quantity: 4,
        status: 'RESOLVED',
        verification_status: 'MATCHED',
        bsale_observed_snapshot: { physicalId: 92710 },
      },
    ],
  })
  assert.equal(mismatchSnapshotPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(mismatchSnapshotPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
})

test('MEJ-01 Bloque 1 — Escenario 6: identidad incorrecta (incidencia de otra línea, otro producto, otra empresa o tarjeta) bloquea', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 4)

  // Caso A: incidencia pertenece a otra línea de preparación
  const otherLinePlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-other-line',
        preparation_line_id: 'other-line-id',
        incident_type: 'QUANTITY_REDUCTION',
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(otherLinePlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(otherLinePlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')

  // Caso B: incidencia tiene otro producto (variant_id distinto)
  const otherProductPlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-other-variant',
        preparation_line_id: 'line-red',
        bsale_variant_id: 999,
        sku: 'SKU-RED',
        incident_type: 'QUANTITY_REDUCTION',
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(otherProductPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(otherProductPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')

  // Caso C: incidencia pertenece a otra empresa o tarjeta
  const otherTenantPlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [
      {
        id: 'inc-other-company',
        preparation_line_id: 'line-red',
        company_id: 'other-company',
        card_id: card.cardId,
        incident_type: 'QUANTITY_REDUCTION',
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(otherTenantPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(otherTenantPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
})

test('MEJ-01 Bloque 1 — Escenario 8: tarjeta en IN_AUDIT o AUDITED bloquea con NOT_APPLICABLE', () => {
  const oldItem = line(501, 'SKU-RED', 5)
  const newItem = line(501, 'SKU-RED', 4)
  for (const invalidStatus of ['IN_AUDIT', 'AUDITED']) {
    const result = plan({
      status: invalidStatus,
      oldLines: [oldItem],
      newLines: [newItem],
      preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
      incidents: [
        {
          id: 'inc-resolved-1',
          preparation_line_id: 'line-red',
          incident_type: 'QUANTITY_REDUCTION',
          status: 'RESOLVED',
          verification_status: 'MATCHED',
        },
      ],
    })
    assert.equal(result.status, 'NOT_APPLICABLE')
    assert.equal(result.canAcceptCompletely, false)
    assert.deepEqual(result.actions, [])
  }
})

test('MEJ-01 Bloque 1 — Escenario 12: producto excluido (prepared_quantity = 0 y excluded_from_dispatch = true) permanece bloqueado', () => {
  const oldItem = line(501, 'SKU-EXCL', 5)
  const newItemReduced = line(501, 'SKU-EXCL', 4)
  const reducedPlan = plan({
    oldLines: [oldItem],
    newLines: [newItemReduced],
    preparationLines: [prep('line-excl', oldItem, 5, 0, 'INCIDENT', true)],
    incidents: [
      {
        id: 'inc-excl-1',
        preparation_line_id: 'line-excl',
        incident_type: 'LINE_EXCLUDED',
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(reducedPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(reducedPlan.canAcceptCompletely, false)
  assert.equal(reducedPlan.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')

  const removedPlan = plan({
    oldLines: [oldItem],
    newLines: [],
    preparationLines: [prep('line-excl', oldItem, 5, 0, 'INCIDENT', true)],
    incidents: [
      {
        id: 'inc-excl-1',
        preparation_line_id: 'line-excl',
        incident_type: 'LINE_EXCLUDED',
        status: 'RESOLVED',
        verification_status: 'MATCHED',
      },
    ],
  })
  assert.equal(removedPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(removedPlan.canAcceptCompletely, false)
  assert.equal(removedPlan.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
})

test('MEJ-01 PR #22 fix: ausencia de cualquier campo de evidencia o proyección parcial bloquea sin asumir valores por defecto', () => {
  const oldItem = line(501, 'SKU-RED', 5, { detailId: 4001 })
  const newItem = line(501, 'SKU-RED', 4, { detailId: 4002 })
  const fullPersistedIncidentRow = {
    id: 'inc-resolved-full',
    company_id: card.companyId,
    card_id: card.cardId,
    preparation_line_id: 'line-red',
    status: 'RESOLVED',
    incident_type: 'QUANTITY_REDUCTION',
    required_bsale_action: 'SET_QUANTITY',
    requested_quantity: 5,
    prepared_quantity: 4,
    expected_bsale_quantity: 4,
    verification_status: 'MATCHED',
    bsale_observed_quantity: 4,
    bsale_variant_id: 501,
    sku: 'SKU-RED',
    bsale_observed_snapshot: buildValidMej01bSnapshot(),
  }

  // Proyección real con PREPARATION_RECONCILIATION_INCIDENT_SELECT produce READY
  const selectedColumns = PREPARATION_RECONCILIATION_INCIDENT_SELECT.split(',').map(col => col.trim())
  const selectFromRow = (row, cols) => Object.fromEntries(cols.map(col => [col, row[col]]))
  const validMappedIncident = mapPersistedIncidentToReconciliationIncident(
    selectFromRow(fullPersistedIncidentRow, selectedColumns),
  )
  const validPlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [validMappedIncident],
  })
  assert.equal(validPlan.status, 'READY')
  assert.equal(validPlan.canAcceptCompletely, true)

  // La proyección truncada antigua ('id, preparation_line_id, status, incident_type') debe bloquearse
  const legacyTruncatedIncident = mapPersistedIncidentToReconciliationIncident(
    selectFromRow(fullPersistedIncidentRow, ['id', 'preparation_line_id', 'status', 'incident_type']),
  )
  const truncatedPlan = plan({
    oldLines: [oldItem],
    newLines: [newItem],
    preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
    incidents: [legacyTruncatedIncident],
  })
  assert.equal(truncatedPlan.status, 'REQUIRES_RESOLUTION')
  assert.equal(truncatedPlan.canAcceptCompletely, false)
  assert.equal(truncatedPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')

  // Cada campo obligatorio de evidencia ausente o nulo debe bloquear individualmente (sin fallbacks implícitos)
  const mandatoryEvidenceFields = [
    'company_id',
    'card_id',
    'incident_type',
    'required_bsale_action',
    'requested_quantity',
    'prepared_quantity',
    'expected_bsale_quantity',
    'verification_status',
    'bsale_observed_quantity',
    'bsale_variant_id',
    'sku',
    'bsale_observed_snapshot',
  ]
  for (const missingField of mandatoryEvidenceFields) {
    const incompleteRow = { ...fullPersistedIncidentRow, [missingField]: null }
    const mapped = mapPersistedIncidentToReconciliationIncident(
      selectFromRow(incompleteRow, selectedColumns),
    )
    const blockedPlan = plan({
      oldLines: [oldItem],
      newLines: [newItem],
      preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
      incidents: [mapped],
    })
    assert.equal(
      blockedPlan.status,
      'REQUIRES_RESOLUTION',
      `El campo ausente "${missingField}" debió bloquear el plan comercial`,
    )
    assert.equal(blockedPlan.canAcceptCompletely, false)
    assert.equal(blockedPlan.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS')
  }
})

test('MEJ-01 Protección contra evidencias históricas insuficientes: rechaza snapshots sin contrato completo de MEJ-01B', () => {
  const oldItem = line(501, 'SKU-RED', 5, { detailId: 4001 })
  const newItem = line(501, 'SKU-RED', 4, { detailId: 4002 })
  const buildIncidentWithSnapshot = (snapshot) => ({
    id: 'inc-resolved-1',
    preparation_line_id: 'line-red',
    company_id: card.companyId,
    card_id: card.cardId,
    bsale_variant_id: 501,
    sku: 'SKU-RED',
    requested_quantity: 5,
    prepared_quantity: 4,
    incident_type: 'QUANTITY_REDUCTION',
    required_bsale_action: 'SET_QUANTITY',
    expected_bsale_quantity: 4,
    bsale_observed_quantity: 4,
    status: 'RESOLVED',
    verification_status: 'MATCHED',
    bsale_observed_snapshot: snapshot,
  })
  const assertSnapshotBlocked = (snapshot, description) => {
    const result = plan({
      oldLines: [oldItem],
      newLines: [newItem],
      preparationLines: [prep('line-red', oldItem, 5, 4, 'INCIDENT', false)],
      incidents: [buildIncidentWithSnapshot(snapshot)],
    })
    assert.equal(result.status, 'REQUIRES_RESOLUTION', description)
    assert.equal(result.canAcceptCompletely, false, description)
    assert.equal(result.conflicts[0].reason, 'OPERATIONAL_INCIDENT_EXISTS', description)
  }

  // 1. Snapshot con solo document_id -> bloqueado
  assertSnapshotBlocked({ document_id: 92714 }, 'Snapshot con solo document_id debe bloquearse')

  // 2. verification_basis histórico, incorrecto o ausente -> bloqueado
  for (const invalidBasis of [undefined, null, '', 'LEGACY_V1', 'FULL_CARD_ONLY']) {
    const snap = buildValidMej01bSnapshot({ verification_basis: invalidBasis })
    if (invalidBasis === undefined) delete snap.verification_basis
    assertSnapshotBlocked(snap, `verification_basis=${String(invalidBasis)} debe bloquearse`)
  }

  // 3. Cualquiera de los indicadores obligatorios ausente, null o false -> bloqueado
  const requiredBooleanFlags = [
    'canonical_identity_matched',
    'sync_proven',
    'line_link_valid',
    'full_card_matched',
    'incident_action_matched',
  ]
  for (const flag of requiredBooleanFlags) {
    for (const badVal of [undefined, null, false, 'true', 1]) {
      const snap = buildValidMej01bSnapshot({ [flag]: badVal })
      if (badVal === undefined) delete snap[flag]
      assertSnapshotBlocked(snap, `Indicador ${flag}=${String(badVal)} debe bloquearse`)
    }
  }

  for (const badDocState of [undefined, null, 1, '0', false]) {
    const snap = buildValidMej01bSnapshot({ document_state: badDocState })
    if (badDocState === undefined) delete snap.document_state
    assertSnapshotBlocked(snap, `document_state=${String(badDocState)} debe bloquearse`)
  }

  for (const badAction of [undefined, null, '', 'REMOVE_LINE']) {
    const snap = buildValidMej01bSnapshot({ required_bsale_action: badAction })
    if (badAction === undefined) delete snap.required_bsale_action
    assertSnapshotBlocked(snap, `required_bsale_action=${String(badAction)} debe bloquearse`)
  }

  // 4. Identidad de línea física incorrecta o ausente en snapshot -> bloqueado
  for (const lineField of ['preparation_line_id', 'matched_preparation_line_id']) {
    for (const badLineId of [undefined, null, '', 'other-line-id']) {
      const snap = buildValidMej01bSnapshot({ [lineField]: badLineId })
      if (badLineId === undefined) delete snap[lineField]
      assertSnapshotBlocked(snap, `${lineField}=${String(badLineId)} debe bloquearse`)
    }
  }

  // 5. Cantidades de snapshot ausentes, nulas o diferentes a las observadas/preparadas -> bloqueado
  for (const qtyField of ['expected_bsale_quantity', 'bsale_observed_quantity', 'physically_prepared_quantity']) {
    for (const badQty of [undefined, null, 3, 5, '4']) {
      const snap = buildValidMej01bSnapshot({ [qtyField]: badQty })
      if (badQty === undefined) delete snap[qtyField]
      assertSnapshotBlocked(snap, `${qtyField}=${String(badQty)} debe bloquearse`)
    }
  }

  // 6. Identificadores físicos ausentes o contradictorios -> bloqueado
  for (const idField of ['document_id', 'current_nv_id']) {
    for (const badId of [undefined, null, 92706, '92714', 0, -1]) {
      const snap = buildValidMej01bSnapshot({ [idField]: badId })
      if (badId === undefined) delete snap[idField]
      assertSnapshotBlocked(snap, `${idField}=${String(badId)} debe bloquearse`)
    }
  }
  assertSnapshotBlocked(
    buildValidMej01bSnapshot({ physicalId: 92706 }),
    'physicalId contradictorio con document_id/current_nv_id debe bloquearse',
  )
  assertSnapshotBlocked(
    buildValidMej01bSnapshot({ nv_id: null }),
    'nv_id explícitamente null debe bloquearse',
  )
})

function buildValidMej01bExclusionSnapshot(overrides = {}) {
  return {
    historical_nv_id: 92706,
    current_nv_id: 92714,
    document_id: 92714,
    document_state: 0,
    canonical_identity_matched: true,
    sync_proven: true,
    line_link_valid: true,
    full_card_matched: true,
    incident_action_matched: true,
    required_bsale_action: 'REMOVE_LINE',
    expected_bsale_quantity: 0,
    bsale_observed_quantity: 0,
    physically_prepared_quantity: 0,
    preparation_line_id: 'line-excl',
    matched_preparation_line_id: 'line-excl',
    verification_basis: 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE',
    ...overrides,
  }
}

function buildValidResolvedExclusionIncident(overrides = {}) {
  return {
    id: 'inc-excl-resolved-1',
    preparation_line_id: 'line-excl',
    company_id: card.companyId,
    card_id: card.cardId,
    bsale_variant_id: 601,
    sku: 'SKU-EXCL-601',
    requested_quantity: 5,
    prepared_quantity: 0,
    incident_type: 'LINE_EXCLUDED',
    required_bsale_action: 'REMOVE_LINE',
    expected_bsale_quantity: 0,
    bsale_observed_quantity: 0,
    status: 'RESOLVED',
    verification_status: 'MATCHED',
    bsale_observed_snapshot: buildValidMej01bExclusionSnapshot(),
    ...overrides,
  }
}

test('MEJ-01 Exclusión total (V1, V2): línea físicamente excluida con incidencia LINE_EXCLUDED / REMOVE_LINE en RESOLVED/MATCHED y línea activa restante produce REMOVE en estado READY', () => {
  const activeOld = line(101, 'SKU-ACTIVO', 3, { detailId: 5001 })
  const activeNew = line(101, 'SKU-ACTIVO', 3, { detailId: 5011 })
  const excludedOld = line(601, 'SKU-EXCL-601', 5, { detailId: 5002 })

  const result = plan({
    oldLines: [activeOld, excludedOld],
    newLines: [activeNew],
    preparationLines: [
      prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
      prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
    ],
    incidents: [buildValidResolvedExclusionIncident()],
  })

  assert.equal(result.status, 'READY')
  assert.equal(result.canAcceptCompletely, true)
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.impact.removed, 1)
  assert.equal(result.impact.conflicts, 0)

  const keepAct = result.actions.find(a => a.kind === 'KEEP')
  assert.ok(keepAct)
  assert.equal(keepAct.preparationLineId, 'line-active')

  const removeAct = result.actions.find(a => a.kind === 'REMOVE')
  assert.ok(removeAct)
  assert.equal(removeAct.preparationLineId, 'line-excl')
  assert.equal(removeAct.previous?.sku, 'SKU-EXCL-601')
  assert.equal(removeAct.previous?.variantId, 601)
  assert.equal(removeAct.previous?.quantity, 5)
  assert.equal(removeAct.current, null)
  assert.equal(removeAct.previousRequestedQuantity, 5)
  assert.equal(removeAct.newRequestedQuantity, 0)
  assert.equal(removeAct.preparedQuantity, 0)
  assert.equal(removeAct.quantityDelta, -5)
  assert.deepEqual(removeAct.incidentIds, ['inc-excl-resolved-1'])
})

test('MEJ-01 Exclusión total (R1, R2, R3, R4, R5, R6): bloqueos estrictos en el planificador ante incumplimiento de cualquier invariante de REMOVE_LINE', () => {
  const activeOld = line(101, 'SKU-ACTIVO', 3, { detailId: 5001 })
  const activeNew = line(101, 'SKU-ACTIVO', 3, { detailId: 5011 })
  const excludedOld = line(601, 'SKU-EXCL-601', 5, { detailId: 5002 })

  // R1: Incidencia OPEN o SUPERSEDED sin resolución vigente bloquea
  for (const invalidStatus of ['OPEN', 'SUPERSEDED']) {
    const res = plan({
      oldLines: [activeOld, excludedOld],
      newLines: [activeNew],
      preparationLines: [
        prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
        prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
      ],
      incidents: [buildValidResolvedExclusionIncident({ status: invalidStatus })],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R1b: Coexistencia de una incidencia RESOLVED con otra OPEN en la misma línea bloquea
  {
    const res = plan({
      oldLines: [activeOld, excludedOld],
      newLines: [activeNew],
      preparationLines: [
        prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
        prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
      ],
      incidents: [
        buildValidResolvedExclusionIncident({ id: 'inc-1', status: 'RESOLVED' }),
        buildValidResolvedExclusionIncident({ id: 'inc-2', status: 'OPEN' }),
      ],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R2: Incidencia con tipo o acción incorrectos, cantidades no cero, otra identidad o verification_error inválido (PR #25) bloquea
  for (const badOverride of [
    { incident_type: 'QUANTITY_REDUCTION' },
    { required_bsale_action: 'SET_QUANTITY' },
    { verification_status: 'MISMATCHED' },
    { requested_quantity: 4 },
    { prepared_quantity: 1 },
    { expected_bsale_quantity: 1 },
    { bsale_observed_quantity: 1 },
    { bsale_variant_id: 999 },
    { sku: 'OTRO-SKU' },
    { company_id: 'otra-empresa' },
    { card_id: 'otra-card' },
    { bsale_observed_snapshot: null },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ required_bsale_action: 'SET_QUANTITY' }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ expected_bsale_quantity: 1 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ bsale_observed_quantity: 1 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ physically_prepared_quantity: 1 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ document_id: 92706 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ current_nv_id: 92706 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ verification_error: '   ' }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ verification_error: 'ERR' }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ verification_error: 0 }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ verification_error: false }) },
    { bsale_observed_snapshot: buildValidMej01bExclusionSnapshot({ verification_error: {} }) },
  ]) {
    const res = plan({
      oldLines: [activeOld, excludedOld],
      newLines: [activeNew],
      preparationLines: [
        prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
        prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
      ],
      incidents: [buildValidResolvedExclusionIncident(badOverride)],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R3: Preparación parcial mayor que cero (prepared_quantity = 1) bloquea aunque exista incidencia RESOLVED
  {
    const res = plan({
      oldLines: [activeOld, excludedOld],
      newLines: [activeNew],
      preparationLines: [
        prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
        prep('line-excl', excludedOld, 5, 1, 'INCIDENT', true),
      ],
      incidents: [buildValidResolvedExclusionIncident()],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R4: Bsale mantiene la línea con cantidad cero (quantity = 0) en lugar de eliminarla -> bloqueado
  {
    const zeroQtyLine = line(601, 'SKU-EXCL-601', 0, { detailId: 5012 })
    const res = plan({
      oldLines: [activeOld, excludedOld],
      newLines: [activeNew, zeroQtyLine],
      preparationLines: [
        prep('line-active', activeOld, 3, 3, 'CONFIRMED', false),
        prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
      ],
      incidents: [buildValidResolvedExclusionIncident()],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R5: Eliminación de todos los productos del pedido (sin ninguna línea comercial activa restante) -> bloqueado
  {
    const res = plan({
      oldLines: [excludedOld],
      newLines: [],
      preparationLines: [prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true)],
      incidents: [buildValidResolvedExclusionIncident()],
    })
    assert.equal(res.status, 'REQUIRES_RESOLUTION')
    assert.equal(res.canAcceptCompletely, false)
    assert.equal(res.conflicts.length, 1)
    assert.equal(res.conflicts[0].reason, 'PREPARATION_LINE_EXCLUDED')
  }

  // R6 / V4: Nueva incorporación del mismo SKU tras exclusión previa:
  // - Con detailId nuevo sobre línea ya retirada (retired_at != null): planifica ADD limpio sin reutilizar línea retirada
  // - Con detailId repetido (colisión con línea retirada): bloquea con PREPARATION_LINE_AMBIGUOUS
  {
    const retiredExcludedLine = {
      ...prep('line-excl', excludedOld, 5, 0, 'INCIDENT', true),
      bsale_detail_id: 5002,
      retired_at: '2026-11-04T12:00:00.000Z',
    }
    const readdedWithNewDetail = line(601, 'SKU-EXCL-601', 2, { detailId: 6099 })
    const validReaddPlan = plan({
      oldLines: [activeNew],
      newLines: [activeNew, readdedWithNewDetail],
      preparationLines: [
        prep('line-active', activeNew, 3, 3, 'CONFIRMED', false),
        retiredExcludedLine,
      ],
      incidents: [buildValidResolvedExclusionIncident()],
    })
    assert.equal(validReaddPlan.status, 'READY')
    assert.equal(validReaddPlan.canAcceptCompletely, true)
    const addAction = validReaddPlan.actions.find(a => a.kind === 'ADD')
    assert.ok(addAction)
    assert.equal(addAction.preparationLineId, null)
    assert.equal(addAction.current?.detailId, 6099)
    assert.equal(addAction.newRequestedQuantity, 2)

    const readdedWithCollidingDetail = line(601, 'SKU-EXCL-601', 2, { detailId: 5002 })
    const collidingReaddPlan = plan({
      oldLines: [activeNew],
      newLines: [activeNew, readdedWithCollidingDetail],
      preparationLines: [
        prep('line-active', activeNew, 3, 3, 'CONFIRMED', false),
        retiredExcludedLine,
      ],
      incidents: [buildValidResolvedExclusionIncident()],
    })
    assert.equal(collidingReaddPlan.status, 'REQUIRES_RESOLUTION')
    assert.equal(collidingReaddPlan.canAcceptCompletely, false)
    assert.equal(collidingReaddPlan.conflicts[0].reason, 'PREPARATION_LINE_AMBIGUOUS')
  }
})
