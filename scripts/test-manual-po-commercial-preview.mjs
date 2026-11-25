import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/adquisiciones/purchase-units.ts', import.meta.url), 'utf8')

test('manual product preview resolves commercial data with company and permission checks', () => {
  assert.match(action, /authorize\('adquisiciones\.products\.view'\)/)
  assert.match(action, /resolvePurchaseCommercial\(db\(\), authorization\.companyId, productId, supplierId\)/)
  assert.match(panel, /getPurchaseCommercialForManualOrder\(p\.id, form\.supplier_id\)/)
  assert.match(panel, /request !== commercialRequestRef\.current/)
  assert.match(panel, /Presentación de compra pendiente de configurar/)
})

test('unsaved commercial previews cannot emit', () => {
  assert.match(panel, /const hasCommercialPreview = isCommercialDraft \|\| items\.some\(item => item\.commercial_factor !== undefined\)/)
  assert.match(panel, /disabled=\{isSubmitting \|\| \(hasCommercialPreview && !isCommercialDraft\)/)
  assert.match(panel, /items\.some\(item => item\.commercial_factor !== undefined\)[\s\S]*?Guarda el borrador comercial antes de emitir/)
  assert.match(panel, /commercial_price_raw: pendingCommercialPrice/)
})

test('saved commercial drafts keep a distinct save action and pending-change indicator', () => {
  assert.match(panel, /isCommercialDraft \? 'Guardar cambios' : 'Guardar borrador'/)
  assert.match(panel, /editId && !isCommercialDraft \? 'Guardar cambios' : 'Emitir OC'/)
  assert.match(panel, /hasCommercialChanges\(savedCommercialSnapshot, form, items\)/)
  assert.match(panel, /Cambios pendientes de guardar/)
  assert.match(panel, /await syncCommercialOrder\(result\.data\.po_id\)/)
  assert.match(panel, /setEditingPoCorrelative\(refreshedDetail\.po\.correlative\)/)
  assert.match(panel, /setSavedCommercialSnapshot\(d\.savedCommercialSnapshot \?\? null\)/)
})

test('invalid commercial quantities are highlighted and save errors are visible', () => {
  assert.match(panel, /No se pudo guardar la OC\. Existen cantidades que no respetan las unidades de compra/)
  assert.match(panel, /role="alert"[^>]*>\{commercialSaveError\}/)
  assert.match(panel, /aria-invalid=\{Boolean\(it\.commercial_factor && it\.quantity > 0 && !isPurchaseMultiple\(String\(it\.quantity\), it\.commercial_factor\)\)\}/)
  assert.match(panel, /field === 'quantity' \|\| field === 'commercial_quantity_raw'\) setCommercialSaveError\(''\)/)
  assert.match(panel, /setCommercialSaveError\(`No se pudo guardar la OC\./)
})

test('quantity and price fields remain editable after adding, and invalid multiples are displayed', () => {
  assert.match(panel, /aria-label=\{`Cantidad comercial \$\{it\.description\}`\}/)
  assert.match(panel, /aria-label=\{`Precio comercial \$\{it\.description\}`\}/)
  assert.match(panel, /Debe ser múltiplo de \{it\.commercial_factor\}/)
  assert.match(panel, /commercial_quantity_raw: convertedDisplay/)
  assert.match(panel, /commercial_price_raw: convertedDisplay/)
})

test('server draft connection retains pending request and line identities across retries', () => {
  assert.match(panel, /navigator\.locks\.request\(`\$\{draftStorageKey\}:commercial-save`/)
  assert.match(panel, /localStorage\.setItem\(pendingKey, JSON\.stringify\(attempt\)\)/)
  assert.match(panel, /const result = await saveCommercialDraft\(attempt\.request\)/)
  assert.match(panel, /persistedId: saved\.id/)
  assert.match(panel, /commercialRevision: result\.data\.revision/)
  assert.match(panel, /Continúa el borrador y vuelve a guardar antes de descartarlo/)
})
