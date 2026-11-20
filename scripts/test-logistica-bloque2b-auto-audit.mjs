import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  evaluatePostSyncAuditTransition,
  PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE,
  PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE,
} from '../src/modules/logistica/preparacion-pedidos/preparation-line-validation.ts'

const root = process.cwd()
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

const line = (overrides = {}) => ({
  id: 'line-1',
  company_id: 'comp-1',
  card_id: 'card-1',
  bsale_nv_id: 1001,
  bsale_detail_id: 5001,
  bsale_variant_id: 9001,
  sku: 'SKU-1',
  product_name: 'Producto 1',
  requested_quantity: 5,
  prepared_quantity: 5,
  line_status: 'CONFIRMED',
  excluded_from_dispatch: false,
  confirmed_by: 'user-1',
  confirmed_at: '2026-11-20T08:00:00Z',
  ...overrides,
})

test('1. sincronización exitosa + preparación conforme -> habilita avance automático a Auditoría', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [line(), line({ id: 'line-2', bsale_detail_id: 5002, sku: 'SKU-2', requested_quantity: 3, prepared_quantity: 3 })],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, true)
  assert.equal(decision.reason, null)
})

test('2. sincronización exitosa + faltante parcial -> permanece en Preparación con motivo', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [line({ requested_quantity: 5, prepared_quantity: 3, line_status: 'INCIDENT' })],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, false)
  assert.equal(decision.reason, 'INCIDENT_LINES')
  assert.equal(decision.message, PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE)
})

test('3. exclusión pendiente -> bloqueada', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [
      line(),
      line({ id: 'line-2', requested_quantity: 2, prepared_quantity: 0, line_status: 'INCIDENT', excluded_from_dispatch: true }),
    ],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, false)
  assert.equal(decision.reason, 'INCIDENT_LINES')
})

test('4. incidencia abierta -> bloqueada incluso si líneas están CONFIRMED', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [line()],
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, false)
  assert.equal(decision.reason, 'OPEN_INCIDENTS')
  assert.equal(decision.message, PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE)
})

test('5. diferencia comercial sin aceptación -> bloqueada', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [line()],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'CHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, false)
  assert.equal(decision.reason, 'COMMERCIAL_CHANGE_UNACCEPTED')
  assert.equal(decision.message, PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE)
})

test('6. documento sustituto correctamente conciliado (reducción parcial reconciliada) -> avance permitido', () => {
  const decision = evaluatePostSyncAuditTransition({
    cardStatus: 'IN_PREPARATION',
    lines: [
      line(),
      line({ id: 'line-2', bsale_nv_id: 2002, bsale_detail_id: 6002, requested_quantity: 3, prepared_quantity: 3, line_status: 'INCIDENT' }),
    ],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    commercialVerificationSource: 'LIVE_BSALE',
  })
  assert.equal(decision.shouldAdvanceToAudit, true)
  assert.equal(decision.reason, null)
})

test('7. error Bsale o verificación en caché / sin fuente LIVE_BSALE -> bloqueada fail-closed', () => {
  for (const scenario of [
    { status: 'UNAVAILABLE', source: 'NONE' },
    { status: 'UNCHANGED', source: 'CACHE' },
    { status: 'UNCHANGED', source: 'NONE' },
    { status: null, source: null },
  ]) {
    const decision = evaluatePostSyncAuditTransition({
      cardStatus: 'IN_PREPARATION',
      lines: [line()],
      openCommercialIncidentCount: 0,
      commercialAlertStatus: scenario.status,
      commercialVerificationSource: scenario.source,
    })
    assert.equal(decision.shouldAdvanceToAudit, false, `debe bloquear para ${JSON.stringify(scenario)}`)
    assert.equal(decision.reason, 'COMMERCIAL_UNVERIFIED')
  }
})

test('8-9. concurrencia y cambios concurrentes durante reconciliación: contrato server action y UI', () => {
  const syncSrc = read('src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
  const fnStart = syncSrc.indexOf('export async function syncSalesOrderPreparationCardFromBsale')
  const fnBody = syncSrc.slice(fnStart)

  // Concurrencia: lock operativo liberado antes de transición, inFlightCardSyncs retenido hasta finally
  assert.match(fnBody, /inFlightCardSyncs\.has\(inFlightKey\)/)
  assert.match(fnBody, /acquireOperationalBsaleSyncLock\(/)
  assert.match(fnBody, /\.eq\('status',\s*'IN_PREPARATION'\)\s*\.select\('id,\s*status'\)\s*\.maybeSingle\(\)/)
  assert.match(fnBody, /getSalesOrderPreparationCommercialAlert\(cardRow\.id,\s*\{\s*bypassCache:\s*true\s*\}\)/)
  assert.match(fnBody, /evaluatePostSyncAuditTransition\(/)
  assert.match(fnBody, /moveSalesOrderPreparationCard\(\{\s*cardId:\s*cardRow\.id,\s*toStatus:\s*'IN_AUDIT'/)

  // No acepta cambios comerciales, no cierra incidencias ni actualiza status directamente
  assert.doesNotMatch(fnBody, /accept_sales_order_preparation_commercial_changes/)
  assert.doesNotMatch(fnBody, /verify_open_preparation_incidents_v1/)
  assert.doesNotMatch(fnBody, /status:\s*'IN_AUDIT'/)

  // Panel actualiza tarjeta a IN_AUDIT solo si autoMovedToAudit === true
  const panelSrc = read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  assert.match(panelSrc, /if \(result\.autoMovedToAudit\)/)
  assert.match(panelSrc, /status:\s*'IN_AUDIT'/)
})

test('10. tarjeta previamente auditada o fuera de IN_PREPARATION -> no alterada', () => {
  for (const cardStatus of ['AUDITED', 'IN_AUDIT', 'PENDING_ROUTE_PREP', 'INVOICED_READY_FOR_ROUTE', 'CANCELLED']) {
    const decision = evaluatePostSyncAuditTransition({
      cardStatus,
      lines: [line()],
      openCommercialIncidentCount: 0,
      commercialAlertStatus: 'UNCHANGED',
      commercialVerificationSource: 'LIVE_BSALE',
    })
    assert.equal(decision.shouldAdvanceToAudit, false, `no debe avanzar desde ${cardStatus}`)
    assert.equal(decision.reason, 'INVALID_CARD_STATUS')
  }
})

test('11. auditoría de concurrencia: entre liberación del lock Bsale y avance a Auditoría se revalida en vivo y bajo FOR UPDATE', () => {
  const syncSrc = read('src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
  const moveSrc = read('src/app/actions/logistica/sales-order-preparation.ts')
  const sqlSrc = read('supabase/migrations/20261119150000_logistica_block_audit_with_pending_incidents.sql')

  const fnBody = syncSrc.slice(syncSrc.indexOf('export async function syncSalesOrderPreparationCardFromBsale'))
  const releaseIdx = fnBody.indexOf('releaseOperationalBsaleSyncLock')
  const liveCheckIdx = fnBody.indexOf('getSalesOrderPreparationCommercialAlert(cardRow.id, { bypassCache: true })')
  const moveIdx = fnBody.indexOf('moveSalesOrderPreparationCard({')
  assert.ok(releaseIdx > 0 && liveCheckIdx > releaseIdx && moveIdx > liveCheckIdx, 'orden estricto: liberar lock Bsale -> revalidar en vivo -> delegar a moveSalesOrderPreparationCard')

  // moveSalesOrderPreparationCard vuelve a verificar Bsale en vivo sin caché antes de la RPC
  const moveBody = moveSrc.slice(moveSrc.indexOf('export async function moveSalesOrderPreparationCard'))
  assert.match(moveBody, /getSalesOrderPreparationCommercialAlert\(params\.cardId,\s*\{\s*bypassCache:\s*true\s*\}\)/)
  assert.match(moveBody, /verificationSource !== 'LIVE_BSALE'/)

  // La RPC bloquea la fila con FOR UPDATE y revalida espejo canónico, detalles, equivalencia comercial y cantidades
  assert.match(sqlSrc, /FROM logistica\.sales_order_preparation_cards[\s\S]*?FOR UPDATE/)
  assert.match(sqlSrc, /FROM integraciones\.vw_bsale_sales_order_documents_canonical/)
  assert.match(sqlSrc, /v_bsale_detail_count = 0/)
  assert.match(sqlSrc, /commercial_diffs/)
})

test('12. auditoría de integridad documental: fallo al actualizar current_bsale_nv_id reintenta acotado a la tarjeta, nunca toca otras tarjetas y nunca avanza', () => {
  const syncSrc = read('src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
  const fnBody = syncSrc.slice(syncSrc.indexOf('export async function syncSalesOrderPreparationCardFromBsale'))

  assert.match(fnBody, /for \(let attempt = 0; attempt < 3; attempt\+\+\)/)
  assert.match(fnBody, /\.eq\('id',\s*cardRow\.id\)\s*\.eq\('company_id',\s*auth\.companyId\)\s*\.eq\('status',\s*'IN_PREPARATION'\)/)
  assert.doesNotMatch(fnBody, /reconcile_bodega_preparation_cards/)
  assert.match(fnBody, /throw new Error\(`No se pudo actualizar la referencia vigente de la tarjeta tras reintentos:/)
})
