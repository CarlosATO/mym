import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const drawer = await readFile(path.join(root, 'src/modules/logistica/auditoria/sales-order-audit-drawer.tsx'), 'utf8')
const actions = await readFile(path.join(root, 'src/app/actions/logistica/sales-order-audit.ts'), 'utf8')

test('una tarjeta IN_AUDIT no reutiliza el cache de un ciclo anterior', () => {
  assert.match(drawer, /card\.status === 'IN_AUDIT' \? null : getAuditCache\(card\.card_id\)/)
  assert.match(drawer, /const cached = card\.status === 'IN_AUDIT' \? null : getAuditCache\(card\.card_id\)/)
  assert.match(drawer, /invalidateAuditCache\(card\.card_id\)/)
  assert.match(drawer, /if \(card\.status !== 'IN_AUDIT'\) setAuditCache\(card\.card_id, next\)/)
  assert.match(drawer, /\[card\.card_id, card\.status, card\.company_id\]/)
})

test('IN_AUDIT sólo presenta una auditoría OPEN y descarta ciclos históricos', () => {
  assert.match(drawer, /function selectAuditDetailForCard\(/)
  assert.match(drawer, /cardStatus === 'IN_AUDIT' && detail\.audit\?\.status !== 'OPEN'/)
  assert.match(drawer, /return \{ audit: null, lines: \[\], incidents: \[\], attachments: \[\] \}/)
  assert.match(drawer, /const selectedDetail = selectAuditDetailForCard\(card\.status, result\.data\)/)
})

test('el drawer identifica discretamente el ciclo recibido del backend', () => {
  assert.match(drawer, /HeaderStat label="Ciclo" value=\{audit \? String\(audit\.cycle_no\) : '—'\}/)
})

test('las mutaciones del drawer usan el audit_id del detalle activo', () => {
  const mutationBody = drawer.slice(drawer.indexOf('const handleIncidentConfirm'), drawer.indexOf('const hasSnapshot'))
  assert.match(mutationBody, /auditId: audit\.id/)
  assert.match(mutationBody, /setSalesOrderAuditPackageCount\(\{ auditId: audit\.id/)
  assert.match(mutationBody, /getSalesOrderAuditFinalizationStatus\(audit\.id\)/)
  assert.match(mutationBody, /finalizeSalesOrderAudit\(\{[\s\S]*?auditId: audit\.id/)
})

test('la acción de detalle solicita el ciclo operativo, no el ciclo 1 fijo', () => {
  assert.match(actions, /cycleNo\?: number \| null/)
  assert.match(actions, /p_cycle_no: cycleNo \?\? null/)
  assert.doesNotMatch(actions, /p_cycle_no:\s*1/)
})
