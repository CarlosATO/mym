import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  isPreparationCardBlockedForSync,
} from '../src/modules/logistica/preparacion-pedidos/preparation-line-validation.ts'

const root = process.cwd()
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

const line = (overrides = {}) => ({
  id: 'line-1',
  company_id: 'comp-1',
  card_id: 'card-1',
  bsale_nv_id: 1001,
  bsale_detail_id: 5001,
  bsale_variant_id: 9001,
  sku: 'SKU-1',
  product_name: 'Producto 1',
  requested_quantity: 5,
  prepared_quantity: 5,
  line_status: 'CONFIRMED',
  excluded_from_dispatch: false,
  confirmed_by: 'user-1',
  confirmed_at: '2026-11-20T08:00:00Z',
  ...overrides,
})

test('1. botón Sincronizar aparece en tarjetas IN_PREPARATION bloqueadas por incidencias abiertas', () => {
  assert.equal(isPreparationCardBlockedForSync({
    cardStatus: 'IN_PREPARATION',
    openCommercialIncidentCount: 1,
    commercialAlertStatus: 'UNCHANGED',
  }), true)
})

test('2. botón Sincronizar aparece en tarjetas IN_PREPARATION bloqueadas por diferencias comerciales o verificación fallida', () => {
  for (const status of ['CHANGED', 'UNAVAILABLE', 'AMBIGUOUS', 'INCOMPLETE']) {
    assert.equal(isPreparationCardBlockedForSync({
      cardStatus: 'IN_PREPARATION',
      openCommercialIncidentCount: 0,
      commercialAlertStatus: status,
    }), true, `debe mostrarse para status=${status}`)
  }
})

test('3. botón Sincronizar aparece en drawer cuando hay faltante parcial o línea excluida', () => {
  assert.equal(isPreparationCardBlockedForSync({
    cardStatus: 'IN_PREPARATION',
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    lines: [line({ requested_quantity: 5, prepared_quantity: 3, line_status: 'INCIDENT' })],
  }), true)

  assert.equal(isPreparationCardBlockedForSync({
    cardStatus: 'IN_PREPARATION',
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    lines: [line({ requested_quantity: 5, prepared_quantity: 0, line_status: 'INCIDENT', excluded_from_dispatch: true })],
  }), true)
})

test('4. botón Sincronizar NO aparece en tarjetas normales sin bloqueo ni en otros estados', () => {
  assert.equal(isPreparationCardBlockedForSync({
    cardStatus: 'IN_PREPARATION',
    openCommercialIncidentCount: 0,
    commercialAlertStatus: 'UNCHANGED',
    lines: [line(), line({ id: 'line-2', prepared_quantity: null, line_status: 'PENDING' })],
  }), false)

  for (const status of ['PENDING_ROUTE_PREP', 'IN_AUDIT', 'AUDITED', 'INVOICED_READY_FOR_ROUTE']) {
    assert.equal(isPreparationCardBlockedForSync({
      cardStatus: status,
      openCommercialIncidentCount: 2,
      commercialAlertStatus: 'CHANGED',
    }), false, `no debe mostrarse en status=${status}`)
  }
})

test('5. server action reutiliza motor Bsale existente, protege concurrencia y NO cambia estado ni cierra incidencias', () => {
  const src = read('src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
  const fnStart = src.indexOf('export async function syncSalesOrderPreparationCardFromBsale')
  assert.ok(fnStart !== -1, 'debe exportar syncSalesOrderPreparationCardFromBsale')
  const fnBody = src.slice(fnStart)

  // Reutiliza motor Bsale existente y lock operativo compartido
  assert.match(fnBody, /createBsalePreparationCommercialProvider\(\)\.getCurrentVersion/)
  assert.match(fnBody, /hydrateBsaleDocumentsById\(/)
  assert.match(fnBody, /mapBsaleDocument\(/)
  assert.match(fnBody, /mapBsaleDocumentDetails\(/)
  assert.match(fnBody, /replaceBsaleDocumentSnapshot\(/)
  assert.match(fnBody, /acquireOperationalBsaleSyncLock\(auth\.companyId,\s*operationalLockName/)
  assert.match(fnBody, /releaseOperationalBsaleSyncLock\(auth\.companyId,\s*'bsale_operational_prep_sync'/)

  // Concurrencia y aislamiento de errores
  assert.match(fnBody, /inFlightCardSyncs\.has\(inFlightKey\)/)
  assert.match(fnBody, /status:\s*'IN_PROGRESS'/)
  assert.match(fnBody, /status:\s*'CONFLICT'/)
  assert.match(fnBody, /finishBsaleRun\(runId,\s*'FAILED'/)
  assert.match(fnBody, /inFlightCardSyncs\.delete\(inFlightKey\)/)

  // Reglas estrictas: NO actualizar status directamente, NO aceptar cambios comerciales, NO cerrar incidencias
  assert.doesNotMatch(fnBody, /status:\s*'IN_AUDIT'/)
  assert.doesNotMatch(fnBody, /accept_sales_order_preparation_commercial_changes/)
  assert.doesNotMatch(fnBody, /verify_open_preparation_incidents_v1/)
  assert.doesNotMatch(fnBody, /\.delete\(\)/)
})

test('6. contratos UI: doble clic protegido, stopPropagation, feedback sin perder estado y refresh live sin caché', () => {
  const cardSrc = read('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx')
  const drawerSrc = read('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx')
  const panelSrc = read('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx')
  const alertsSrc = read('src/modules/logistica/preparacion-pedidos/use-preparation-commercial-alerts.ts')

  assert.match(cardSrc, /isPreparationCardBlockedForSync/)
  assert.match(cardSrc, /disabled=\{isSyncingCard \|\| isPending\}/)
  assert.match(cardSrc, /Sincronizando…/)

  assert.match(drawerSrc, /isPreparationCardBlockedForSync/)
  assert.match(drawerSrc, /handleManualCardSync/)
  assert.match(drawerSrc, /cardSyncFeedback/)

  assert.match(panelSrc, /syncingCardIdsRef\.current\.has\(card\.card_id\)/)
  assert.match(panelSrc, /syncSalesOrderPreparationCardFromBsale\(card\.card_id\)/)
  assert.match(panelSrc, /checkCommercialAlertNow\(card\.card_id\)/)

  assert.match(alertsSrc, /getSalesOrderPreparationCommercialAlert\(card\.card_id,\s*force \? \{ bypassCache: true \} : undefined\)/)
})
