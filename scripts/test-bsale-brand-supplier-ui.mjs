import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/proveedores/bsale-brand-supplier-panel.tsx', import.meta.url)
const suppliersPath = new URL('../src/modules/adquisiciones/proveedores/suppliers-panel.tsx', import.meta.url)
const [panel, suppliers] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(suppliersPath, 'utf8'),
])

test('Proveedor en Bsale se integra como tab separado de reales y pseudoproveedores', () => {
  assert.match(suppliers, /'REAL' \| 'BSALE' \| 'BSALE_BRANDS'/)
  assert.match(suppliers, /Proveedor en Bsale/)
  assert.match(suppliers, /<BsaleBrandSupplierPanel canWrite=\{canManageBsale\} \/>/)
})

test('el listado usa candidatos backend y muestra evidencia de cobertura', () => {
  assert.match(panel, /listBsaleBrandSupplierCandidates/)
  assert.match(panel, /Brand Bsale/)
  assert.match(panel, /Proveedor candidato/)
  assert.match(panel, /Productos cubiertos/)
  assert.match(panel, /resolved_preferred_products/)
  assert.match(panel, /toLocaleString\('es-CL'/)
})

test('representa estados y clasificaciones sin cambiar su semántica', () => {
  assert.match(panel, /LINKED: 'Vinculado'/)
  assert.match(panel, /PENDING: 'Pendiente'/)
  assert.match(panel, /CONFLICT: 'Requiere revisión'/)
  assert.match(panel, /INEQUIVOCO: 'Inequívoco'/)
  assert.match(panel, /CASI_INEQUIVOCO: 'Casi inequívoco'/)
  assert.match(panel, /MIXTO: 'Mixto'/)
  assert.match(panel, /SIN_RESOLVER: 'Sin resolver'/)
})

test('un Brand PENDING con candidato ofrece vincular y usar otro', () => {
  assert.match(panel, /candidate\.derived_status === 'LINKED'/)
  assert.match(panel, /candidate\.candidate_supplier_id && <button onClick=\{\(\) => onLink\(candidate\)\}/)
  assert.match(panel, /Usar otro/)
})

test('un Brand PENDING sin candidato ofrece seleccionar proveedor', () => {
  assert.match(panel, /candidate\.candidate_supplier_id \? 'Usar otro' : 'Seleccionar proveedor'/)
  assert.match(panel, /candidate_supplier_name \?\? '—'/)
})

test('un Brand LINKED muestra proveedor oficial y permite desvincular', () => {
  assert.match(panel, /candidate\.linked_supplier_name \?\? '—'/)
  assert.match(panel, /candidate\.derived_status === 'LINKED' \? <button onClick=\{\(\) => onUnlink\(candidate\)\}/)
  assert.match(panel, /Proveedor vinculado/)
})

test('un Brand CONFLICT no ofrece aprobación rápida del candidato', () => {
  assert.match(panel, /candidate\.derived_status === 'PENDING' && candidate\.candidate_supplier_id/)
  assert.match(panel, /onPick/)
  assert.match(panel, /Requiere revisión/)
})

test('no autoaprueba y exige confirmación antes de link y unlink', () => {
  assert.match(panel, /function openCandidateConfirmation/)
  assert.match(panel, /function confirmLink/)
  assert.match(panel, /Confirmar vínculo/)
  assert.match(panel, /function confirmUnlink/)
  assert.match(panel, /Confirmar desvinculación/)
  assert.match(panel, /linkBsaleBrandSupplier\(/)
  assert.match(panel, /unlinkBsaleBrandSupplier\(/)
})

test('mutation bloquea doble submit y refresca la lista', () => {
  assert.match(panel, /if \(!target \|\| mutation\) return/)
  assert.match(panel, /if \(!unlinkTarget \|\| mutation\) return/)
  assert.match(panel, /setMutation\('LINK'\)/)
  assert.match(panel, /setMutation\('UNLINK'\)/)
  assert.match(panel, /await loadCandidates\(\)/)
})

test('selector manual restringe destino a proveedores REAL activos', () => {
  assert.match(panel, /getSuppliers\(undefined, 'REAL'\)/)
  assert.match(panel, /supplier\.is_active && supplier\.status === 'ACTIVE'/)
  assert.match(panel, /Sólo se muestran proveedores REAL activos/)
  assert.doesNotMatch(panel, /createSupplier\(/)
})

test('permiso de escritura deja la vista en modo lectura', () => {
  assert.match(panel, /!canWrite \? <span className="text-\[10px\] text-theme-text-muted">Solo lectura<\/span>/)
  assert.match(panel, /requiere permiso de actualización de proveedores/)
})

test('incluye estados loading, error, empty y responsive', () => {
  assert.match(panel, /Cargando Brands Bsale/)
  assert.match(panel, /No fue posible cargar la relación Brand\/Proveedor/)
  assert.match(panel, /No hay Brands para mostrar/)
  assert.match(panel, /min-w-\[1080px\]/)
  assert.match(panel, /overflow-x-auto overflow-y-auto/)
})
