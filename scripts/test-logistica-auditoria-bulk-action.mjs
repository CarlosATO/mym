import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/app/actions/logistica/sales-order-audit.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
let response
let requests
const supabase = { schema: name => ({ rpc: async (rpc, args) => { requests.push({ name, rpc, args }); return response } }), auth: { getUser: async () => ({ data: { user: null }, error: null }) } }
const mocks = {
  '@/lib/supabase/server': { createClient: async () => supabase },
  '@/lib/supabase/admin': {}, '@/app/actions/companies': {},
  '@/modules/logistica/auditoria/audit-policy': { isAuditIncidentType: () => true },
  '@/modules/logistica/auditoria/audit-ui-utils': {}, './sales-order-audit-commercial': {},
}
const exports = {}
vm.runInNewContext(compiled, { exports, require: key => mocks[key] ?? (() => { throw new Error(`Unexpected import ${key}`) })(), performance, process: { env: { NODE_ENV: 'production' } }, console })
const args = { auditId: 'audit', auditLineId: 'line', companyId: 'company' }

test('acción masiva invoca exclusivamente la RPC protegida sin enviar cantidades', async () => {
  requests = []; response = { data: { line: { id: 'line' }, incident: null }, error: null }
  const result = await exports.registerPendingSalesOrderAuditLine(args)
  assert.equal(result.data.line.id, 'line')
  assert.equal(result.stopBatch, false)
  assert.equal(JSON.stringify(requests), JSON.stringify([{ name: 'logistica', rpc: 'register_pending_sales_order_audit_line', args: { p_company_id: 'company', p_audit_id: 'audit', p_audit_line_id: 'line' } }]))
})

test('contención y conflictos siguen como errores parciales; permisos detienen', async () => {
  for (const [code, message, stop] of [['55P03', 'bloqueada', false], ['P0001', 'AUDIT_BULK_OPEN_INCIDENT', false], ['42501', 'permission denied', true], ['P0001', 'Esta auditoría está asignada a otro usuario.', true], ['P0001', 'No tienes permiso para gestionar Auditoría.', true], ['P0001', 'La sesión de auditoría no está abierta.', true]]) {
    requests = []; response = { data: null, error: { code, message } }
    const result = await exports.registerPendingSalesOrderAuditLine(args)
    assert.equal(result.stopBatch, stop, message)
    assert.match(result.error, code === '55P03' ? /55P03/ : new RegExp(message))
  }
})

test('confirmación individual continúa usando su RPC original', async () => {
  requests = []; response = { data: { line: {} }, error: null }
  await exports.confirmSalesOrderAuditLine({ auditLineId: 'line', auditQuantity: 0, companyId: 'company' })
  assert.equal(requests[0].rpc, 'confirm_sales_order_audit_line')
  assert.equal(requests[0].args.p_audit_quantity, 0)
})
