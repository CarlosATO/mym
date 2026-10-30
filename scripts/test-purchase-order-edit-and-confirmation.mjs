import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url)
const actionsPath = new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url)

const [panel, actions] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(actionsPath, 'utf8'),
])

test('canEditPurchaseOrder allows editing for BORRADOR and EMITIDA without receipts', () => {
  assert.match(panel, /function canEditPurchaseOrder/)
  assert.match(panel, /po\.status === 'BORRADOR'/)
  assert.match(panel, /po\.status === 'EMITIDA' && \(po\.receipt_status === 'PENDIENTE' \|\| !po\.receipt_status\)/)
})

test('edit button appears in table row and drawer detail panel for editable orders', () => {
  // Table row
  assert.match(panel, /canEditPurchaseOrder\(po\)/)
  assert.match(panel, /onClick=\{\(\) => editPO\(po\)\}/)
  // Drawer detail panel
  assert.match(panel, /canEditPurchaseOrder\(detail\.po as PurchaseOrder\)/)
  assert.match(panel, /Editar OC/)
})

test('Enter key does not submit form and navigates product addition inputs', () => {
  // Form prevents default on Enter
  assert.match(panel, /if \(e\.key === 'Enter' && \(e\.target as HTMLElement\)\.tagName === 'INPUT'\) \{\s*e\.preventDefault\(\)/)
  // Quantity input Enter advances to unit price
  assert.match(panel, /pendingUnitPriceInputRef\.current\?\.focus\(\)/)
  assert.match(panel, /pendingUnitPriceInputRef\.current\?\.select\(\)/)
  // Unit price Enter triggers addProductToItems
  assert.match(panel, /addProductToItems\(\)/)
})

test('confirmation modal asks for confirmation before emitting or saving changes', () => {
  assert.match(panel, /const \[confirmSubmitOpen, setConfirmSubmitOpen\] = useState\(false\)/)
  assert.match(panel, /function handlePromptSubmit/)
  assert.match(panel, /setConfirmSubmitOpen\(true\)/)
  assert.match(panel, /Confirmar emisión de OC/)
  assert.match(panel, /Confirmar actualización/)
  assert.match(panel, /executeSubmit\(\)/)
})

test('backend updateDraftPurchaseOrder permits updating EMITIDA orders without receipts', () => {
  assert.match(actions, /if \(existing\.status !== 'BORRADOR' && existing\.status !== 'EMITIDA'\)/)
  assert.match(actions, /from\('purchase_receipts'\)/)
  assert.match(actions, /neq\('status', 'CANCELLED'\)/)
  assert.match(actions, /No se puede editar una orden de compra que ya cuenta con recepciones registradas/)
})

