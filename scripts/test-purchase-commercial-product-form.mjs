import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-order-commercial-product-form.tsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const review = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText

function mount(configuration = { unit: 'DISPLAY', factor: 6, mappingId: 'mapping' }) {
  const state = []
  let cursor = 0
  let added
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef() { return { current: null } },
    useEffect() {},
  }
  const module = { exports: {} }
  const loader = name => name === 'react' ? hooks : name.startsWith('@/lib/adquisiciones/') ? require(fileURLToPath(new URL(`../src/lib/adquisiciones/${name.split('/').at(-1)}.ts`, import.meta.url))) : require(name)
  new Function('require', 'module', 'exports', compiled)(loader, module, module.exports)
  const props = { product: { id: 'p', sku: '513135', description: 'Producto', last_purchase_unit_cost: null, tax_rate: 19 }, configuration, showDiscounts: true, currency: 'CLP', onAdd: value => { added = value } }
  function render() { cursor = 0; return module.exports.PurchaseOrderCommercialProductForm(props) }
  function nodes(element) { if (!element || typeof element !== 'object') return []; return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)] }
  function inputByLabel(tree, label) { const parent = nodes(tree).find(node => node.type === 'label' && [node.props.children].flat(Infinity).includes(label)); return nodes(parent).find(node => node.type === 'input') }
  function change(label, value) { const tree = render(); inputByLabel(tree, label).props.onChange({ target: { value } }); return render() }
  function click() { const tree = render(); nodes(tree).find(node => node.type === 'button' && node.props.children === 'Agregar producto').props.onClick(); return render() }
  return { render, change, click, inputByLabel, nodes, result: () => added }
}

test('bidirectional fields preserve commercial price and reject non-multiples', () => {
  const form = mount()
  let tree = form.change('Cantidad', '605')
  assert.ok(form.nodes(tree).some(node => node.props?.children?.includes?.('Debe ser múltiplo de ')))
  form.click()
  assert.equal(form.result(), undefined)
  tree = form.change('Total ', '110')
  assert.equal(form.inputByLabel(tree, 'Cantidad').props.value, '660')
  tree = form.change('Precio ', '10000')
  assert.equal(form.inputByLabel(tree, 'Precio unitario').props.value, '1666.6667')
  form.change('Dcto %', '10')
  form.click()
  assert.equal(form.result().quantity, 660)
  assert.equal(form.result().commercialPrice, '10000')
  assert.equal(form.result().discountPercent, 10)
  assert.equal(form.result().configuration.factor, 6)
})

test('missing presentation is shown and both screens use the shared form', () => {
  const form = mount({ unit: null, factor: 1, mappingId: null })
  assert.ok(form.nodes(form.render()).some(node => node.props?.children === 'Presentación de compra pendiente de configurar'))
  assert.match(panel, /<PurchaseOrderCommercialProductForm/)
  assert.match(review, /<PurchaseOrderCommercialProductForm/)
  assert.match(review, /item_id: clientId, client_id: clientId/)
  assert.match(review, /commercial_price_raw: value\.commercialPrice/)
})

test('internal fields update commercial fields and retain unit discounts', () => {
  const form = mount()
  let tree = form.change('Cantidad', '12')
  assert.equal(form.inputByLabel(tree, 'Total ').props.value, '2')
  tree = form.change('Precio unitario', '1250.25')
  assert.equal(form.inputByLabel(tree, 'Precio ').props.value, '7501.5')
  form.change('Dcto por unidad', '25.50')
  form.click()
  assert.equal(form.result().quantity, 12)
  assert.equal(form.result().discountUnitAmount, 25.5)
  assert.equal(form.result().discountPercent, 0)
  assert.equal(form.result().commercialPrice, '7501.5')
})
