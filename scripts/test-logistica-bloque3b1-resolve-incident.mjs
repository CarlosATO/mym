import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('1. migración 20261120110000 implementa resolve_sales_order_audit_incident con locks, evidencia y verificación comercial coherente', () => {
  const sql = read('supabase/migrations/20261120110000_logistica_resolve_sales_order_audit_incident.sql')

  assert.match(sql, /CREATE OR REPLACE FUNCTION logistica\.resolve_sales_order_audit_incident\(/)
  assert.match(sql, /logistica\.audit\.manage/)
  assert.match(sql, /v_audit\.status <> 'OPEN'/)
  assert.match(sql, /v_card\.status <> 'IN_AUDIT'/)
  assert.match(sql, /v_incident\.status <> 'OPEN'/)
  assert.match(sql, /logistica\.audit_incident_has_required_evidence\(p_company_id, v_incident\.id\)/)

  // No confía solo en is_current = true: valida timestamps, canonical view, auditedLines y espejo bsale_document_details
  assert.match(sql, /v_verification\.verified_at < v_line\.updated_at/)
  assert.match(sql, /FROM integraciones\.vw_bsale_sales_order_documents_canonical/)
  assert.match(sql, /jsonb_array_elements\(v_snapshot->'auditedLines'\)/)
  assert.match(sql, /FROM integraciones\.bsale_document_details det/)

  // Orden de locks alineado con confirm_sales_order_audit_line: Línea -> Auditoría -> Tarjeta -> Incidencia
  const lineLockIdx = sql.indexOf('FROM logistica.sales_order_audit_lines\n    WHERE id = v_audit_line_id')
  const auditLockIdx = sql.indexOf('FROM logistica.sales_order_audits\n    WHERE id = p_audit_id')
  const cardLockIdx = sql.indexOf('FROM logistica.sales_order_preparation_cards\n    WHERE id = p_card_id')
  const incidentLockIdx = sql.indexOf('FROM logistica.sales_order_audit_incidents\n    WHERE id = p_incident_id')
  assert.ok(
    lineLockIdx > 0 && auditLockIdx > lineLockIdx && cardLockIdx > auditLockIdx && incidentLockIdx > cardLockIdx,
    'el orden de FOR UPDATE debe ser Línea -> Auditoría -> Tarjeta -> Incidencia para evitar deadlocks con confirm_sales_order_audit_line',
  )

  // Respeta alcance 3B.1 (sin 0/eliminadas ni sobrantes) y no auto-finaliza ni acepta cambios comerciales
  assert.match(sql, /v_line\.audit_quantity <= 0/)
  assert.match(sql, /v_line\.audit_quantity > v_line\.prepared_quantity_snapshot/)
  assert.doesNotMatch(sql, /finalize_sales_order_audit\(/)
  assert.doesNotMatch(sql, /accept_sales_order_audit_commercial_changes/)
  assert.doesNotMatch(sql, /SET status = 'AUDITED'/)
})

test('2. server action resolveSalesOrderAuditIncident en sales-order-audit.ts delega en la RPC oficial', () => {
  const src = read('src/app/actions/logistica/sales-order-audit.ts')
  assert.match(src, /export async function resolveSalesOrderAuditIncident\(/)
  assert.match(src, /\.rpc\('resolve_sales_order_audit_incident'/)
  assert.match(src, /p_resolution_note:\s*note/)
})

test('3. UI drawer Auditoría (Bloque 3B.2): botón Resolver incidencia, diálogo con observación obligatoria, dedupe y visualización RESOLVED preservando historial', () => {
  const drawer = read('src/modules/logistica/auditoria/sales-order-audit-drawer.tsx')

  assert.match(drawer, /resolveSalesOrderAuditIncident/)
  assert.match(drawer, /Resolver incidencia/)
  assert.match(drawer, /Observación de resolución \(obligatoria\)/)
  assert.match(drawer, /resolvingIncidentRef\.current/)
  assert.match(drawer, /Resuelta \(RESOLVED\)/)
  assert.match(drawer, /Preparado \{resolvedIncident\.prepared_quantity_snapshot\} → Auditado \{resolvedIncident\.audit_quantity\}/)
  assert.match(drawer, /REVISAR CIERRE/)
})
