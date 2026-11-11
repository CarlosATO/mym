import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { acceptCommercialReview, loadCommercialReview } from '../src/modules/logistica/auditoria/audit-commercial-review-flow.ts'

const line = (sku, variantId, quantity) => ({ sku, variantId, productName: sku, quantity, unitNetValue: 730, lineNetAmount: quantity * 730, lineTaxAmount: 555, lineGrossAmount: 3475, netDiscount: 0 })
const data = { eligible: true, reviewedReference: 'signed-reference', errors: [], historicalTaxRateCertified: false, differences: [{ previous: { variantId: 5869 }, current: { variantId: 5869 } }], comparison: { previous: { netAmount: 39650, taxAmount: 7534, totalAmount: 47184, lines: [line('P317', 5869, 5), line('AUT.', 4733, 12)] }, current: { netAmount: 38920, taxAmount: 7395, totalAmount: 46315, lines: [line('P317', 5869, 4), line('AUT.', 4733, 12)] } } }

function harness(previewAction, confirmAction) {
  const slots = []; let index = 0; let pending = []; let accepted = null
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => item === b[i])
  const react = {
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useCallback(fn, deps) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value },
    useEffect(fn, deps) { const i = index++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; pending.push(() => { slots[i].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const mocks = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { Loader2: 'Loader2' },
    '@/components/ui/button': { Button: 'Button' },
    '@/components/ui/dialog': { Dialog: 'Dialog', DialogContent: 'DialogContent', DialogDescription: 'DialogDescription', DialogHeader: 'DialogHeader', DialogTitle: 'DialogTitle' },
    '@/app/actions/logistica/sales-order-audit-commercial-preview': { previewSalesOrderAuditCommercialAcceptance: previewAction },
    '@/app/actions/logistica/sales-order-audit-commercial-confirm': { confirmSalesOrderAuditCommercialAcceptance: confirmAction },
    './audit-commercial-review-flow': { acceptCommercialReview, loadCommercialReview },
  }
  const source = readFileSync(new URL('../src/modules/logistica/auditoria/audit-commercial-review-dialog.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, require: name => { if (!mocks[name]) throw new Error(`Unexpected import ${name}`); return mocks[name] }, Set, Intl, Error })
  const props = { open: true, companyId: 'c', cardId: 'card', auditId: 'audit', onOpenChange() {}, onAccepted: value => { accepted = value } }
  function render() { index = 0; const tree = exports.AuditCommercialReviewDialog(props); const effects = pending; pending = []; effects.forEach(effect => effect()); return tree }
  function nodes(value) { if (!value || typeof value !== 'object') return []; if (Array.isArray(value)) return value.flatMap(nodes); const rendered = typeof value.type === 'function' ? value.type(value.props) : null; return [value, ...nodes(rendered), ...nodes(value.props?.children)] }
  const label = item => { const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value?.props ? text(value.props.children) : ''; return text(item.props.children) }
  return { render, nodes, label, get accepted() { return accepted } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('diálogo muestra ambas versiones y requiere confirmación explícita', async () => {
  let calls = 0; let received
  const h = harness(async () => ({ data, error: null }), async value => { calls++; received = value; return { data: { status: 'ACCEPTED', versionId: 'v' }, error: null } })
  h.render(); await tick(); let tree = h.render()
  const rows = h.nodes(tree); const text = rows.map(h.label).join(' ')
  assert.match(text, /P317/); assert.match(text, /AUT\./); assert.match(text, /47\.184/); assert.match(text, /46\.315/); assert.match(text, /Sin cambios/); assert.match(text, /Modificado/)
  assert.match(text, /tasa tributaria histórica por línea no está certificada/)
  const button = rows.find(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial')
  assert.equal(button.props.disabled, true); assert.equal(calls, 0)
  rows.find(item => item.type === 'input' && item.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tree = h.render(); const enabled = h.nodes(tree).find(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial')
  assert.equal(enabled.props.disabled, false); enabled.props.onClick(); await tick()
  assert.equal(calls, 1); assert.equal(received.reviewedReference, 'signed-reference'); assert.equal(h.accepted, 'ACCEPTED')
})

test('vista no elegible y errores no autorizan; reintento idempotente se informa', async () => {
  for (const error of ['AUDIT_REVIEW_INVALID', 'AUDIT_COMMERCIAL_REVIEW_CHANGED', 'AUDIT_ACCEPTANCE_PERMISSION_DENIED', 'BSALE_UNAVAILABLE']) {
    let calls = 0; const h = harness(async () => ({ data, error: null }), async () => { calls++; return { data: null, error } })
    h.render(); await tick(); let tree = h.render()
    h.nodes(tree).find(item => item.type === 'input').props.onChange({ target: { checked: true } })
    tree = h.render(); h.nodes(tree).find(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial').props.onClick(); await tick(); tree = h.render()
    assert.equal(calls, 1); assert.ok(h.nodes(tree).some(item => item.props?.role === 'alert')); assert.equal(h.accepted, null)
    if (error === 'AUDIT_REVIEW_INVALID' || error === 'AUDIT_COMMERCIAL_REVIEW_CHANGED') assert.equal(h.nodes(tree).some(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial'), false)
  }
  const blocked = harness(async () => ({ data: { ...data, eligible: false, reviewedReference: null, errors: ['DISCOUNT_CHANGED'] }, error: null }), async () => { throw new Error('must not confirm') })
  blocked.render(); await tick(); const tree = blocked.render(); assert.equal(blocked.nodes(tree).some(item => item.type === 'Button' && blocked.label(item) === 'Aceptar nueva versión comercial'), false)
  let calls = 0; const retry = harness(async () => ({ data, error: null }), async () => { calls++; return { data: { status: 'ALREADY_ACCEPTED', versionId: 'v' }, error: null } })
  retry.render(); await tick(); let retryTree = retry.render(); retry.nodes(retryTree).find(item => item.type === 'input').props.onChange({ target: { checked: true } }); retryTree = retry.render(); retry.nodes(retryTree).find(item => item.type === 'Button' && retry.label(item) === 'Aceptar nueva versión comercial').props.onClick(); await tick(); assert.equal(calls, 1); assert.equal(retry.accepted, 'ALREADY_ACCEPTED')
})

test('error temporal al abrir no muestra confirmación y permite revisar nuevamente', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return calls === 1 ? { data: null, error: 'BSALE_UNAVAILABLE' } : { data, error: null } }, async () => { throw new Error('must not confirm') })
  h.render(); await tick(); let tree = h.render()
  assert.match(h.nodes(tree).map(h.label).join(' '), /No se pudo consultar Bsale/)
  assert.equal(h.nodes(tree).some(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial'), false)
  h.nodes(tree).find(item => item.type === 'Button' && h.label(item) === 'Volver a revisar').props.onClick(); await tick(); tree = h.render()
  assert.equal(h.nodes(tree).find(item => item.type === 'Button' && h.label(item) === 'Aceptar nueva versión comercial').props.disabled, true)
})

test('desde el bloqueo comercial se abre la revisión y aceptar no finaliza ni modifica líneas', () => {
  const dialog = readFileSync(new URL('../src/modules/logistica/auditoria/audit-close-review-dialog.tsx', import.meta.url), 'utf8')
  const drawer = readFileSync(new URL('../src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /diferencias comerciales pendientes/)
  assert.match(dialog, /Revisar cambio comercial/)
  const handler = drawer.slice(drawer.indexOf('onAccepted={status =>'), drawer.indexOf('<AuditEvidencePreviewDialog'))
  assert.match(handler, /setPreclose\(null\)/); assert.match(handler, /verificar nuevamente antes de finalizar/); assert.match(handler, /loadDetail\(\)/)
  assert.doesNotMatch(handler, /finalizeSalesOrderAudit|confirmSalesOrderAuditLine|setSalesOrderAuditPackageCount|invoice/i)
})
