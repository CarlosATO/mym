import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const hookSource = await readFile(new URL('src/modules/logistica/preparacion-pedidos/use-preparation-commercial-alerts.ts', root), 'utf8')
const panelSource = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')

test('1. in-flight timestamping previene llamadas concurrentes redundantes para la misma tarjeta', () => {
  // Debe marcar checkedAtRef inmediatamente al iniciar checkCard
  assert.match(hookSource, /checkedAtRef\.current\.set\(card\.card_id,\s*now\)/)
  // Debe respetar TTL de 30s
  assert.match(hookSource, /if \(!force && now - checkedAt < PREPARATION_COMMERCIAL_CACHE_TTL_MS\) return/)
})

test('2. visibilitychange respeta el TTL de 30 segundos sin forzar ráfagas masivas', () => {
  // handleVisibilityChange debe llamar checkVisibleCards(false)
  assert.match(hookSource, /if \(document\.visibilityState === 'visible'\)\s*void checkVisibleCards\(false\)/)
  assert.doesNotMatch(hookSource, /visibilitychange[\s\S]*?checkVisibleCards\(true\)/)
})

test('3. Priorización operacional: el Drawer abierto evita saturación de tarjetas ajenas', () => {
  // Cuando isDrawerOpen y activeCardId están presentes, solo se verifica la tarjeta activa
  assert.match(hookSource, /if \(isDrawerOpen && activeCardId\)/)
  assert.match(hookSource, /const activeCard = operational\.find\(c => c\.card_id === activeCardId\)/)
  assert.match(panelSource, /const isDrawerOpen = Boolean\(selectedCard\)/)
  assert.match(panelSource, /usePreparationCommercialAlerts\(cards,\s*\{[\s\S]*?activeCardId:\s*selectedCard\?\.card_id[\s\S]*?isDrawerOpen/)
})

test('4. maybeAutoSync cuenta con throttle global de 30s contra sincronizaciones en ráfaga', () => {
  // Debe verificar el intervalo de 30s para evitar dobles ejecuciones consecutivas
  assert.match(panelSource, /if \(now - lastAutoAttemptAtRef\.current < 30_000\) return/)
  assert.match(panelSource, /lastAutoAttemptAtRef\.current = now/)
})

test('5. La aceptación comercial exitosa continúa limpiando y actualizando la alerta de la tarjeta', () => {
  assert.match(panelSource, /const handleCommercialAcceptanceSuccess = \(cardId: string\) =>/)
  assert.match(panelSource, /clearCommercialAlert\(cardId\)/)
  assert.match(hookSource, /clearCard,/)
  assert.match(hookSource, /checkCardNow,/)
})
