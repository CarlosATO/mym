import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelPath = new URL('../src/modules/adquisiciones/proveedores/bsale-brand-supplier-panel.tsx', import.meta.url)
const actionPath = new URL('../src/app/actions/integraciones/bsale-brand-supplier-links.ts', import.meta.url)
const suppliersPath = new URL('../src/modules/adquisiciones/proveedores/suppliers-panel.tsx', import.meta.url)
const [panel, action, suppliers] = await Promise.all([
  readFile(panelPath, 'utf8'),
  readFile(actionPath, 'utf8'),
  readFile(suppliersPath, 'utf8'),
])

test('Proveedor en Bsale se integra como tab separado de reales y pseudoproveedores', () => {
  assert.match(suppliers, /'REAL' \| 'BSALE' \| 'BSALE_BRANDS'/)
  assert.match(suppliers, /Proveedor en Bsale/)
  assert.match(suppliers, /<BsaleBrandSupplierPanel canWrite=\{canManageBsale\} \/>/)
})

test('el listado muestra sólo el modelo operativo vigente', () => {
  assert.match(panel, /listBsaleBrandSupplierCandidates/)
  assert.match(panel, /Brand Bsale/)
  assert.match(panel, /Productos activos/)
  assert.match(panel, /Proveedor REAL/)
  assert.doesNotMatch(panel, /Cobertura|Clasificación|Proveedor candidato|resolved_preferred_products/)
})

test('representa sólo estados derivados del Brand Supplier Link', () => {
  assert.match(panel, /LINKED: 'Vinculado'/)
  assert.match(panel, /PENDING: 'Pendiente'/)
  assert.match(panel, /return candidate\.link_id \? 'LINKED' as const : 'PENDING' as const/)
  assert.doesNotMatch(panel, /CONFLICT|INEQUIVOCO|CASI_INEQUIVOCO|MIXTO|SIN_RESOLVER/)
})

test('un Brand pendiente ofrece seleccionar proveedor', () => {
  assert.match(panel, /currentStatus\(candidate\) === 'LINKED'/)
  assert.match(panel, /Seleccionar proveedor/)
  assert.doesNotMatch(panel, /Usar otro|Vincular<\/button>/)
})

test('un Brand vinculado muestra proveedor REAL y permite desvincular', () => {
  assert.match(panel, /candidate\.linked_supplier_name \?\? '—'/)
  assert.match(panel, /currentStatus\(candidate\) === 'LINKED' \? <button onClick=\{\(\) => onUnlink\(candidate\)\}/)
  assert.match(panel, /Proveedor REAL/)
})

test('no autoaprueba y exige confirmación antes de link y unlink', () => {
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
  assert.match(panel, /min-w-\[980px\]/)
  assert.match(panel, /overflow-x-auto overflow-y-auto/)
})

test('el doble clic abre el detalle y no se dispara desde controles de acción', () => {
  assert.match(panel, /onDoubleClick=\{event => \{ if \(\(event\.target as Element\)\.closest\('button, select, a, input, textarea'\)\) return; onDetails\(\) \}\}/)
  assert.match(panel, /Productos asociados — Brand \$\{brand\.bsale_brand_id\}/)
  assert.match(panel, /listBsaleBrandProducts\(brand\.bsale_brand_id\)/)
})

test('el detalle consulta todos los productos del Brand sin mostrar información legado', () => {
  assert.match(action, /\.eq\('bsale_brand_id', bsaleBrandId\)/)
  assert.doesNotMatch(action, /product_supplier_mappings|is_preferred|parent_supplier_id/)
  assert.match(panel, /Todos los productos asociados al Brand\./)
  assert.match(panel, /Proveedor REAL/)
  assert.match(panel, /Estado de resolución/)
  assert.doesNotMatch(panel, /mapping|preferred|BSALE_OPERATIVE|parent_supplier_id/)
})
