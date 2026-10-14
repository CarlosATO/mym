import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261014190000_collection_payment_worker.sql', import.meta.url), 'utf8')
const worker = await readFile(new URL('../src/lib/comercial/collection-payment-worker.ts', import.meta.url), 'utf8')
const route = await readFile(new URL('../src/app/api/cron/collection-payment-worker/route.ts', import.meta.url), 'utf8')
const middleware = await readFile(new URL('../src/middleware.ts', import.meta.url), 'utf8')

test('claim es ASYNC_V1, atómico y globalmente serializado', () => {
  assert.match(migration, /claim_collection_payment_batch/)
  assert.match(migration, /FOR UPDATE SKIP LOCKED/)
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('collection-payment-worker'/)
  assert.match(migration, /metadata->>'execution_mode' = 'ASYNC_V1'/)
  assert.match(migration, /lease_expires_at > v_now/)
  assert.match(migration, /RETURN jsonb_build_object\('processed', false, 'reason', 'BUSY'/)
})

test('claim conserva processing_started_at y usa lease 120s', () => {
  assert.match(migration, /COALESCE\(processing_started_at, v_now\)/)
  assert.match(worker, /const LEASE_SECONDS = 120/)
  assert.match(migration, /worker_token = v_token/)
})

test('claim BUSY impide entregar CREATED mientras otro ASYNC tiene lease vigente', () => {
  assert.match(migration, /status = 'PROCESSING'[\s\S]*metadata->>'execution_mode' = 'ASYNC_V1'[\s\S]*worker_token IS NOT NULL[\s\S]*lease_expires_at > v_now/)
  assert.match(migration, /reason', 'BUSY'/)
  assert.match(migration, /status = 'CREATED'[\s\S]*status = 'PROCESSING' AND \(lease_expires_at IS NULL OR lease_expires_at <= v_now OR worker_token IS NULL\)/)
})

test('lease vencido permite recuperación y batches síncronos no participan', () => {
  assert.match(migration, /lease_expires_at <= v_now OR worker_token IS NULL/)
  assert.match(migration, /metadata->>'execution_mode' = 'ASYNC_V1'/g)
  assert.doesNotMatch(migration, /status = 'PROCESSING'\s+AND\s+worker_token IS NOT NULL[\s\S]*metadata->>'execution_mode' = 'ASYNC_V1'[\s\S]*registerCollectionCustomerBatch/)
})

test('worker procesa máximo un intento por invocación y respeta secuencia', () => {
  assert.match(worker, /order\('sequence_number', \{ ascending: true \}\)/)
  assert.match(worker, /\.limit\(1\)/)
  assert.match(worker, /status: 'SUBMITTING'/)
  assert.match(worker, /post_started_at/)
})

test('preflight y checkpoint preceden al único POST', () => {
  assert.match(worker, /Saldo Bsale cambió antes del pago\. No se realizó POST\./)
  assert.match(worker, /mark_collection_payment_attempt_submitting/)
  assert.match(worker, /gateway\.createPayment\(\{ \.\.\.requestPayload, recordDate: recordDateUnix \}\)/)
  assert.match(worker, /status: 'UNKNOWN'/)
})

test('checkpoint valida batch, lease, token y attempt en una sola RPC', () => {
  assert.match(migration, /mark_collection_payment_attempt_submitting/)
  assert.match(migration, /a\.batch_id = p_batch_id/)
  assert.match(migration, /a\.status = 'CREATED'/)
  assert.match(migration, /b\.status = 'PROCESSING'/)
  assert.match(migration, /b\.worker_token = p_worker_token/)
  assert.match(migration, /b\.lease_expires_at > v_now/)
  assert.match(worker, /rpc\('mark_collection_payment_attempt_submitting'/)
  assert.match(worker, /STALE_LEASE/)
})

test('restart SUBMITTING nunca ejecuta POST', () => {
  const submitting = worker.slice(worker.indexOf("if (row.status === 'SUBMITTING')"), worker.indexOf('const check = await preflight'))
  assert.doesNotMatch(submitting, /createPayment/)
  assert.match(submitting, /recoverCollectionPayment/)
})

test('confirmed_total se deriva de attempts y el batch libera lease', () => {
  assert.match(worker, /filter\(row => row\.status === 'CONFIRMED'\)\.reduce/)
  assert.match(worker, /confirmed_total: confirmedTotal/)
  assert.match(worker, /lease_expires_at: null/)
})

test('finalización ASYNC cancela CREATED posteriores y conserva confirmados', () => {
  assert.match(worker, /status: 'CANCELLED'/)
  assert.match(worker, /\.eq\('status', 'CREATED'\)\.gt\('sequence_number', attempt\.sequence_number\)/)
  assert.match(worker, /finalize\(current, row, true\)/)
  assert.match(worker, /status === 'PARTIAL'|confirmedTotal > 0 \? 'PARTIAL'/)
})

test('recovery ASYNC no refresca el batch con el helper síncrono', () => {
  assert.match(worker, /refreshBatch: false/)
  assert.match(worker, /recoverCollectionPayment\(/)
  assert.match(worker, /recovery\.outcome === 'FAILED'.*finalize\(current, row, true\)/s)
  assert.match(worker, /status: 'UNKNOWN'.*completed_at: null/s)
})

test('toda excepción posterior al POST sale de SUBMITTING', () => {
  const postSection = worker.slice(worker.indexOf('try {\n    response = await gateway.createPayment'), worker.indexOf("await audit(current, row, 'COLLECTION_PAYMENT_CONFIRMED'"))
  assert.match(postSection, /catch \(cause\)/)
  assert.match(postSection, /status: 'UNKNOWN'/)
  assert.match(postSection, /\.eq\('status', 'SUBMITTING'\)/)
  assert.doesNotMatch(postSection, /createPayment\([^)]*createPayment/)
})

test('completed_at respeta la semántica ASYNC', () => {
  assert.match(worker, /status === 'PROCESSING' \|\| status === 'UNKNOWN' \? null : new Date\(\)\.toISOString\(\)/)
  assert.match(worker, /completed_at: null/)
})

test('endpoint protege CRON_SECRET, rechaza GET y middleware lo permite', () => {
  assert.match(route, /authorization.*Bearer \$\{secret\}/)
  assert.match(route, /status: 401/)
  assert.match(route, /export async function GET/)
  assert.match(route, /status: 405/)
  assert.match(middleware, /\/api\/cron\/collection-payment-worker/)
})

test('worker no añade scheduler ni modifica la UI síncrona', async () => {
  assert.doesNotMatch(worker, /setInterval|scheduler|cron/i)
  const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
  assert.match(view, /registerCollectionCustomerBatch/)
  assert.doesNotMatch(view, /enqueueCollectionCustomerBatch/)
})
