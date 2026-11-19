import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  evaluatePreparationAuditEligibility,
  getPreparationLineValidation,
  PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE,
  PREPARATION_COMMERCIAL_UNAVAILABLE_AUDIT_BLOCK_MESSAGE,
  PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE,
} from '../src/modules/logistica/preparacion-pedidos/preparation-line-validation.ts'

const drawer = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', import.meta.url), 'utf8')
const actions = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation.ts', import.meta.url), 'utf8')
const commercialActions = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-commercial.ts', import.meta.url), 'utf8')
const migration = await readFile(new URL('../supabase/migrations/20261119150000_logistica_block_audit_with_pending_incidents.sql', import.meta.url), 'utf8')

function makeLine(overrides = {}) {
  return {
    id: 'line-1',
    card_id: 'card-1',
    bsale_nv_id: 1001,
    bsale_detail_id: 2001,
    bsale_variant_id: 3001,
    sku: 'SKU-001',
    product_name: 'Producto de prueba',
    requested_quantity: 10,
    prepared_quantity: 10,
    line_status: 'CONFIRMED',
    excluded_from_dispatch: false,
    incident_reason_code: null,
    incident_observation: null,
    confirmed_by: 'user-1',
    confirmed_at: '2026-11-19T12:00:00Z',
    ...overrides,
  }
}

test('1. línea pendiente (sin cantidad registrada) bloquea Auditoría y NO se clasifica como incidencia de stock', () => {
  const lines = [
    makeLine({ id: 'l-1', line_status: 'CONFIRMED', prepared_quantity: 10 }),
    makeLine({ id: 'l-2', sku: 'SKU-002', line_status: 'PENDING', prepared_quantity: null }),
  ]
  const validation = getPreparationLineValidation(lines)
  assert.equal(validation.pendingLines.length, 1)
  assert.equal(validation.incidentLines.length, 0)

  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'PENDING_LINES')
  assert.equal(eligibility.pendingCount, 1)
  assert.match(eligibility.message, /Faltan 1 producto por confirmar/i)
})

test('2. faltante parcial bloquea Auditoría con el mensaje requerido', () => {
  const lines = [
    makeLine({ id: 'l-1', requested_quantity: 10, prepared_quantity: 6, line_status: 'INCIDENT', incident_reason_code: 'STOCK_INSUFICIENTE' }),
    makeLine({ id: 'l-2', sku: 'SKU-002', requested_quantity: 5, prepared_quantity: 5, line_status: 'CONFIRMED' }),
  ]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'INCIDENT_LINES')
  assert.equal(eligibility.incidentCount, 1)
  assert.equal(eligibility.message, PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE)
})

test('3. línea excluida (cantidad 0) bloquea Auditoría con el mensaje requerido', () => {
  const lines = [
    makeLine({ id: 'l-1', requested_quantity: 4, prepared_quantity: 0, line_status: 'INCIDENT', excluded_from_dispatch: true, incident_reason_code: 'SIN_STOCK' }),
    makeLine({ id: 'l-2', sku: 'SKU-002', requested_quantity: 2, prepared_quantity: 2, line_status: 'CONFIRMED' }),
  ]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'INCIDENT_LINES')
  assert.equal(eligibility.message, PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE)
})

test('4. incidencia comercial abierta bloquea Auditoría aunque las líneas estén en CONFIRMED', () => {
  const lines = [makeLine()]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'OPEN_INCIDENTS')
  assert.equal(eligibility.message, PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE)
})

test('5. versión Bsale modificada sin aceptar bloquea Auditoría', () => {
  const lines = [makeLine()]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'CHANGED',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'COMMERCIAL_CHANGE_UNACCEPTED')
  assert.equal(eligibility.message, PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE)
})

test('6. pedido completamente válido sin diferencias ni cambios sin aceptar permite avanzar a Auditoría', () => {
  const lines = [
    makeLine({ id: 'l-1', requested_quantity: 10, prepared_quantity: 10, line_status: 'CONFIRMED' }),
    makeLine({ id: 'l-2', sku: 'SKU-002', requested_quantity: 3, prepared_quantity: 3, line_status: 'CONFIRMED' }),
  ]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(eligibility.canSendToAudit, true)
  assert.equal(eligibility.reason, null)
  assert.equal(eligibility.message, null)
})

test('7. contrato UI drawer: elimina bypass auditSummaryOpen, deshabilita botón y muestra mensaje exacto', () => {
  assert.doesNotMatch(drawer, /auditSummaryOpen/)
  assert.match(drawer, /evaluatePreparationAuditEligibility/)
  assert.match(drawer, /disabled=\{isMoving \|\| isReadOnly \|\| !auditEligibility\.canSendToAudit\}/)
  assert.match(drawer, /PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE/)
  assert.equal(
    PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE,
    'Preparación con incidencias. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale. Puedes continuar preparando los demás productos. Una vez reconciliados todos los cambios y confirmadas las líneas, se habilitará el envío a Auditoría.',
  )
})

test('8. contrato Kanban drag & drop y Server Action: verificación comercial estricta sin caché y fail-closed', () => {
  assert.match(panel, /evaluatePreparationAuditEligibility/)
  assert.match(panel, /openCommercialIncidentCount=\{selectedCard \? commercialIncidentCounts\[selectedCard\.card_id\] \?\? 0 : 0\}/)
  assert.match(actions, /if \(params\.toStatus === 'IN_AUDIT'\)/)
  assert.match(actions, /getSalesOrderPreparationCommercialAlert\(params\.cardId,\s*\{\s*bypassCache:\s*true\s*\}\)/)
  assert.match(actions, /alertStatus !== 'UNCHANGED' \|\| commercialAlertResult\.data\.verificationSource !== 'LIVE_BSALE'/)
  assert.match(commercialActions, /useCache:\s*!options\?\.bypassCache/)
})

test('9. contrato migración SQL: move_sales_order_preparation_card bloquea todos los casos y soporta reconciliación parcial', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.move_sales_order_preparation_card/)
  assert.match(migration, /v_incident_lines > 0/)
  assert.match(migration, /ri\.status = 'RESOLVED'[\s\S]*ri\.verification_status = 'MATCHED'/)
  assert.match(migration, /FROM logistica\.sales_order_preparation_incidents[\s\S]*status = 'OPEN'/)
  assert.match(migration, /FROM logistica\.sales_order_preparation_commercial_versions/)
  assert.match(migration, /FROM integraciones\.vw_bsale_sales_order_documents_canonical/)
  assert.match(migration, /r\.created_at > v_latest_accepted_at/)
  assert.match(migration, /FROM integraciones\.bsale_document_details/)
  assert.match(migration, /Preparación con incidencias\. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale\./)
})

test('10. UNAVAILABLE / timeout de Bsale bloquea transición (fail-closed)', () => {
  const lines = [makeLine()]
  const eligibility = evaluatePreparationAuditEligibility({
    lines,
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNAVAILABLE',
  })
  assert.equal(eligibility.canSendToAudit, false)
  assert.equal(eligibility.reason, 'COMMERCIAL_UNVERIFIED')
  assert.equal(eligibility.message, PREPARATION_COMMERCIAL_UNAVAILABLE_AUDIT_BLOCK_MESSAGE)
})

test('11. recorrido completo de reconciliación con faltante parcial habilita Auditoría sin bloqueo permanente', () => {
  // Paso A: incidencia registrada (10 -> 6)
  const stepA = evaluatePreparationAuditEligibility({
    lines: [makeLine({ requested_quantity: 10, prepared_quantity: 6, line_status: 'INCIDENT' })],
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(stepA.canSendToAudit, false)
  assert.equal(stepA.reason, 'INCIDENT_LINES')

  // Paso B: Bsale corregido a 6 y sincronizado, pero cambio comercial aún NO aceptado
  const stepB = evaluatePreparationAuditEligibility({
    lines: [makeLine({ requested_quantity: 10, prepared_quantity: 6, line_status: 'INCIDENT' })],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'CHANGED',
  })
  assert.equal(stepB.canSendToAudit, false)

  // Paso C: cambio comercial aceptado (requested_quantity=6, prepared_quantity=6, line_status='INCIDENT' preservado)
  const stepC = evaluatePreparationAuditEligibility({
    lines: [makeLine({ requested_quantity: 6, prepared_quantity: 6, line_status: 'INCIDENT', excluded_from_dispatch: false })],
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
  })
  assert.equal(stepC.canSendToAudit, true)
  assert.equal(stepC.reason, null)
})
