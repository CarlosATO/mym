import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const { buildRouteGuideWhatsAppSummary, copyRouteGuideWhatsAppSummary } = await import('../src/modules/logistica/guias-ruta/utils/route-guide-whatsapp.ts')
const imageSource = await readFile(new URL('../src/modules/logistica/guias-ruta/utils/route-guide-whatsapp-images.ts', import.meta.url), 'utf8')
const detailPanelSource = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-detail-panel.tsx', import.meta.url), 'utf8')

const guide = {
  guide_number: 'GR-2026-000009',
  guide_date: '2026-08-27',
  route_name_snapshot: 'PICHILEMU - BUCALEMU - PAREDONES',
  total_invoices: 2,
  total_amount: 200000,
  items: [
    { invoice_number: '23938', customer_name: 'Veterinaria Bucalemu Bucavet', customer_address: 'CELEDONIO PASTENE S/N', commune: 'BUCALEMU', amount: 102827, payment_method_original: 'Al día', payment_method_normalized: 'AL_DIA' },
    { invoice_number: '23941', customer_name: 'Daniela Saldaña', customer_address: 'AV. DE MOORE 54', commune: 'PAREDONES', amount: 42172, payment_method_original: 'CREDITO 12 DIAS', payment_method_normalized: 'CREDIT' },
  ],
}

const profitability = {
  sales_net_total: 145000,
  last_purchase_cost_total: 118000,
  estimated_gross_profit: 27000,
  estimated_margin_pct: 18.62,
  cost_coverage_pct: 100,
  lines: [
    { document: '23938', net_sales: 90000, estimated_profit: 18450, cost_status: 'COSTED' },
    { document: '23941', net_sales: 55000, estimated_profit: 7980, cost_status: 'COSTED' },
  ],
}

test('genera una línea por factura y utilidad por suma de líneas', () => {
  const text = buildRouteGuideWhatsAppSummary(guide, profitability)
  assert.match(text, /23938 \| Veterinaria Bucalemu Bucavet \| CELEDONIO PASTENE S\/N - BUCALEMU \| \$102\.827 \| Utilidad \$18\.450 \| Ganancia 20,50% \| Al día/)
  assert.match(text, /23941 \| Daniela Saldaña \| AV\. DE MOORE 54 - PAREDONES \| \$42\.172 \| Utilidad \$7\.980 \| Ganancia 14,51% \| CREDITO 12 DIAS/)
  assert.doesNotMatch(text, /parcial/i)
})

test('marca sólo la utilidad de la factura con venta SIN_COSTO positiva', () => {
  const text = buildRouteGuideWhatsAppSummary(guide, {
    ...profitability,
    lines: [
      ...profitability.lines,
      { document: '23941', net_sales: 1000, estimated_profit: null, cost_status: 'SIN_COSTO' },
    ],
  })
  assert.match(text, /23941 \| Daniela Saldaña .* Ganancia 14,25%/)
  assert.doesNotMatch(text, /parcial/i)
})

test('el resumen usa los totales de Rentabilidad V1', () => {
  const text = buildRouteGuideWhatsAppSummary(guide, profitability)
  assert.match(text, /Documentos: 2/)
  assert.match(text, /Venta neta: \$145\.000/)
  assert.match(text, /Costo: \$118\.000/)
  assert.match(text, /Utilidad estimada: \$27\.000/)
  assert.match(text, /Margen estimado: 18,62%/)
  assert.doesNotMatch(text, /Cobertura de costo/i)
})

test('Copiar entrega al Clipboard exactamente el texto generado', async () => {
  const expected = buildRouteGuideWhatsAppSummary(guide, profitability)
  let copied = null
  const clipboard = { writeText: async text => { copied = text } }
  const returned = await copyRouteGuideWhatsAppSummary(clipboard, guide, profitability)
  assert.equal(copied, expected)
  assert.equal(returned, expected)
})

test('WhatsApp prepara una sola imagen de detalle amplia, sin cobertura ni estado parcial', () => {
  assert.match(imageSource, /detail: Blob/)
  assert.doesNotMatch(imageSource, /summarySvg|Cobertura de costo|parcial/i)
  assert.match(imageSource, /GANANCIA %/)
  assert.doesNotMatch(detailPanelSource, /Imagen 1|Descargar ambas|images\.summary/)
  assert.match(detailPanelSource, /Detalle operativo/)
})
