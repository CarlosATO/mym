import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/modules/logistica/recepciones/recepciones-panel.tsx', import.meta.url), 'utf8')

test('receipt list exposes the economic difference only with economic access', () => {
  assert.match(panel, /id: 'amountPending', defaultWidth: 125, minWidth: 110, maxWidth: 180/)
  assert.match(panel, /!\['total', 'amountReceived', 'amountPending'\]\.includes\(column\.id\)/)
  assert.match(panel, /canViewEconomics && <th[^>]*>Por recibir c\/IVA\{resizeHandle\('amountPending'\)\}/)
  assert.match(panel, /canViewEconomics && <td className=\{cn\(/)
})

test('difference uses raw economic values, preserves sign, and leaves missing data blank', () => {
  assert.match(panel, /const hasEconomicData = Number\.isFinite\(po\.grand_total\) && Number\.isFinite\(po\.amount_received\)/)
  assert.match(panel, /const amountPending = hasEconomicData \? po\.grand_total - po\.amount_received : null/)
  assert.match(panel, /amountPending > 0[\s\S]*text-amber-600/)
  assert.match(panel, /amountPending < 0[\s\S]*text-red-600/)
  assert.match(panel, /amountPending === null \? '—' : fmt\(amountPending\)/)
  assert.match(panel, /Diferencia entre el valor total de la OC y el valor acumulado de las recepciones\./)
})
