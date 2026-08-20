import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const actionPath = new URL('../src/app/actions/adquisiciones/products.ts', import.meta.url)
const panelPath = new URL('../src/modules/adquisiciones/catalogo/catalog-panel.tsx', import.meta.url)
const [action, panel] = await Promise.all([
  readFile(actionPath, 'utf8'),
  readFile(panelPath, 'utf8'),
])

test('el contrato resuelve Brand a supplier aprobado en lote y por empresa', () => {
  assert.match(action, /schema\('integraciones'\)\.from\('bsale_brand_supplier_links'\)/)
  assert.match(action, /\.eq\('company_id', companyId\)/)
  assert.match(action, /\.in\('bsale_brand_id', bsaleBrandIds\)/)
  assert.match(action, /\.eq\('supplier_kind', 'REAL'\)/)
  assert.match(action, /bsale_supplier_name/)
  assert.doesNotMatch(panel, /getProducts\([^)]*p\.id/)
})

test('la columna usa sólo el contrato Bsale y muestra sus tres estados', () => {
  assert.match(panel, /Proveedor en Bsale/)
  assert.match(panel, /bsale_supplier_link_status === 'LINKED'/)
  assert.match(panel, /Pendiente de vincular/)
  assert.match(panel, /Sin proveedor informado/)
  assert.match(panel, /bsale_supplier_name/)
})

test('Proveedor Real actual permanece independiente y no hay fallback operativo', () => {
  assert.match(panel, /p\.real_supplier_name/)
  assert.match(panel, /p\.supplier_origin_label/)
  assert.doesNotMatch(panel, /bsale_supplier_name \|\| p\.real_supplier_name/)
  assert.doesNotMatch(panel, /bsale_supplier_name \|\| p\.product_type/)
  assert.doesNotMatch(panel, /bsale_supplier_name \|\| p\.pseudo_supplier_name/)
})

test('la búsqueda incluye suppliers vinculados sin reemplazar la búsqueda general', () => {
  assert.match(action, /ilike\('business_name'/)
  assert.match(action, /bsale_brand_id\.in\.\(\$\{linkedSearchBrandIds\.join\('\,'\)\}\)/)
  assert.match(panel, /Buscar por SKU, descripción, proveedor en Bsale o categoría/)
})

test('la tabla conserva scroll responsive y la exportación incluye el proveedor Bsale', () => {
  assert.match(panel, /min-w-\[1500px\]/)
  assert.match(panel, /proveedor_en_bsale/)
})

test('sorting conserva filtros y sólo expone columnas SQL soportables', () => {
  assert.match(action, /sortBy\?: ProductSortKey/)
  assert.match(action, /PRODUCT_SORT_COLUMNS/)
  assert.match(action, /\.order\(PRODUCT_SORT_COLUMNS\[sortBy\]/)
  assert.match(action, /\.range\(from, to\)/)
  assert.match(panel, /id: 'sku'.*sortable: true/)
  assert.match(panel, /id: 'min-stock'.*sortKey: 'min_stock'.*sortType: 'number'/)
  assert.doesNotMatch(panel, /id: 'bsale-supplier'.*sortable: true/)
  assert.doesNotMatch(panel, /id: 'real-supplier'.*sortable: true/)
})
