import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { pendingBulkAuditLines, runAuditBulk } from '../src/modules/logistica/auditoria/audit-bulk-confirm.ts'

const drawer = await readFile(new URL('../src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', import.meta.url), 'utf8')
const dialog = await readFile(new URL('../src/modules/logistica/auditoria/audit-incident-dialog.tsx', import.meta.url), 'utf8')
const line = (id, extra = {}) => ({ id: String(id), line_status: 'PENDING', audit_quantity: null, prepared_quantity_snapshot: 5, requested_quantity_snapshot: 8, ...extra })

test('selección respeta confirmadas, incidencias, edición y cantidades manuales incluso cero', () => {
  const lines = [line(1), line(2, { line_status: 'CONFIRMED', audit_quantity: 5 }), line(3), line(4), line(5), line(6, { audit_quantity: 0 }), line(7)]
  const selected = pendingBulkAuditLines(lines, [{ status: 'OPEN', audit_line_id: '3' }], { 4: '0', 5: '3' }, '7')
  assert.deepEqual(selected.map(item => item.id), ['1'])
  assert.equal(selected[0].prepared_quantity_snapshot, 5)
  assert.match(drawer, /registerPendingSalesOrderAuditLine/)
})

test('ejecutor registra todas, procesa errores parciales y permite reintentar', async () => {
  const lines = [line(1), line(2), line(3)]
  const saved = []
  const errors = []
  const progress = []
  const action = async item => {
    if (item.id === '2') errors.push(item)
    else saved.push(item.id)
    return true
  }
  await runAuditBulk(lines, action, (done, total) => progress.push([done, total]), () => true)
  assert.deepEqual(saved, ['1', '3'])
  assert.deepEqual(errors.map(item => item.id), ['2'])
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]])
  await runAuditBulk(errors, async item => { saved.push(item.id); return true }, () => {}, () => true)
  assert.deepEqual(saved, ['1', '3', '2'])
})

test('la ejecución se detiene tras bloqueo o desmontaje', async () => {
  const calls = []
  await runAuditBulk([1, 2, 3], async item => { calls.push(item); return false }, () => {}, () => true)
  assert.deepEqual(calls, [1])
  await runAuditBulk([1, 2, 3], async item => { calls.push(item); return true }, () => {}, () => false)
  assert.deepEqual(calls, [1])
})

for (const count of [15, 30]) {
  test(`${count} líneas: latencia simulada y concurrencia máxima`, async t => {
    let active = 0
    let maximum = 0
    const start = performance.now()
    await runAuditBulk(Array.from({ length: count }, (_, i) => i), async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return true
    }, () => {}, () => true)
    const elapsed = performance.now() - start
    t.diagnostic(`${count} líneas, 5 ms por acción simulada: ${elapsed.toFixed(1)} ms; máximo ${maximum} simultánea`)
    assert.equal(maximum, 1)
  })
}

test('contrato de UI: Enter y blur, guardas, diferencias y conservación de evidencia', () => {
  assert.match(drawer, /onBlur=\{event =>/)
  assert.match(drawer, /event\.key === 'Enter'/)
  assert.match(drawer, /savingRef\.current \|\| bulkRef\.current/)
  assert.match(drawer, /if \(difference !== 0\)/)
  assert.match(drawer, /mode: 'AUTO'/)
  assert.match(drawer, /mode: 'MANUAL'/)
  assert.match(drawer, /uploadSalesOrderAuditEvidence/)
  assert.match(dialog, /Debes adjuntar una fotografía obligatoria/)
  assert.match(drawer, /canManage && isOwner && !isSelfAuditBlocked && !isFinalized/)
  const bulk = drawer.slice(drawer.indexOf('const handleRegisterAll'), drawer.indexOf('const handleReportIncident'))
  assert.doesNotMatch(bulk, /finalizeSalesOrderAudit/)
  assert.match(bulk, /bulkRef\.current/)
  assert.match(bulk, /applyLineConfirmation\(result\.data\.line/)
})
