import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')

test('nueva OC ofrece flujo tradicional antes de agregar líneas y recupera la elección', () => {
  assert.match(source, /manualOrderMode, setManualOrderMode/)
  assert.match(source, /setManualOrderMode\('traditional'\)/)
  assert.match(source, /disabled=\{items\.length > 0 \|\| Boolean\(pendingProduct\)\}/)
  assert.match(source, /setManualOrderMode\(d\.manualOrderMode \?\? 'commercial'\)/)
  assert.match(source, /savedCommercialSnapshot:[\s\S]*?manualOrderMode,/)
})

test('tradicional usa formulario y emisión tradicionales; comercial requiere borrador', () => {
  assert.match(source, /const showCommercialColumns = \(\(!editId && manualOrderMode === 'commercial'\) \|\| isCommercialDraft\) && !isReplenishmentPreparation/)
  assert.match(source, /pendingProduct && !showCommercialColumns/)
  assert.match(source, /!editId && showCommercialColumns/)
  assert.match(source, /editId \? await updateDraftPurchaseOrder\(editId, payload\) : await createPurchaseOrder\(payload\)/)
  assert.match(source, /items\.some\(item => item\.commercial_factor !== undefined\).*Guarda el borrador comercial antes de emitir/)
})
