import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/lib/pdf/generate-route-guide-pdf.ts', import.meta.url), 'utf8')

test('el detalle PDF de Guía contiene sólo columnas operacionales', () => {
  assert.match(source, /#.*Factura.*Cliente.*Dirección.*Comuna.*Monto.*Forma Pago.*Obs\./)
  assert.doesNotMatch(source, /Utilidad|Ganancia|Margen|Costo|Cobertura|Rentabilidad V1|COMPLETE|PARTIAL|SIN_COSTO|Parcial/)
  assert.match(source, /\['#', 'Factura', 'Cliente', 'Dirección', 'Comuna', 'Monto', 'Forma Pago', 'Obs\.'\]/)
  assert.match(source, /validItems\.map\(\(item, index\) => \[/)
  assert.match(source, /String\(index \+ 1\)/)
  assert.match(source, /item\.customer_address\?\.trim\(\) \|\| '-'/)
  assert.match(source, /item\.commune\?\.trim\(\) \|\| '-'/)
  assert.match(source, /item\.notes \|\| ''/)
})

test('la tabla redistribuye espacio en ambas orientaciones y alinea monto', () => {
  assert.match(source, /\? \[12, 22, 39, 57, 30, 29, 35, 43\]/)
  assert.match(source, /: \[10, 18, 27, 37, 22, 20, 25, 21\]/)
  assert.match(source, /5: \{ halign: 'right', cellWidth: tableColumnWidths\[5\] \}/)
  assert.match(source, /6: \{ halign: 'center', cellWidth: tableColumnWidths\[6\] \}/)
  assert.match(source, /7: \{ cellWidth: tableColumnWidths\[7\] \}/)
  assert.match(source, /orientation: RouteGuidePdfOrientation = 'landscape'/)
})

test('el resumen y los totales conservan sólo información operativa', () => {
  for (const label of ['Efectivo esperado', 'Cheques esperados', 'Crédito', 'Transferencia', 'Monto total ruta', 'Total a rendir']) {
    assert.match(source, new RegExp(label))
  }
  assert.doesNotMatch(source, /Venta neta|Utilidad estimada|Margen estimado|Costo|Cobertura/)
})

test('el PDF no recibe ni propaga rentabilidad V1', async () => {
  assert.doesNotMatch(source, /RouteGuideProfitabilityV1|profitability/)
  const detail = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-detail-panel.tsx', import.meta.url), 'utf8')
  assert.match(detail, /generateRouteGuidePdfBlob\(guide, undefined, undefined, pdfOrientation\)/)
  assert.match(detail, /downloadRouteGuidePdf\(guide, `Guia_\$\{guide\.guide_number\}`, pdfOrientation\)/)
  const form = await readFile(new URL('../src/modules/logistica/guias-ruta/components/route-guide-form.tsx', import.meta.url), 'utf8')
  assert.match(form, /useState<RouteGuidePdfOrientation>\('landscape'\)/)
  assert.match(form, /<option value="portrait">Vertical<\/option>/)
  assert.match(form, /<option value="landscape">Horizontal<\/option>/)
})
