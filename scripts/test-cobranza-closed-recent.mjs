import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-workflow.ts', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')

test('A/B: CLOSED reciente usa ventana inclusiva de 7 días', () => {
  assert.match(action, /stage', 'CLOSED'/)
  assert.match(action, /event_type', 'PAYMENT_CLOSED'/)
  assert.match(action, /7 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(action, /gte\('created_at', cutoff\)/)
})
test('C: cierres fuera de ventana no se devuelven', () => assert.match(action, /const cutoff = new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)/))
test('D: deuda vigente excluye el cerrado del Kanban', () => assert.match(view, /activeClientIds\.has\(client\.clientId\)/))
test('E: cerrados recientes no contaminan KPIs de deuda', () => {
  assert.match(view, /calculateCobranzaClientKpis\(visibleClients\)/)
  assert.match(view, /calculateCobranzaInvoiceKpis\(visibleInvoices\)/)
  assert.match(view, /visibleClosedRecent/)
})
test('F: tarjeta cerrada no tiene pago ni prioridad', () => {
  assert.match(view, /Saldo \$0/)
  assert.match(view, /Cerrado \{dateTimeLabel\(client\.closedAt\)\}/)
  assert.match(view, /Ver bitácora/)
  assert.match(view, /stage\.key === 'CLOSED'\s*\n\s*\? closedRecent\.map/)
})
test('G: buscador incluye nombre y código del cerrado', () => assert.match(view, /normalize\(`\$\{client\.name\} \$\{client\.code \?\? ''\}`\)/))
test('H: CLOSED no es destino de drag manual', () => {
  assert.match(view, /disabled: stage\.key === 'CLOSED'/)
  assert.match(view, /nextStage === 'CLOSED'/)
})
test('I: se usa el PAYMENT_CLOSED más reciente', () => {
  assert.match(action, /latestByClient = new Map/)
  assert.match(action, /if \(!latestByClient\.has\(clientId\)\)/)
  assert.match(action, /order\('created_at', \{ ascending: false \}\)/)
})
test('panel cerrado es histórico y oculta acciones de pago/documentos', () => {
  assert.match(view, /historicalClosed\?\.closedAt/)
  assert.match(view, /!isHistoricalClosed && <div className="grid grid-cols-2/)
  assert.match(view, /!isHistoricalClosed && pendingDocuments\.length >= 2/)
  assert.match(view, /!isHistoricalClosed && <button type="button" disabled=\{paymentBusy\}/)
  assert.match(view, /!isHistoricalClosed && <div className="mt-5 border/)
  assert.match(view, /stage=\{selectedClosed \? 'CLOSED'/)
})
