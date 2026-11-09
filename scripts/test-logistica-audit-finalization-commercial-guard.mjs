import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/logistica/sales-order-audit.ts', import.meta.url), 'utf8')
const start = action.indexOf('export async function finalizeSalesOrderAudit')
const end = action.indexOf('\nexport type AuditBoardLock', start)
const body = action.slice(start, end)

test('la finalización backend reutiliza la verificación comercial', () => {
  assert.match(body, /verifySalesOrderAuditCommercial\(/)
  assert.match(body, /No se recibió una verificación comercial consistente para finalizar la Auditoría\./)
  assert.match(body, /verification\.status !== 'READY_TO_INVOICE'/)
  assert.match(body, /No se puede finalizar la Auditoría: existen diferencias comerciales pendientes\./)
  assert.match(body, /No se puede finalizar la Auditoría: la verificación comercial quedó bloqueada\./)
})

test('READY_TO_INVOICE es la única ruta que llega al RPC de finalización', () => {
  const guardEnd = body.indexOf("const { data, error } = await supabase")
  assert.ok(guardEnd > 0)
  const beforeFinalizeRpc = body.slice(0, guardEnd)
  assert.match(beforeFinalizeRpc, /verification\.status !== 'READY_TO_INVOICE'/)
  assert.doesNotMatch(beforeFinalizeRpc, /rpc\('finalize_sales_order_audit'/)
  assert.match(body.slice(guardEnd), /rpc\('finalize_sales_order_audit'/)
})

test('la protección no resuelve incidencias de preparación ni modifica facturación', () => {
  assert.doesNotMatch(body, /verify_open_preparation_incidents_v1|accept_sales_order_preparation_commercial_changes/)
  assert.doesNotMatch(body, /\b(invoice|factur)\w*/i)
})
