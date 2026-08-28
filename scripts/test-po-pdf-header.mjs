import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/lib/pdf/generate-po-pdf.ts', import.meta.url), 'utf8')

test('el encabezado de OC usa los datos oficiales de CAYLO PREMIUM SPA', () => {
  for (const value of [
    'CAYLO PREMIUM SPA',
    '77.196.005-7',
    '+56 9 4861 8906',
    'Compras@mympremium.cl',
    'Contacto@mympremium.cl',
  ]) assert.match(source, new RegExp(value.replace(/[+.-]/g, '\\$&')))
  assert.doesNotMatch(source, /DISTRIBUIDORA MYM|76\.123\.456-7|\+56 2 1234 5678|contacto@mym\.cl/)
})

test('los dos correos caben en el encabezado sin aumentarlo', () => {
  assert.match(source, /const headerHeight = 32/)
  assert.match(source, /Compras: \$\{OFFICIAL_PURCHASE_EMAIL\} \| Contacto: \$\{OFFICIAL_CONTACT_EMAIL\}/)
  assert.match(source, /cursorY = headerHeight \+ 8/)
})
