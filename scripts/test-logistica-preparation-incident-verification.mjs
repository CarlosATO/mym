import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationHistorical = await readFile(
  new URL('../supabase/migrations/20261030100000_logistica_preparation_incident_verification_strict.sql', import.meta.url),
  'utf8'
)

const migrationForward = await readFile(
  new URL('../supabase/migrations/20261104120000_logistica_preparation_incident_verification_action_strict.sql', import.meta.url),
  'utf8'
)

// Legacy card-level comparator from MEJ-01B initial release
function compareLegacy(prepared, current, { syncProven = true } = {}) {
  if (!syncProven) return 'MISMATCHED'
  const key = (line) => line.sku ? `SKU:${line.sku.trim().toUpperCase()}` : line.variantId == null ? null : `VARIANT:${line.variantId}`
  const preparedKeys = new Map()
  const currentKeys = new Map()
  for (const line of prepared) {
    const productKey = key(line)
    const entry = preparedKeys.get(productKey) ?? { count: 0, quantity: 0 }
    entry.count += 1
    entry.quantity += line.preparedQuantity ?? 0
    preparedKeys.set(productKey, entry)
  }
  for (const line of current) {
    const productKey = key(line)
    const entry = currentKeys.get(productKey) ?? { count: 0, quantity: 0 }
    entry.count += 1
    entry.quantity += line.quantity ?? 0
    currentKeys.set(productKey, entry)
  }
  if ([...preparedKeys, ...currentKeys].some(([productKey]) => productKey == null)) return 'MISMATCHED'
  if ([...preparedKeys.values(), ...currentKeys.values()].some(entry => entry.count > 1)) return 'MISMATCHED'
  const keys = new Set([...preparedKeys.keys(), ...currentKeys.keys()])
  for (const productKey of keys) {
    const expected = preparedKeys.get(productKey)?.quantity ?? 0
    const observed = currentKeys.get(productKey)?.quantity ?? 0
    if (expected !== observed) return 'MISMATCHED'
  }
  return 'MATCHED'
}

// Complete simulation of logistica.verify_open_preparation_incidents_v1 (20261104120000)
function verifyOpenPreparationIncidentsSimulation({
  preparedLines = [],
  bsaleDetails = [],
  incidents = [],
  metadata = {}
}) {
  const {
    documentId = 100,
    documentState = 0,
    syncProven = true,
    canonicalIdentityMatched = true
  } = metadata

  const getProductKey = (line) => {
    const sku = (line.sku ?? line.variantCode)?.trim()
    if (sku) return `SKU:${sku.toUpperCase()}`
    if (line.variantId != null) return `VARIANT:${line.variantId}`
    if (line.bsaleVariantId != null) return `VARIANT:${line.bsaleVariantId}`
    return null
  }

  // 1. Prepared lines analysis
  const preparedKeys = new Map()
  let duplicatePreparedKey = false
  let invalidPreparedKey = false
  for (const line of preparedLines) {
    const key = getProductKey(line)
    if (!key || line.preparedQuantity == null) {
      invalidPreparedKey = true
    }
    const entry = preparedKeys.get(key) ?? { lineCount: 0, quantity: 0 }
    entry.lineCount += 1
    entry.quantity += Number(line.preparedQuantity ?? 0)
    if (entry.lineCount > 1) duplicatePreparedKey = true
    preparedKeys.set(key, entry)
  }

  // 2. Current Bsale document details analysis
  const currentKeys = new Map()
  let duplicateCurrentKey = false
  let invalidCurrentKey = false
  for (const det of bsaleDetails) {
    const key = getProductKey(det)
    if (!key || det.quantity == null || det.quantity < 0) {
      invalidCurrentKey = true
    }
    const entry = currentKeys.get(key) ?? { lineCount: 0, quantity: 0 }
    entry.lineCount += 1
    entry.quantity += Number(det.quantity ?? 0)
    if (entry.lineCount > 1) duplicateCurrentKey = true
    currentKeys.set(key, entry)
  }

  // 3. Full card comparison
  const allKeys = new Set([...preparedKeys.keys(), ...currentKeys.keys()].filter(Boolean))
  let quantityMismatch = false
  for (const k of allKeys) {
    const prepQty = preparedKeys.get(k)?.quantity ?? 0
    const curQty = currentKeys.get(k)?.quantity ?? 0
    if (prepQty > 0 || curQty > 0) {
      if (prepQty !== curQty) {
        quantityMismatch = true
      }
    }
  }

  const fullCardMatched =
    documentId != null &&
    documentState === 0 &&
    syncProven &&
    canonicalIdentityMatched &&
    !duplicatePreparedKey &&
    !invalidPreparedKey &&
    !duplicateCurrentKey &&
    !invalidCurrentKey &&
    preparedLines.length > 0 &&
    !quantityMismatch

  // 4. Incident evaluation
  const updatedIncidents = []
  let verified = 0
  let resolved = 0
  let mismatched = 0
  let notFound = 0
  let cancelled = 0

  for (const incident of incidents) {
    // Only OPEN incidents are scoped and processed
    if (incident.status !== 'OPEN') {
      updatedIncidents.push({ ...incident })
      continue
    }

    verified += 1
    const incKey = getProductKey(incident)
    const ck = incKey ? (currentKeys.get(incKey) ?? { lineCount: 0, quantity: 0 }) : { lineCount: 0, quantity: 0 }
    const pk = incKey ? (preparedKeys.get(incKey) ?? { lineCount: 0, quantity: 0 }) : { lineCount: 0, quantity: 0 }

    const isSetQuantity = incident.requiredBsaleAction === 'SET_QUANTITY'
    const isRemoveLine = incident.requiredBsaleAction === 'REMOVE_LINE'

    const incidentActionMatched = Boolean(
      incKey != null && (
        (isSetQuantity &&
          ck.lineCount === 1 &&
          ck.quantity === incident.expectedBsaleQuantity &&
          ck.quantity === pk.quantity) ||
        (isRemoveLine &&
          (ck.lineCount === 0 || (ck.lineCount === 1 && ck.quantity <= 0)) &&
          pk.quantity === 0 &&
          incident.expectedBsaleQuantity <= 0)
      )
    )

    let verificationStatus
    if (documentId == null) {
      verificationStatus = 'NOT_FOUND'
      notFound += 1
    } else if (documentState !== 0) {
      verificationStatus = 'NV_CANCELLED'
      cancelled += 1
    } else if (!canonicalIdentityMatched || !syncProven || !fullCardMatched || !incidentActionMatched) {
      verificationStatus = 'MISMATCHED'
      mismatched += 1
    } else {
      verificationStatus = 'MATCHED'
      resolved += 1
    }

    const bsaleObservedQty = (isRemoveLine && ck.lineCount === 0) ? 0 : ck.quantity

    updatedIncidents.push({
      ...incident,
      status: verificationStatus === 'MATCHED' ? 'RESOLVED' : 'OPEN',
      verificationStatus,
      bsaleObservedQuantity: bsaleObservedQty,
      lastVerifiedAt: new Date().toISOString(),
      observedSnapshot: {
        documentId,
        canonicalIdentityMatched,
        syncProven,
        requiredBsaleAction: incident.requiredBsaleAction,
        expectedBsaleQuantity: incident.expectedBsaleQuantity,
        incidentProductKey: incKey,
        bsaleObservedQuantity: bsaleObservedQty,
        physicallyPreparedQuantity: pk.quantity,
        fullCardMatched,
        verificationBasis: 'FULL_CARD_AND_INCIDENT_ACTION'
      }
    })
  }

  return {
    summary: {
      verified,
      resolved,
      open: mismatched + notFound + cancelled,
      mismatched,
      notFound,
      nvCancelled: cancelled
    },
    incidents: updatedIncidents
  }
}

// -----------------------------------------------------------------------------
// Test suites
// -----------------------------------------------------------------------------

test('la migración histórica 20261030100000 conserva su estructura base intacta', () => {
  assert.match(migrationHistorical, /CREATE OR REPLACE FUNCTION logistica\.verify_open_preparation_incidents_v1\(/)
  assert.match(migrationHistorical, /status = CASE WHEN c\.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END/)
  assert.match(migrationHistorical, /GRANT EXECUTE ON FUNCTION logistica\.verify_open_preparation_incidents_v1\(uuid, bigint\[\]\)\s+TO service_role/)
  assert.doesNotMatch(migrationHistorical, /sales_order_audits|sales_order_audit_incidents|invoice_attempt_prevalidate|begin_sales_order_invoice_submission/)
  assert.doesNotMatch(migrationHistorical, /fetch\(|bsaleWrite|\/documents\.json/)
})

test('la migración forward-only 20261104120000 refuerza la validación estricta de la acción esperada', () => {
  assert.match(migrationForward, /CREATE OR REPLACE FUNCTION logistica\.verify_open_preparation_incidents_v1\(/)
  assert.match(migrationForward, /SET_QUANTITY/)
  assert.match(migrationForward, /REMOVE_LINE/)
  assert.match(migrationForward, /incident_action_matched/)
  assert.match(migrationForward, /full_card_matched/)
  assert.match(migrationForward, /canonical_identity_matched/)
  assert.match(migrationForward, /FULL_CARD_AND_INCIDENT_ACTION/)
  assert.match(migrationForward, /status = CASE WHEN c\.verification_status = 'MATCHED' THEN 'RESOLVED' ELSE 'OPEN' END/)
  assert.match(migrationForward, /GRANT EXECUTE ON FUNCTION logistica\.verify_open_preparation_incidents_v1\(uuid, bigint\[\]\)\s+TO service_role/)
  assert.doesNotMatch(migrationForward, /sales_order_audits|sales_order_audit_incidents|invoice_attempt_prevalidate|begin_sales_order_invoice_submission/)
  assert.doesNotMatch(migrationForward, /UPDATE logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migrationForward, /INSERT INTO logistica\.sales_order_preparation_incidents/)
  assert.doesNotMatch(migrationForward, /INVOICED_READY_FOR_ROUTE/)
  assert.doesNotMatch(migrationForward, /fetch\(|bsaleWrite|\/documents\.json/)
})

test('compatibilidad histórica: línea eliminada con compareLegacy', () => {
  assert.equal(compareLegacy([{ sku: '43165', preparedQuantity: 0 }], []), 'MATCHED')
  assert.equal(compareLegacy([{ sku: '43165', preparedQuantity: 0 }], [{ sku: '43165', quantity: 1 }]), 'MISMATCHED')
})

test('compatibilidad histórica: cantidad reducida y cantidad incorrecta con compareLegacy', () => {
  const prepared = [{ sku: 'A', preparedQuantity: 2 }]
  assert.equal(compareLegacy(prepared, [{ sku: 'A', quantity: 2 }]), 'MATCHED')
  assert.equal(compareLegacy(prepared, [{ sku: 'A', quantity: 3 }]), 'MISMATCHED')
})

test('compatibilidad histórica: claves ambiguas o incompletas con compareLegacy', () => {
  assert.equal(compareLegacy([{ sku: 'A', preparedQuantity: 1 }], [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 0 }]), 'MISMATCHED')
  assert.equal(compareLegacy([{ variantId: 7, preparedQuantity: 1 }], [{ variantId: 7, quantity: 1 }, { variantId: 7, quantity: 1 }]), 'MISMATCHED')
  assert.equal(compareLegacy([{ preparedQuantity: 1 }], [{ quantity: 1 }]), 'MISMATCHED')
})

// =============================================================================
// 10 Escenarios Mandatorios de Regresión
// =============================================================================

test('Escenario 1: Solicitado 5, preparado 4, Bsale 5 -> debe permanecer OPEN', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 5 }],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 4,
      requestedQuantity: 5,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 5)
})

test('Escenario 2: Solicitado 5, preparado 4, Bsale 4, incidencia esperaba 4 -> debe resolver MATCHED / RESOLVED', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 4,
      requestedQuantity: 5,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 1)
  assert.equal(result.summary.open, 0)
  assert.equal(result.incidents[0].status, 'RESOLVED')
  assert.equal(result.incidents[0].verificationStatus, 'MATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 4)
  assert.equal(result.incidents[0].observedSnapshot.fullCardMatched, true)
})

test('Escenario 3: Solicitado 5, preparado 4, Bsale 3 -> debe permanecer OPEN', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 3 }],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 4,
      requestedQuantity: 5,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 3)
})

test('Escenario 4: Solicitado 5, preparado 4, Bsale 4, pero la incidencia esperaba otra cantidad (ej. 3) -> debe permanecer OPEN', () => {
  // En este caso, la tarjeta coincide físicamente (preparado 4, Bsale 4), pero la acción requerida por la incidencia
  // no se cumplió porque la incidencia esperaba 3. Por ende, la incidencia NO debe resolverse.
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 3, // discrepancia contra lo observado (4)
      requestedQuantity: 5,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
})

test('Escenario 5a: Línea excluida y eliminada realmente de Bsale (REMOVE_LINE con línea eliminada de Bsale) -> debe resolver MATCHED / RESOLVED', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-1', sku: 'SKU-ACTIVE', requestedQuantity: 2, preparedQuantity: 2 },
      { id: 'line-2', sku: 'SKU-REMOVED', requestedQuantity: 1, preparedQuantity: 0 }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-ACTIVE', quantity: 2 }
      // SKU-REMOVED fue completamente removido de Bsale
    ],
    incidents: [{
      id: 'inc-2',
      status: 'OPEN',
      sku: 'SKU-REMOVED',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      requestedQuantity: 1,
      preparedQuantity: 0
    }]
  })

  assert.equal(result.summary.resolved, 1)
  assert.equal(result.summary.open, 0)
  assert.equal(result.incidents[0].status, 'RESOLVED')
  assert.equal(result.incidents[0].verificationStatus, 'MATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 0)
})

test('Escenario 5b: Línea excluida y con cantidad 0 en Bsale (REMOVE_LINE con Bsale 0) -> debe resolver MATCHED / RESOLVED', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-1', sku: 'SKU-ACTIVE', requestedQuantity: 2, preparedQuantity: 2 },
      { id: 'line-2', sku: 'SKU-REMOVED', requestedQuantity: 1, preparedQuantity: 0 }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-ACTIVE', quantity: 2 },
      { detailId: 102, sku: 'SKU-REMOVED', quantity: 0 }
    ],
    incidents: [{
      id: 'inc-2',
      status: 'OPEN',
      sku: 'SKU-REMOVED',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      requestedQuantity: 1,
      preparedQuantity: 0
    }]
  })

  assert.equal(result.summary.resolved, 1)
  assert.equal(result.summary.open, 0)
  assert.equal(result.incidents[0].status, 'RESOLVED')
  assert.equal(result.incidents[0].verificationStatus, 'MATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 0)
})

test('Escenario 6: Línea todavía existente pero no identificable (sin SKU ni variante) -> debe permanecer OPEN', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: null, variantId: null, requestedQuantity: 3, preparedQuantity: 3 }],
    bsaleDetails: [{ detailId: 101, sku: null, variantCode: null, variantId: null, quantity: 3 }],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: null,
      variantId: null,
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 3,
      requestedQuantity: 3,
      preparedQuantity: 3
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
})

test('Escenario 7: Productos o variantes ambiguas (mismo identificador duplicado en la NV de Bsale) -> debe permanecer OPEN', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-DUP', requestedQuantity: 4, preparedQuantity: 4 }],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-DUP', quantity: 2 },
      { detailId: 102, sku: 'SKU-DUP', quantity: 2 } // Duplicado ambiguo
    ],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-DUP',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 4,
      requestedQuantity: 4,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
})

test('Escenario 8: Otra línea del pedido con cantidades distintas -> no debe resolver el conjunto (OPEN)', () => {
  // Línea 1 coincide en Bsale e incidencia (4 = 4), pero Línea 2 del pedido tiene discrepancia (preparado 2 vs Bsale 5)
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-1', sku: 'SKU-MATCHED', requestedQuantity: 5, preparedQuantity: 4 },
      { id: 'line-2', sku: 'SKU-DISCREPANT', requestedQuantity: 5, preparedQuantity: 2 }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-MATCHED', quantity: 4 },
      { detailId: 102, sku: 'SKU-DISCREPANT', quantity: 5 } // Discrepancia en otra línea
    ],
    incidents: [{
      id: 'inc-1',
      status: 'OPEN',
      sku: 'SKU-MATCHED',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 4,
      requestedQuantity: 5,
      preparedQuantity: 4
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
})

test('Escenario 9: Repetición de la verificación con Bsale ya coincidente: comportamiento idempotente', () => {
  const initialIncidents = [{
    id: 'inc-1',
    status: 'OPEN',
    sku: 'SKU-001',
    requiredBsaleAction: 'SET_QUANTITY',
    expectedBsaleQuantity: 4,
    requestedQuantity: 5,
    preparedQuantity: 4
  }]

  const state = {
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }]
  }

  // Primera ejecución: resuelve la incidencia
  const firstPass = verifyOpenPreparationIncidentsSimulation({
    ...state,
    incidents: initialIncidents
  })
  assert.equal(firstPass.summary.verified, 1)
  assert.equal(firstPass.summary.resolved, 1)
  assert.equal(firstPass.incidents[0].status, 'RESOLVED')

  // Segunda ejecución: la incidencia ya está RESOLVED, por lo que scoped incidents (status = 'OPEN') la ignora
  const secondPass = verifyOpenPreparationIncidentsSimulation({
    ...state,
    incidents: firstPass.incidents
  })
  assert.equal(secondPass.summary.verified, 0)
  assert.equal(secondPass.summary.resolved, 0)
  assert.equal(secondPass.summary.open, 0)
  assert.equal(secondPass.incidents[0].status, 'RESOLVED')
  assert.equal(secondPass.incidents[0].verificationStatus, 'MATCHED')
})

test('Escenario 10: Incidencias históricas RESOLVED o SUPERSEDED deben permanecer inalteradas', () => {
  const incidents = [
    {
      id: 'inc-hist-1',
      status: 'RESOLVED',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 3,
      verificationStatus: 'MATCHED'
    },
    {
      id: 'inc-hist-2',
      status: 'SUPERSEDED',
      sku: 'SKU-002',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      verificationStatus: 'SUPERSEDED'
    }
  ]

  // Incluso con un Bsale que no coincide con las cantidades históricas
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 5 }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 99 }],
    incidents
  })

  assert.equal(result.summary.verified, 0)
  assert.equal(result.summary.resolved, 0)
  assert.equal(result.incidents[0].status, 'RESOLVED')
  assert.equal(result.incidents[0].verificationStatus, 'MATCHED')
  assert.equal(result.incidents[1].status, 'SUPERSEDED')
  assert.equal(result.incidents[1].verificationStatus, 'SUPERSEDED')
})
