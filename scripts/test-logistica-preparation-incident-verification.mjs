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

/**
 * Simulación JavaScript de la función PostgreSQL:
 * logistica.verify_open_preparation_incidents_v1
 *
 * NOTA: Esta función es una simulación unitaria en Node.js que modela el
 * comportamiento del query SQL, no una ejecución directa sobre PostgreSQL.
 */
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
    canonicalIdentityMatched = true,
    cardId = 'card-1',
    companyId = 'company-1'
  } = metadata

  const getProductKey = (line) => {
    const sku = (line.sku ?? line.variantCode)?.trim()
    if (sku) return `SKU:${sku.toUpperCase()}`
    if (line.variantId != null) return `VARIANT:${line.variantId}`
    if (line.bsaleVariantId != null) return `VARIANT:${line.bsaleVariantId}`
    return null
  }

  // 1. Prepared lines analysis (prepared_raw / prepared_keys)
  // Only non-retired lines belong to the active preparation snapshot
  const activePreparedLines = preparedLines.filter(line =>
    line.retiredAt == null &&
    (line.cardId ?? cardId) === cardId &&
    (line.companyId ?? companyId) === companyId
  )

  const preparedKeys = new Map()
  let duplicatePreparedKey = false
  let invalidPreparedKey = false
  for (const line of activePreparedLines) {
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

  // 2. Current Bsale document details analysis (current_raw / current_keys)
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

  // 3. Full card comparison (key_comparison / card_comparison)
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
    activePreparedLines.length > 0 &&
    !quantityMismatch

  // 4. Incident evaluation with strict physical line linkage
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
    const incCardId = incident.cardId ?? cardId
    const incCompanyId = incident.companyId ?? companyId

    // Find linked physical line
    // Link requires exact match on id, card_id, company_id, and active status (retired_at IS NULL)
    const targetLineId = incident.preparationLineId !== undefined
      ? incident.preparationLineId
      : (activePreparedLines.length === 1 ? activePreparedLines[0].id : null)

    const linkedLine = activePreparedLines.find(line =>
      line.id === targetLineId &&
      (line.cardId ?? cardId) === incCardId &&
      (line.companyId ?? companyId) === incCompanyId &&
      line.retiredAt == null
    )

    const physicalProductKey = linkedLine ? getProductKey(linkedLine) : null
    const physicalPreparedQuantity = linkedLine ? linkedLine.preparedQuantity : null

    // Link validity check:
    // 1. Line exists, belongs to same card & company, and is not retired
    // 2. Line has a valid product key
    // 3. If incident specifies SKU, it must match physical line's SKU
    // 4. If incident specifies variantId, it must match physical line's variantId
    const lineLinkValid = Boolean(
      linkedLine != null &&
      linkedLine.retiredAt == null &&
      physicalProductKey != null &&
      (incident.sku ? (linkedLine.sku?.trim().toUpperCase() === incident.sku.trim().toUpperCase()) : true) &&
      (incident.variantId != null ? ((linkedLine.variantId ?? linkedLine.bsaleVariantId) === incident.variantId) : true)
    )

    const ck = physicalProductKey
      ? (currentKeys.get(physicalProductKey) ?? { lineCount: 0, quantity: 0 })
      : { lineCount: 0, quantity: 0 }

    const isSetQuantity = incident.requiredBsaleAction === 'SET_QUANTITY'
    const isRemoveLine = incident.requiredBsaleAction === 'REMOVE_LINE'

    const incidentActionMatched = Boolean(
      lineLinkValid &&
      physicalProductKey != null &&
      (
        (isSetQuantity &&
          ck.lineCount === 1 &&
          ck.quantity === incident.expectedBsaleQuantity &&
          physicalPreparedQuantity != null &&
          ck.quantity === physicalPreparedQuantity) ||
        (isRemoveLine &&
          (ck.lineCount === 0 || (ck.lineCount === 1 && ck.quantity <= 0)) &&
          physicalPreparedQuantity != null &&
          physicalPreparedQuantity === 0 &&
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
        preparationLineId: targetLineId,
        matchedPreparationLineId: linkedLine?.id ?? null,
        lineLinkValid,
        incidentProductKey: physicalProductKey,
        bsaleObservedQuantity: bsaleObservedQty,
        physicallyPreparedQuantity: physicalPreparedQuantity,
        fullCardMatched,
        incidentActionMatched,
        verificationBasis: 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'
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

test('la migración forward-only 20261104120000 valida estrictamente el vínculo con la línea física activa', () => {
  assert.match(migrationForward, /CREATE OR REPLACE FUNCTION logistica\.verify_open_preparation_incidents_v1\(/)
  assert.match(migrationForward, /SET_QUANTITY/)
  assert.match(migrationForward, /REMOVE_LINE/)
  assert.match(migrationForward, /incident_lines AS/)
  assert.match(migrationForward, /pl\.card_id = s\.card_id/)
  assert.match(migrationForward, /pl\.retired_at IS NULL/)
  assert.match(migrationForward, /line_link_valid/)
  assert.match(migrationForward, /incident_action_matched/)
  assert.match(migrationForward, /full_card_matched/)
  assert.match(migrationForward, /canonical_identity_matched/)
  assert.match(migrationForward, /FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE/)
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
// Escenarios Específicos: Validación de Vínculo entre Incidencia y Línea Física
// =============================================================================

test('Vínculo físico 1: Incidencia vinculada correctamente -> resolución válida', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, true)
  assert.equal(result.incidents[0].observedSnapshot.matchedPreparationLineId, 'line-1')
})

test('Vínculo físico 2: Incidencia con SKU histórico ajeno a la línea vinculada -> permanece abierta', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-CURRENT', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-CURRENT', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
      status: 'OPEN',
      sku: 'SKU-HISTORICAL-WRONG', // SKU ajeno al de la línea vinculada
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
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, false)
})

test('Vínculo físico 3: Incidencia cuyo preparation_line_id pertenece a otra tarjeta -> permanece abierta', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    metadata: { cardId: 'card-1' },
    preparedLines: [
      { id: 'line-card-1', cardId: 'card-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null },
      { id: 'line-card-2', cardId: 'card-2', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }
    ],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      cardId: 'card-1',
      preparationLineId: 'line-card-2', // ID pertenece a card-2, no a card-1
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
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, false)
  assert.equal(result.incidents[0].observedSnapshot.matchedPreparationLineId, null)
})

test('Vínculo físico 4: Incidencia cuya línea física fue retirada (retired_at IS NOT NULL) -> no se resuelve automáticamente', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-retired', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: '2026-11-04T10:00:00Z' },
      { id: 'line-active', sku: 'SKU-OTHER', requestedQuantity: 2, preparedQuantity: 2, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-OTHER', quantity: 2 }
    ],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-retired', // Línea retirada
      status: 'OPEN',
      sku: 'SKU-001',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      requestedQuantity: 5,
      preparedQuantity: 0
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, false)
})

test('Vínculo físico 5: REMOVE_LINE sin línea física correspondiente -> permanece abierta', () => {
  // Bsale ya eliminó el producto, pero la incidencia no tiene línea física válida.
  // La ausencia de línea física no debe interpretarse como cantidad preparada 0.
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-other', sku: 'SKU-OTHER', requestedQuantity: 2, preparedQuantity: 2, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-OTHER', quantity: 2 }
      // SKU-MISSING fue eliminado de Bsale
    ],
    incidents: [{
      id: 'inc-no-line',
      preparationLineId: 'non-existent-line-id', // Sin línea física en la tarjeta
      status: 'OPEN',
      sku: 'SKU-MISSING',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      requestedQuantity: 1,
      preparedQuantity: 0
    }]
  })

  assert.equal(result.summary.resolved, 0)
  assert.equal(result.summary.open, 1)
  assert.equal(result.summary.mismatched, 1)
  assert.equal(result.incidents[0].status, 'OPEN')
  assert.equal(result.incidents[0].verificationStatus, 'MISMATCHED')
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, false)
})

test('Vínculo físico 6: Línea física correcta, cantidad cero y eliminación demostrada en Bsale -> resolución válida', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-active', sku: 'SKU-ACTIVE', requestedQuantity: 2, preparedQuantity: 2, retiredAt: null },
      { id: 'line-removed', sku: 'SKU-REMOVED', requestedQuantity: 1, preparedQuantity: 0, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-ACTIVE', quantity: 2 }
      // SKU-REMOVED eliminado fehacientemente de Bsale
    ],
    incidents: [{
      id: 'inc-rem',
      preparationLineId: 'line-removed',
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
  assert.equal(result.incidents[0].observedSnapshot.lineLinkValid, true)
  assert.equal(result.incidents[0].observedSnapshot.physicallyPreparedQuantity, 0)
  assert.equal(result.incidents[0].bsaleObservedQuantity, 0)
})

test('Vínculo físico 7: Reemisión legítima con nuevo detail_id en Bsale -> no genera bloqueo falso', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-REISSUED', requestedQuantity: 5, preparedQuantity: 3, retiredAt: null }],
    bsaleDetails: [{ detailId: 99999, sku: 'SKU-REISSUED', quantity: 3 }], // detailId cambió tras reemisión/ajuste
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
      bsaleDetailId: 10001, // detailId original histórico
      status: 'OPEN',
      sku: 'SKU-REISSUED',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 3,
      requestedQuantity: 5,
      preparedQuantity: 3
    }]
  })

  assert.equal(result.summary.resolved, 1)
  assert.equal(result.summary.open, 0)
  assert.equal(result.incidents[0].status, 'RESOLVED')
  assert.equal(result.incidents[0].verificationStatus, 'MATCHED')
  assert.equal(result.incidents[0].bsaleObservedQuantity, 3)
})

// =============================================================================
// Regresión de los 10 Escenarios del PR #20
// =============================================================================

test('Escenario 1: Solicitado 5, preparado 4, Bsale 5 -> debe permanecer OPEN', () => {
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 5 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 3 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: 'SKU-001', quantity: 4 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
      { id: 'line-1', sku: 'SKU-ACTIVE', requestedQuantity: 2, preparedQuantity: 2, retiredAt: null },
      { id: 'line-2', sku: 'SKU-REMOVED', requestedQuantity: 1, preparedQuantity: 0, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-ACTIVE', quantity: 2 }
    ],
    incidents: [{
      id: 'inc-2',
      preparationLineId: 'line-2',
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
      { id: 'line-1', sku: 'SKU-ACTIVE', requestedQuantity: 2, preparedQuantity: 2, retiredAt: null },
      { id: 'line-2', sku: 'SKU-REMOVED', requestedQuantity: 1, preparedQuantity: 0, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-ACTIVE', quantity: 2 },
      { detailId: 102, sku: 'SKU-REMOVED', quantity: 0 }
    ],
    incidents: [{
      id: 'inc-2',
      preparationLineId: 'line-2',
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
    preparedLines: [{ id: 'line-1', sku: null, variantId: null, requestedQuantity: 3, preparedQuantity: 3, retiredAt: null }],
    bsaleDetails: [{ detailId: 101, sku: null, variantCode: null, variantId: null, quantity: 3 }],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
    preparedLines: [{ id: 'line-1', sku: 'SKU-DUP', requestedQuantity: 4, preparedQuantity: 4, retiredAt: null }],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-DUP', quantity: 2 },
      { detailId: 102, sku: 'SKU-DUP', quantity: 2 } // Duplicado ambiguo
    ],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [
      { id: 'line-1', sku: 'SKU-MATCHED', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null },
      { id: 'line-2', sku: 'SKU-DISCREPANT', requestedQuantity: 5, preparedQuantity: 2, retiredAt: null }
    ],
    bsaleDetails: [
      { detailId: 101, sku: 'SKU-MATCHED', quantity: 4 },
      { detailId: 102, sku: 'SKU-DISCREPANT', quantity: 5 } // Discrepancia en otra línea
    ],
    incidents: [{
      id: 'inc-1',
      preparationLineId: 'line-1',
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
    preparationLineId: 'line-1',
    status: 'OPEN',
    sku: 'SKU-001',
    requiredBsaleAction: 'SET_QUANTITY',
    expectedBsaleQuantity: 4,
    requestedQuantity: 5,
    preparedQuantity: 4
  }]

  const state = {
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 4, retiredAt: null }],
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

  // Segunda ejecución: la incidencia ya está RESOLVED, scoped incidents la ignora
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
      preparationLineId: 'line-1',
      status: 'RESOLVED',
      sku: 'SKU-001',
      requiredBsaleAction: 'SET_QUANTITY',
      expectedBsaleQuantity: 3,
      verificationStatus: 'MATCHED'
    },
    {
      id: 'inc-hist-2',
      preparationLineId: 'line-2',
      status: 'SUPERSEDED',
      sku: 'SKU-002',
      requiredBsaleAction: 'REMOVE_LINE',
      expectedBsaleQuantity: 0,
      verificationStatus: 'SUPERSEDED'
    }
  ]

  const result = verifyOpenPreparationIncidentsSimulation({
    preparedLines: [{ id: 'line-1', sku: 'SKU-001', requestedQuantity: 5, preparedQuantity: 5, retiredAt: null }],
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
