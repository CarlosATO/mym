import assert from 'node:assert/strict'
import test from 'node:test'
import { collectBsaleBrandRecords, extractBsaleBrand } from '../src/lib/integraciones/bsale-brand.ts'

test('extrae un Brand válido sin depender de brand.name', () => {
  assert.deepEqual(extractBsaleBrand({ brand: { id: '29', href: 'https://api.bsale.io/v1/brands/29.json' } }), {
    id: 29,
    href: 'https://api.bsale.io/v1/brands/29.json'
  })
})

test('persiste el Brand de un producto nuevo', () => {
  assert.deepEqual(extractBsaleBrand({ brand: { id: 29, href: 'href-29' } }), { id: 29, href: 'href-29' })
})

test('detecta el cambio de Brand 29 a 37', () => {
  const before = extractBsaleBrand({ brand: { id: 29 } })
  const after = extractBsaleBrand({ brand: { id: 37 } })
  assert.notDeepEqual(before, after)
  assert.equal(after.id, 37)
})

test('detecta la eliminación de Brand', () => {
  assert.deepEqual(extractBsaleBrand({ brand: { id: 29 } }), { id: 29, href: null })
  assert.deepEqual(extractBsaleBrand({ brand: null }), { id: null, href: null })
})

test('normaliza id=0 y ausencia de Brand como null', () => {
  assert.deepEqual(extractBsaleBrand({ brand: { id: 0, href: 'ignored' } }), { id: null, href: null })
  assert.deepEqual(extractBsaleBrand({}), { id: null, href: null })
})

test('deduplica una referencia Brand dentro de una empresa', () => {
  const records = collectBsaleBrandRecords([
    { product: { brand: { id: 58, href: 'href-58' } } },
    { product: { brand: { id: '58', href: 'href-58' } } }
  ], 'company-a', '2026-08-19T00:00:00.000Z')
  assert.equal(records.length, 1)
  assert.equal(records[0].bsale_brand_id, 58)
})

test('registra un Brand desconocido sólo como referencia técnica', () => {
  const records = collectBsaleBrandRecords([{ product: { brand: { id: 58 } } }], 'company-a', 'now')
  assert.deepEqual(records.map(({ bsale_brand_id, status }) => ({ bsale_brand_id, status })), [{ bsale_brand_id: 58, status: 'DETECTED' }])
})

test('reutiliza el mismo Brand para un segundo producto', () => {
  const records = collectBsaleBrandRecords([
    { product: { brand: { id: 58 } } },
    { product: { brand: { id: 58 } } }
  ], 'company-a', 'now')
  assert.equal(records.length, 1)
})

test('no registra Sin marca como Brand técnico', () => {
  assert.deepEqual(collectBsaleBrandRecords([
    { product: { brand: { id: 0, href: 'ignored' } } },
    { product: {} }
  ], 'company-a', 'now'), [])
})

test('mantiene aislado el mismo Brand entre empresas', () => {
  const first = collectBsaleBrandRecords([{ product: { brand: { id: 29 } } }], 'company-a', 'now')
  const second = collectBsaleBrandRecords([{ product: { brand: { id: 29 } } }], 'company-b', 'now')
  assert.equal(first[0].company_id, 'company-a')
  assert.equal(second[0].company_id, 'company-b')
})
