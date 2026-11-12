// Requires react-test-renderer 19.2.4, supplied externally via NODE_PATH.
import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const renderer = require('react-test-renderer')
const rendererRequire = createRequire(require.resolve('react-test-renderer'))
const React = rendererRequire('react')
const { act } = renderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const source = readFileSync(new URL('../src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', import.meta.url), 'utf8')
const bulkSource = readFileSync(new URL('../src/modules/logistica/auditoria/audit-bulk-confirm.ts', import.meta.url), 'utf8')
const compile = (text, mocks) => {
  const mod = new Module('/audit-mock.cjs')
  mod.filename = '/audit-mock.cjs'
  mod.require = name => name in mocks ? mocks[name] : require(name)
  mod._compile(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, mod.filename)
  return mod.exports
}
const bulk = compile(bulkSource, {})
let detail
let confirm
let calls
let bulkCalls
const dialog = () => null
const actions = {
  getSalesOrderAuditDetail: async () => ({ data: detail, error: null }),
  confirmSalesOrderAuditLine: input => { calls.push(input); return confirm(input) },
  registerPendingSalesOrderAuditLine: input => {
    bulkCalls.push(input)
    const line = detail.lines.find(item => item.id === input.auditLineId)
    return confirm({ ...input, auditQuantity: line.prepared_quantity_snapshot })
  },
}
const utils = {
  AUDIT_EVIDENCE_ACCEPT: 'image/*', AUDIT_INCIDENT_LABELS: {},
  getAuditLineResultLabel: line => line.line_status, getAuditLineResultTone: () => 'pending',
  formatAuditedTotal: () => '0', formatPreparedTotal: () => '0', formatSnapshotLines: () => '0',
  getAuditOpenIncident: (incidents, id) => incidents.find(item => item.audit_line_id === id && item.status === 'OPEN') ?? null,
  isAuditGlobalPhoto: () => false,
  summarizeAuditDetail: value => ({ requested: 0, prepared: 0, audited: 0, auditedLines: 0, totalLines: value?.lines.length ?? 0 }),
}
const mocks = {
  react: React, 'react/jsx-runtime': rendererRequire('react/jsx-runtime'),
  'lucide-react': new Proxy({}, { get: () => () => null }), sonner: { toast: { success() {} } },
  '@/app/actions/logistica/sales-order-audit': actions,
  '@/app/actions/logistica/sales-order-audit-commercial': {},
  './audit-cache': { getAuditCache: () => null, invalidateAuditCache() {}, setAuditCache() {} },
  './audit-ui-utils': utils,
  './audit-policy': { incidentRequiresPhoto: () => false, isAuditLockError: () => false },
  './audit-bulk-confirm': bulk,
  './audit-incident-dialog': { AuditIncidentDialog: dialog },
  './audit-takeover-dialog': { AuditTakeoverDialog: () => null },
  './audit-close-review-dialog': { AuditCloseReviewDialog: () => null },
  './audit-evidence-preview-dialog': { AuditEvidencePreviewDialog: () => null },
  './audit-commercial-review-dialog': { AuditCommercialReviewDialog: () => null },
}
const { SalesOrderAuditDrawer } = compile(source, mocks)
const makeLine = (id, prepared = 5) => ({ id, product_name: id, sku: id, line_status: 'PENDING', audit_quantity: null, prepared_quantity_snapshot: prepared, requested_quantity_snapshot: 10 })
const props = { card: { card_id: 'card', company_id: 'company', status: 'IN_AUDIT' }, currentUserId: 'auditor', currentUserName: 'A', canManage: true, isSuperUsuario: false, canAuthorizeException: false, onClose() {}, onAuditLockChange() {}, onOwnershipConflict() {} }
async function mount(lines = [makeLine('A')], custom = {}, incidents = [], auditOverrides = {}) {
  calls = []
  bulkCalls = []
  detail = { audit: { id: 'audit', status: 'OPEN', locked_by_user_id: 'auditor', prepared_by_user_id_snapshot: 'other', ...auditOverrides }, lines, incidents, attachments: [] }
  confirm = async input => ({ data: { line: { ...lines.find(item => item.id === input.auditLineId), audit_quantity: input.auditQuantity, line_status: 'CONFIRMED' }, incident: null }, error: null })
  let tree
  await act(async () => { tree = renderer.create(React.createElement(SalesOrderAuditDrawer, { ...props, ...custom })) })
  return tree
}
const inputFor = (tree, id) => tree.root.findByProps({ id: `audit-qty-${id}` })
const enter = input => input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
const blur = input => input.props.onBlur({ relatedTarget: null })

test('Enter y blur no duplican; fallo conserva cantidad y reintento confirma', async () => {
  const tree = await mount()
  let resolve
  confirm = () => new Promise(done => { resolve = done })
  await act(async () => { inputFor(tree, 'A').props.onChange({ target: { value: '5' } }) })
  await act(async () => { enter(inputFor(tree, 'A')); blur(inputFor(tree, 'A')) })
  assert.equal(calls.length, 1)
  assert.equal(inputFor(tree, 'A').props.value, '5')
  await act(async () => { resolve({ data: null, error: 'fallo simulado' }) })
  assert.equal(inputFor(tree, 'A').props.value, '5')
  confirm = async () => ({ data: { line: { ...detail.lines[0], audit_quantity: 5, line_status: 'CONFIRMED' }, incident: null }, error: null })
  await act(async () => { blur(inputFor(tree, 'A')) })
  assert.equal(calls.length, 2)
  await act(async () => { tree.unmount() })
})

test('cantidad cero discrepante abre diálogo sin llamar al backend', async () => {
  const tree = await mount()
  await act(async () => { inputFor(tree, 'A').props.onChange({ target: { value: '0' } }) })
  await act(async () => { blur(inputFor(tree, 'A')) })
  assert.equal(calls.length, 0)
  const modal = tree.root.findByType(dialog)
  assert.equal(modal.props.open, true)
  assert.equal(modal.props.auditQuantity, 0)
  await act(async () => { tree.unmount() })
})

test('usuarios sin escritura no pueden ejecutar registro masivo', async () => {
  const tree = await mount([makeLine('A')], { canManage: false })
  const button = tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo'))
  assert.equal(button.props.disabled, true)
  await act(async () => { button.props.onClick() })
  assert.equal(calls.length, 0)
  await act(async () => { tree.unmount() })
})

test('registro masivo usa preparado, excluye borradores e incidencias y evita doble ejecución', async () => {
  const lines = [makeLine('A', 5), makeLine('B', 3), makeLine('C'), { ...makeLine('D'), line_status: 'CONFIRMED', audit_quantity: 5 }, makeLine('E')]
  const tree = await mount(lines, {}, [{ id: 'incident', status: 'OPEN', audit_line_id: 'C', incident_type: 'OTHER' }])
  await act(async () => { inputFor(tree, 'E').props.onChange({ target: { value: '0' } }) })
  let resolve
  confirm = input => input.auditLineId === 'A'
    ? new Promise(done => { resolve = () => done({ data: { line: { ...lines[0], audit_quantity: 5, line_status: 'CONFIRMED' }, incident: null }, error: null }) })
    : Promise.resolve({ data: null, error: 'error B' })
  const button = tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo'))
  await act(async () => { button.props.onClick(); button.props.onClick() })
  assert.deepEqual(bulkCalls.map(item => item.auditLineId), ['A'])
  assert.equal(calls.length, 0)
  await act(async () => { resolve() })
  assert.deepEqual(bulkCalls.map(item => item.auditLineId), ['A', 'B'])
  assert.deepEqual(bulkCalls[0], { auditId: 'audit', auditLineId: 'A', companyId: 'company' })
  assert.equal(inputFor(tree, 'E').props.value, '0')
  assert.ok(tree.root.findAllByProps({ role: 'alert' }).some(item => item.children.join('').includes('error B')))
  confirm = async input => ({ data: { line: { ...lines.find(item => item.id === input.auditLineId), audit_quantity: input.auditQuantity, line_status: 'CONFIRMED' }, incident: null }, error: null })
  await act(async () => { tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo')).props.onClick() })
  assert.deepEqual(bulkCalls.map(item => item.auditLineId), ['A', 'B', 'B'])
  await act(async () => { tree.unmount() })
})

test('bloqueo de otro usuario y autoauditoría deniegan escritura', async () => {
  for (const auditOverrides of [{ locked_by_user_id: 'other' }, { prepared_by_user_id_snapshot: 'auditor' }]) {
    const tree = await mount([makeLine('A')], {}, [], auditOverrides)
    const button = tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo'))
    assert.equal(button.props.disabled, true)
    assert.equal(inputFor(tree, 'A').props.disabled, true)
    await act(async () => { button.props.onClick() })
    assert.equal(calls.length, 0)
    await act(async () => { tree.unmount() })
  }
})

test('error 55P03 conserva la línea y continúa sin reintentarla', async () => {
  const lines = [makeLine('A'), makeLine('B')]
  const tree = await mount(lines)
  confirm = async input => input.auditLineId === 'A'
    ? { data: null, error: '55P03: bloqueo', stopBatch: false }
    : { data: { line: { ...lines[1], audit_quantity: 5, line_status: 'CONFIRMED' }, incident: null }, error: null, stopBatch: false }
  await act(async () => { tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo')).props.onClick() })
  assert.deepEqual(bulkCalls.map(item => item.auditLineId), ['A', 'B'])
  assert.equal(inputFor(tree, 'A').props.value, '')
  assert.equal(inputFor(tree, 'B').props.value, '5')
  assert.ok(tree.root.findAllByProps({ role: 'alert' }).some(item => item.children.join('').includes('55P03')))
  await act(async () => { tree.unmount() })
})

test('pérdida de permiso detiene las siguientes líneas', async () => {
  const tree = await mount([makeLine('A'), makeLine('B')])
  confirm = async () => ({ data: null, error: 'No tienes permiso para gestionar Auditoría.', stopBatch: true })
  await act(async () => { tree.root.findAllByType('button').find(item => item.children.includes('Registrar todo')).props.onClick() })
  assert.deepEqual(bulkCalls.map(item => item.auditLineId), ['A'])
  await act(async () => { tree.unmount() })
})
