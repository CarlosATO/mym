import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/lib/pdf/generate-route-guide-pdf.ts', import.meta.url), 'utf8')

test('el detalle PDF de Guía contiene sólo columnas operacionales', () => {
  assert.match(source, /Factura.*Cliente.*Dirección \/ Ciudad.*Monto.*Condición de venta/)
  assert.doesNotMatch(source, /Utilidad|Ganancia|Margen|Costo|Cobertura|Rentabilidad V1|COMPLETE|PARTIAL|SIN_COSTO|Parcial/)
  assert.match(source, /\['Factura', 'Cliente', 'Dirección \/ Ciudad', 'Monto', 'Condición de venta'\]/)
})

test('la tabla redistribuye espacio en ambas orientaciones y alinea monto', () => {
  assert.match(source, /\? \[27, 70, 78, 30, 55\]/)
  assert.match(source, /: \[25, 43, 48, 24, 40\]/)
  assert.match(source, /3: \{ halign: 'right', cellWidth: tableColumnWidths\[3\] \}/)
  assert.match(source, /4: \{ halign: 'center', cellWidth: tableColumnWidths\[4\] \}/)
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
})
