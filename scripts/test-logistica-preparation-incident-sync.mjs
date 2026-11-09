import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation-incident-sync.ts', import.meta.url), 'utf8')
const hydration = await readFile(new URL('../src/lib/integraciones/bsale-document-hydration.ts', import.meta.url), 'utf8')

test('la operación consulta Bsale en vivo y usa la identidad canónica', () => {
  assert.match(action, /createBsalePreparationCommercialProvider\(\)\.getCurrentVersion/)
  assert.match(action, /canonicalToken: cardRow\.canonical_bsale_token/)
  assert.match(action, /AbortSignal\.timeout\(30_000\)/)
  assert.doesNotMatch(action, /useCache|detectPreparationCommercialChange/)
})

test('la operación hidrata cabecera y líneas bajo una misma corrida', () => {
  assert.match(action, /bsale_sync_runs/)
  assert.match(action, /hydrateBsaleDocumentsById/)
  assert.match(action, /replace_bsale_document_snapshot_v1/)
  assert.match(action, /mirror\?\.bsale_sync_run_id !== runId/)
  assert.match(action, /mirrorDetails.*bsale_sync_run_id !== runId/)
  assert.match(action, /persist = false|false\)/)
  assert.match(hydration, /persist = true/)
})

test('la resolución delega en MEJ-01B y no mueve la tarjeta ni la auditoría', () => {
  assert.match(action, /verify_open_preparation_incidents_v1/)
  assert.match(action, /verification_status === 'MATCHED'/)
  assert.doesNotMatch(action, /status:\s*['"]INVOICED_READY_FOR_ROUTE/)
  assert.doesNotMatch(action, /sales_order_audits/)
  assert.doesNotMatch(action, /invoice_attempt|emitInvoice|bsaleWrite/)
})

test('los estados de salida cubren éxito, pendiente, error y repetición', () => {
  for (const status of ['RESOLVED', 'PENDING', 'UNABLE_TO_VERIFY', 'ALREADY_RESOLVED']) assert.match(action, new RegExp(`['"]${status}['"]`))
  assert.match(action, /bsale_operational_prep_sync/)
  assert.match(action, /Ya existe una sincronización de Notas de Venta en curso/)
})

test('la coordinación administrativa comparte el lock del sincronizador general', () => {
  assert.match(action, /acquireOperationalBsaleSyncLock/)
  assert.match(action, /releaseOperationalBsaleSyncLock/)
  assert.match(action, /acquireOperationalBsaleSyncLock\(auth\.companyId, operationalLockName, runId, 10\)/)
  assert.match(action, /releaseOperationalBsaleSyncLock\(auth\.companyId, 'bsale_operational_prep_sync', runId\)/)
})

test('el reemplazo valida identidad y detalles antes de escribir, y completa la corrida al final', () => {
  assert.match(action, /document\.document\.id/)
  assert.match(action, /document\.details\.length/)
  assert.match(action, /replacement\.document_id !== currentBsaleNvId/)
})

test('el fallo de escritura queda dentro del bloque transaccional y no resuelve antes del reemplazo', () => {
  assert.match(action, /replace_bsale_document_snapshot_v1[\s\S]*verify_open_preparation_incidents_v1/)
  assert.ok(action.indexOf('replace_bsale_document_snapshot_v1') < action.indexOf('verify_open_preparation_incidents_v1'))
})

test('las diferencias comparan el conjunto completo por SKU o variante', () => {
  assert.match(action, /new Set\(\[\.\.\.expected\.keys\(\), \.\.\.observed\.keys\(\)\]\)/)
  assert.match(action, /preparedQuantity/)
  assert.match(action, /bsaleQuantity/)
  assert.match(action, /difference/)
})
