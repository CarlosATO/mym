import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUnassignedSalesFamilyGroup, normalizeSalesFamilies } from '../src/lib/control-financiero/statement.ts'

const family = (family_key, family_name, months, ytd = Object.values(months).reduce((sum, value) => sum + Number(value), 0)) => ({
  family_key,
  family_name,
  months,
  ytd: String(ytd),
  line_count: 1,
})

test('agrupa dos o mas familias por prefijo y conserva los hijos fuente', () => {
  const result = normalizeSalesFamilies([
    family('product_type:acws/alimento', 'ACWS/ALIMENTO', { '1': '100', '2': '20' }),
    family('product_type:acws/higiene', 'ACWS/HIGIENE', { '1': '50' }),
    family('product_type:acws/transporte', 'ACWS/TRANSPORTE', { '1': '10' }),
    family('product_type:acws/trasporte', 'ACWS/TRASPORTE', { '2': '-5' }),
  ], [{ source_prefix: 'ACWS', normalized_name: 'ACWS', active: true }])

  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].group_key, 'prefix:acws')
  assert.deepEqual(result.groups[0].children.map(child => child.detail_name), ['ALIMENTO', 'HIGIENE', 'TRANSPORTE', 'TRASPORTE'])
  assert.deepEqual(result.groups[0].children.map(child => child.family_key), [
    'product_type:acws/alimento',
    'product_type:acws/higiene',
    'product_type:acws/transporte',
    'product_type:acws/trasporte',
  ])
  assert.deepEqual(result.groups[0].months, { '1': '160', '2': '15' })
  assert.equal(result.groups[0].ytd, '175')
})

test('mantiene una familia unica como concepto individual', () => {
  const result = normalizeSalesFamilies([
    family('product_type:solo/detalle', 'SOLO/DETALLE', { '1': '20' }),
    family('product_type:plain', 'PLAIN', { '1': '5' }),
  ], [])

  assert.equal(result.groups.length, 0)
  assert.deepEqual(result.individuals.map(item => item.family_name), ['PLAIN', 'SOLO/DETALLE'])
})

test('aplica fallback determinista cuando no hay reglas persistidas', () => {
  const result = normalizeSalesFamilies([
    family('product_type:acws/alimento', 'ACWS/ALIMENTO', { '1': '10' }),
    family('product_type:acws/higiene', 'ACWS/HIGIENE', { '1': '5' }),
    family('product_type:solo', 'SOLO', { '1': '3' }),
  ], [])

  assert.deepEqual(result.groups.map(group => group.group_name), ['ACWS'])
  assert.deepEqual(result.individuals.map(item => item.family_name), ['SOLO'])
})

test('una regla persistida incorpora futuras familias del mismo prefijo', () => {
  const result = normalizeSalesFamilies([
    family('product_type:belcando/alimento', 'BELCANDO/ALIMENTO', { '1': '10' }),
    family('product_type:belcando/nueva linea', 'BELCANDO/NUEVA LINEA', { '1': '7' }),
  ], [{ source_prefix: 'BELCANDO', normalized_name: 'BELCANDO', active: true }])

  assert.equal(result.groups[0].children.length, 2)
  assert.equal(result.groups[0].ytd, '17')
})

test('reglas de otro prefijo no afectan la familia actual', () => {
  const result = normalizeSalesFamilies([
    family('product_type:acws/alimento', 'ACWS/ALIMENTO', { '1': '10' }),
    family('product_type:belcando/snack', 'BELCANDO/SNACK', { '1': '7' }),
  ], [{ source_prefix: 'BELCANDO', normalized_name: 'BELCANDO', active: true }])

  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].group_name, 'BELCANDO')
  assert.deepEqual(result.individuals.map(item => item.family_name), ['ACWS/ALIMENTO'])
})

test('la misma regla puede aislarse por empresa y no doble cuenta hijos', () => {
  const families = [
    family('product_type:acws/alimento', 'ACWS/ALIMENTO', { '1': '10' }),
    family('product_type:acws/higiene', 'ACWS/HIGIENE', { '1': '5' }),
    family('product_type:solo', 'SOLO', { '1': '3' }),
  ]
  const caylo = normalizeSalesFamilies(families, [{ source_prefix: 'ACWS', normalized_name: 'ACWS', active: true }])
  const otherCompany = normalizeSalesFamilies(families, [])

  assert.equal(caylo.groups[0].ytd, '15')
  assert.equal(caylo.individuals[0].ytd, '3')
  assert.equal(Number(caylo.groups[0].ytd) + Number(caylo.individuals[0].ytd), 18)
  assert.equal(otherCompany.groups.length, 1)
  assert.equal(otherCompany.groups[0].group_name, 'ACWS')
  assert.equal(otherCompany.individuals.length, 1)
})

test('consolida individuales en SIN AGRUPACIÓN sin alterar sus claves fuente', () => {
  const group = buildUnassignedSalesFamilyGroup([
    family('product_type:plain-b', 'PLAIN B', { '1': '20' }),
    family('product_type:plain-a', 'PLAIN A', { '1': '5', '2': '3' }),
  ])

  assert.equal(group.group_key, 'synthetic:unassigned')
  assert.equal(group.group_name, 'SIN AGRUPACIÓN')
  assert.deepEqual(group.months, { '1': '25', '2': '3' })
  assert.equal(group.ytd, '28')
  assert.deepEqual(group.children.map(child => child.family_name), ['PLAIN A', 'PLAIN B'])
  assert.deepEqual(group.children.map(child => child.family_key), ['product_type:plain-a', 'product_type:plain-b'])
})
