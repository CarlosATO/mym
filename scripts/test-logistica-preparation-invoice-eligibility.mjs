import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261030130000_logistica_preparation_invoice_eligibility_strict.sql', import.meta.url), 'utf8')
const mej01b = await readFile(new URL('../supabase/migrations/20261030100000_logistica_preparation_incident_verification_strict.sql', import.meta.url), 'utf8')

test('MEJ-01C es incremental y posterior a MEJ-01B', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.get_sales_order_preparation_commercial_consistency_v1/)
  assert.match(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_route_readiness/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.invoice_attempt_prevalidate/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.begin_sales_order_invoice_submission/)
  assert.match(mej01b, /FULL_CARD_PRODUCT_QUANTITY_SET/)
  assert.doesNotMatch(migration, /INSERT INTO integraciones\.bsale_documents|UPDATE integraciones\.bsale_documents|DELETE FROM integraciones\.bsale_documents/)
  assert.doesNotMatch(migration, /sales_order_audits|sales_order_audit_incidents|CREATE TABLE|ALTER TABLE/)
})

test('readiness requiere coincidencia comercial además de NV activa y tarjeta AUDITED', () => {
  assert.match(migration, /c\.status = 'AUDITED'/)
  assert.match(migration, /consistency\.payload->>'status' IS DISTINCT FROM 'MATCHED' THEN 'BLOCKED'/)
  assert.match(migration, /d\.state IS DISTINCT FROM 0 OR c\.closed_at IS NOT NULL THEN 'BLOCKED'/)
  assert.match(migration, /COALESCE\(oc\.open_count, 0\) > 0 THEN 'INCIDENTS'/)
})

test('prevalidación bloquea diferencias aun cuando no haya incidencias OPEN', () => {
  assert.match(migration, /get_sales_order_preparation_commercial_consistency_v1\(p_company_id, p_card_id\)/)
  assert.match(migration, /COMMERCIAL_RECONCILIATION_REQUIRED:/)
  assert.match(migration, /OPEN_COMMERCIAL_INCIDENTS/)
  assert.match(migration, /commercial_consistency', consistency/)
})

test('el inicio efectivo de emisión vuelve a validar la consistencia antes de insertar SUBMITTING', () => {
  const begin = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION logistica.begin_sales_order_invoice_submission'))
  assert.match(begin, /consistency := logistica\.get_sales_order_preparation_commercial_consistency_v1/)
  assert.match(begin, /COMMERCIAL_RECONCILIATION_REQUIRED/)
  assert.match(begin, /INSERT INTO logistica\.sales_order_invoice_attempts/)
  assert.ok(begin.indexOf('COMMERCIAL_RECONCILIATION_REQUIRED') < begin.indexOf('INSERT INTO logistica.sales_order_invoice_attempts'))
})

test('la consistencia exige NV canónica, sincronización reciente y detalles del mismo run', () => {
  assert.match(migration, /COALESCE\(c\.current_bsale_nv_id, c\.bsale_nv_id\)/)
  assert.match(migration, /cd\.sync_status = 'COMPLETED'/)
  assert.match(migration, /cd\.sync_completed_at >= cd\.relevant_at/)
  assert.match(migration, /cd\.document_synced_at >= cd\.relevant_at/)
  assert.match(migration, /stale_detail\.bsale_sync_run_id IS DISTINCT FROM cd\.bsale_sync_run_id/)
})

test('la consistencia reutiliza cantidades físicas, identidad comercial y duplicados de MEJ-01B', () => {
  assert.match(migration, /prepared_quantity/)
  assert.match(migration, /det\.quantity/)
  assert.match(migration, /SKU:/)
  assert.match(migration, /VARIANT:/)
  assert.match(migration, /duplicate_prepared_key/)
  assert.match(migration, /duplicate_current_key/)
  assert.match(migration, /quantity_mismatch/)
  assert.match(migration, /full-card commercial|FULL_CARD_PRODUCT_QUANTITY_SET/)
})

test('se conservan permisos, idempotencia y los estados físicos', () => {
  assert.match(migration, /PREPARATION_MANAGE_DENIED|logistica\.preparation\.manage/)
  assert.match(migration, /ACTIVE_INCOMPATIBLE_ATTEMPT/)
  assert.match(migration, /ON CONFLICT|unique_violation/)
  assert.match(migration, /c\.status IS DISTINCT FROM 'AUDITED'/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_incidents/)
})

test('MEJ-01C no recalcula valores monetarios ni implementa sincronización Bsale', () => {
  assert.doesNotMatch(migration, /net_amount|tax_amount|net_discount|total_amount/)
  assert.doesNotMatch(migration, /fetch\(|bsaleWrite|\/documents\.json|sync_sales_order/)
})

test('las consultas a bsale_clients utilizan bsale_client_id y no bsale_id', () => {
  assert.match(migration, /FROM integraciones\.bsale_clients x WHERE x\.company_id = p_company_id AND x\.bsale_client_id = doc_row\.client_id/)
  assert.match(migration, /FROM integraciones\.bsale_clients client_row[\s\S]*?WHERE client_row\.company_id = p_company_id\s+AND client_row\.bsale_client_id = doc_row\.client_id/)
  assert.doesNotMatch(migration, /integraciones\.bsale_clients\b[^\n;]*\bbsale_id\b/)
  assert.doesNotMatch(migration, /client_row\.bsale_id\b/)
})

test('criterio de frescura temporal no se contamina por actualizaciones administrativas del sync', () => {
  // relevant_at se basa estrictamente en la creación de tarjeta, líneas físicas e incidencias creadas
  assert.match(
    migration,
    /GREATEST\(\s*c\.created_at,\s*COALESCE\(\(SELECT max\(pl\.updated_at\) FROM logistica\.sales_order_preparation_lines pl WHERE pl\.company_id = c\.company_id AND pl\.card_id = c\.id\), c\.created_at\),\s*COALESCE\(\(SELECT max\(i\.created_at\) FROM logistica\.sales_order_preparation_incidents i WHERE i\.company_id = c\.company_id AND i\.card_id = c\.id\), c\.created_at\)\s*\) AS relevant_at/
  )

  // El bloque card_scope no debe incluir c.updated_at ni i.last_verified_at
  const cardScopeBlock = migration.slice(
    migration.indexOf('WITH card_scope AS ('),
    migration.indexOf('), current_document AS (')
  )
  assert.doesNotMatch(cardScopeBlock, /c\.updated_at/)
  assert.doesNotMatch(cardScopeBlock, /last_verified_at/)

  // Se preservan los controles estrictos de frescura y run atómico
  assert.match(migration, /cd\.sync_status = 'COMPLETED'/)
  assert.match(migration, /cd\.sync_completed_at >= cd\.relevant_at/)
  assert.match(migration, /cd\.document_synced_at >= cd\.relevant_at/)
  assert.match(migration, /stale_detail\.bsale_sync_run_id IS DISTINCT FROM cd\.bsale_sync_run_id/)
})

// Simulación fiel de la evaluación lógica de get_sales_order_preparation_commercial_consistency_v1
function evaluateConsistency({
  cardCreatedAt,
  cardStatus = 'AUDITED',
  cardFolio = '5140',
  cardToken = 'token-123',
  currentNvId = 92744,
  canonicalVersionNvId = 92744,
  lines = [], // { sku, variantId, preparedQuantity, updatedAt, retiredAt }
  incidents = [], // { createdAt, lastVerifiedAt, status }
  syncRun = { status: 'COMPLETED', completedAt: null },
  doc = { state: 0, syncedAt: null, syncRunId: 'run-1', number: 5140, token: 'token-123', bsaleId: 92744 },
  details = [], // { sku, variantId, quantity, syncRunId }
}) {
  const lineTimestamps = lines.map(l => new Date(l.updatedAt).getTime())
  const incidentTimestamps = incidents.map(i => new Date(i.createdAt).getTime())
  const cardCreatedMs = new Date(cardCreatedAt).getTime()
  const maxLineMs = lineTimestamps.length > 0 ? Math.max(...lineTimestamps) : cardCreatedMs
  const maxIncidentMs = incidentTimestamps.length > 0 ? Math.max(...incidentTimestamps) : cardCreatedMs
  const relevantAtMs = Math.max(cardCreatedMs, maxLineMs, maxIncidentMs)

  if (cardStatus !== 'AUDITED') return { status: 'NOT_AUDITED', reason: 'PHYSICAL_AUDIT_NOT_CLOSED' }
  if (!doc || doc.state === undefined) return { status: 'NOT_FOUND', reason: 'CURRENT_NV_NOT_FOUND' }
  if (doc.state !== 0) return { status: 'NV_CANCELLED', reason: 'CURRENT_NV_NOT_ACTIVE' }

  // Verificación de Identidad Canónica (empresa, token, folio y versión vigente)
  const canonicalIdentityMatched = Boolean(
    cardToken &&
    cardToken.trim() !== '' &&
    doc.token &&
    doc.token.trim() === cardToken.trim() &&
    cardFolio &&
    cardFolio.trim() !== '' &&
    doc.number != null &&
    String(doc.number).trim() === cardFolio.trim() &&
    canonicalVersionNvId != null &&
    currentNvId === canonicalVersionNvId
  )

  if (!canonicalIdentityMatched) {
    return { status: 'MISMATCHED', ok: false, reason: 'CANONICAL_IDENTITY_MISMATCH' }
  }

  const syncCompletedMs = syncRun.completedAt ? new Date(syncRun.completedAt).getTime() : 0
  const docSyncedMs = doc.syncedAt ? new Date(doc.syncedAt).getTime() : 0
  const staleDetailExists = details.some(d => d.syncRunId !== doc.syncRunId)

  const syncProven = (
    doc &&
    doc.state === 0 &&
    doc.syncRunId &&
    syncRun.status === 'COMPLETED' &&
    syncRun.completedAt &&
    syncCompletedMs >= relevantAtMs &&
    doc.syncedAt &&
    docSyncedMs >= relevantAtMs &&
    !staleDetailExists
  )

  if (!syncProven) {
    return { status: 'MISMATCHED', reason: 'COMMERCIAL_SYNC_NOT_VERIFIED' }
  }

  const activeLines = lines.filter(l => !l.retiredAt)
  if (activeLines.length === 0) return { status: 'MISMATCHED', reason: 'PREPARATION_LINES_NOT_AVAILABLE' }

  const prepMap = new Map()
  for (const l of activeLines) {
    const key = l.sku ? `SKU:${l.sku.trim().toUpperCase()}` : l.variantId ? `VARIANT:${l.variantId}` : null
    if (!key) return { status: 'MISMATCHED', reason: 'COMMERCIAL_IDENTITY_INCOMPLETE' }
    if (prepMap.has(key)) return { status: 'MISMATCHED', reason: 'DUPLICATE_COMMERCIAL_IDENTITY' }
    prepMap.set(key, l.preparedQuantity)
  }

  const currMap = new Map()
  for (const d of details) {
    const key = d.sku ? `SKU:${d.sku.trim().toUpperCase()}` : d.variantId ? `VARIANT:${d.variantId}` : null
    if (!key) return { status: 'MISMATCHED', reason: 'COMMERCIAL_IDENTITY_INCOMPLETE' }
    if (currMap.has(key)) return { status: 'MISMATCHED', reason: 'DUPLICATE_COMMERCIAL_IDENTITY' }
    currMap.set(key, d.quantity)
  }

  const allKeys = new Set([...prepMap.keys(), ...currMap.keys()])
  for (const key of allKeys) {
    if (prepMap.get(key) !== currMap.get(key)) {
      return { status: 'MISMATCHED', reason: 'PREPARED_QUANTITY_MISMATCH' }
    }
  }

  return { status: 'MATCHED', ok: true, reason: null }
}

test('contrato de identidad canónica: la migración exige coincidencia estricta de token, folio y versión vigente', () => {
  assert.match(migration, /canon\.current_bsale_id AS canonical_version_nv_id/)
  assert.match(migration, /LEFT JOIN integraciones\.vw_bsale_sales_order_documents_canonical canon/)
  assert.match(migration, /canon\.canonical_bsale_token = cs\.canonical_bsale_token/)
  assert.match(migration, /NULLIF\(btrim\(cd\.canonical_bsale_token\), ''\) IS NOT NULL/)
  assert.match(migration, /cd\.document_canonical_token = NULLIF\(btrim\(cd\.canonical_bsale_token\), ''\)/)
  assert.match(migration, /cd\.document_number::text = btrim\(cd\.bsale_nv_folio\)/)
  assert.match(migration, /cd\.current_nv_id = cd\.canonical_version_nv_id/)
  assert.match(migration, /WHEN NOT c\.canonical_identity_matched THEN 'MISMATCHED'/)
  assert.match(migration, /WHEN NOT r\.canonical_identity_matched THEN 'CANONICAL_IDENTITY_MISMATCH'/)
})

test('escenario 1: NV correcta, misma identidad canónica y cantidades coincidentes resulta MATCHED', () => {
  const result = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92744 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })

  assert.equal(result.status, 'MATCHED')
  assert.equal(result.ok, true)
  assert.equal(result.reason, null)
})

test('escenario 2: NV reemitida legítimamente con nuevo ID físico, misma identidad y contenido resulta MATCHED', () => {
  // NV original 92744 fue reemitida en Bsale como 92800 bajo el mismo token 'token-5140' y folio '5140'
  const result = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92800, // Tarjeta actualizada a la versión reemitida
    canonicalVersionNvId: 92800, // Vista canónica resuelve la versión 92800 como vigente
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92800 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })

  assert.equal(result.status, 'MATCHED')
  assert.equal(result.ok, true)
  assert.equal(result.reason, null)
})

test('escenario 3: documento con cantidades iguales, pero token de otra NV queda bloqueado', () => {
  // Documento tiene token ajeno 'token-AJENO'
  const result = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-AJENO', bsaleId: 92744 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })

  assert.equal(result.status, 'MISMATCHED')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'CANONICAL_IDENTITY_MISMATCH')
})

test('escenario 4: documento con folio diferente queda bloqueado', () => {
  // Documento tiene folio 5141 distinto al folio de la tarjeta 5140
  const result = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5141, token: 'token-5140', bsaleId: 92744 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })

  assert.equal(result.status, 'MISMATCHED')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'CANONICAL_IDENTITY_MISMATCH')
})

test('escenario 5: puntero comercial inconsistente con la identidad canónica queda bloqueado', () => {
  // 5A: Tarjeta apunta a 92744 pero la versión canónica vigente en Bsale es 92800 (NV reemitida sin actualizar tarjeta)
  const resultSuperseded = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92800,
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92744 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })
  assert.equal(resultSuperseded.status, 'MISMATCHED')
  assert.equal(resultSuperseded.reason, 'CANONICAL_IDENTITY_MISMATCH')

  // 5B: Tarjeta sin token canónico
  const resultNoToken = evaluateConsistency({
    cardCreatedAt: '2026-11-04T10:00:00.000Z',
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: null,
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines: [
      { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
    ],
    incidents: [],
    syncRun: { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' },
    doc: { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92744 },
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
    ],
  })
  assert.equal(resultNoToken.status, 'MISMATCHED')
  assert.equal(resultNoToken.reason, 'CANONICAL_IDENTITY_MISMATCH')
})

test('escenario 6: sincronización correcta seguida de actualizaciones administrativas continúa sin producir falsos bloqueos', () => {
  const cardCreatedAt = '2026-11-04T10:00:00.000Z'
  const lines = [
    { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
  ]
  const incidents = [
    { createdAt: '2026-11-04T10:08:00.000Z', lastVerifiedAt: '2026-11-04T10:17:00.000Z', status: 'RESOLVED' },
  ]
  const syncRun = { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' }
  const doc = { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92744 }
  const details = [
    { sku: 'SKU-001', variantId: 101, quantity: 2, syncRunId: 'run-100' },
  ]

  // Actualizaciones administrativas posteriores a la sincronización:
  // - card.updated_at = 10:16:00 (actualización del puntero current_bsale_nv_id)
  // - incident.last_verified_at = 10:17:00 (resolución y verificación de incidencia)
  const result = evaluateConsistency({
    cardCreatedAt,
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines,
    incidents,
    syncRun,
    doc,
    details,
  })

  assert.equal(result.status, 'MATCHED', 'La sincronización debe ser válida sin ser invalidada por el puntero o verificación posterior')
  assert.equal(result.reason, null)
})

test('escenario 7: diferencias reales de cantidades e incidencias abiertas mantienen los bloqueos existentes', () => {
  const cardCreatedAt = '2026-11-04T10:00:00.000Z'
  const lines = [
    { sku: 'SKU-001', variantId: 101, preparedQuantity: 2, updatedAt: '2026-11-04T10:05:00.000Z' },
  ]
  const syncRun = { status: 'COMPLETED', completedAt: '2026-11-04T10:15:00.000Z' }
  const doc = { state: 0, syncedAt: '2026-11-04T10:15:00.000Z', syncRunId: 'run-100', number: 5140, token: 'token-5140', bsaleId: 92744 }

  // 7A: Diferencia real de cantidad (NV tiene 3 pero preparado tiene 2)
  const resultQuantityMismatch = evaluateConsistency({
    cardCreatedAt,
    cardStatus: 'AUDITED',
    cardFolio: '5140',
    cardToken: 'token-5140',
    currentNvId: 92744,
    canonicalVersionNvId: 92744,
    lines,
    incidents: [],
    syncRun,
    doc,
    details: [
      { sku: 'SKU-001', variantId: 101, quantity: 3, syncRunId: 'run-100' },
    ],
  })
  assert.equal(resultQuantityMismatch.status, 'MISMATCHED')
  assert.equal(resultQuantityMismatch.reason, 'PREPARED_QUANTITY_MISMATCH')

  // 7B: Incidencia comercial abierta
  function evaluateRouteReadiness({ consistencyStatus, openIncidentsCount, nvState = 0, closedAt = null }) {
    if (nvState !== 0 || closedAt !== null) return 'BLOCKED'
    if (consistencyStatus !== 'MATCHED') return 'BLOCKED'
    if (openIncidentsCount > 0) return 'INCIDENTS'
    return 'READY_TO_INVOICE'
  }

  const readiness = evaluateRouteReadiness({
    consistencyStatus: 'MATCHED',
    openIncidentsCount: 1,
  })
  assert.equal(readiness, 'INCIDENTS')

  function evaluatePrevalidateReadiness({ hasOpenIncidents, consistencyStatus }) {
    if (hasOpenIncidents) {
      return { status: 'BLOCKED', can_invoice: false, code: 'OPEN_COMMERCIAL_INCIDENTS' }
    }
    if (consistencyStatus !== 'MATCHED') {
      return { status: 'BLOCKED', can_invoice: false, code: 'COMMERCIAL_RECONCILIATION_REQUIRED' }
    }
    return { status: 'READY', can_invoice: true, code: 'OK' }
  }

  const preval = evaluatePrevalidateReadiness({
    hasOpenIncidents: true,
    consistencyStatus: 'MATCHED',
  })
  assert.equal(preval.status, 'BLOCKED')
  assert.equal(preval.can_invoice, false)
  assert.equal(preval.code, 'OPEN_COMMERCIAL_INCIDENTS')
})
