import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculateReceiptEconomics } from '../src/lib/logistica/receipt-economics.ts'

const migration = await readFile(new URL('../supabase/migrations/20261006090000_logistica_purchase_receipts_service_quantity_fix.sql', import.meta.url), 'utf8')
const hardeningMigration = await readFile(new URL('../supabase/migrations/20261005180000_logistica_purchase_receipts_hardening.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/recepciones.ts', import.meta.url), 'utf8')
const worksheet = await readFile(new URL('../src/modules/logistica/recepciones/receipt-worksheet.tsx', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/logistica/recepciones/recepciones-panel.tsx', import.meta.url), 'utf8')

test('receipt economics prorates discount and tax rate', () => {
  assert.deepEqual(calculateReceiptEconomics({
    quantity: 10,
    unitPrice: 100,
    discountPercent: 10,
    taxRate: 19,
  }, 5), {
    netAmount: 450,
    taxAmount: 85.5,
    grossAmount: 535.5,
    netUnitCost: 90,
  })

  assert.equal(calculateReceiptEconomics({ quantity: 10, unitPrice: 100, taxRate: 0 }, 5).taxAmount, 0)
})

test('receipt status contract only accepts confirmed and partial orders', () => {
  assert.match(migration, /v_po\.status NOT IN \('CONFIRMADA', 'RECEPCION_PARCIAL'\)/)
  assert.match(action, /\['CONFIRMADA', 'RECEPCION_PARCIAL', 'RECEPCION_TOTAL'\]/)
  assert.match(panel, /\['CONFIRMADA', 'RECEPCION_PARCIAL'\]/)
  assert.doesNotMatch(panel, /filterTab === 'PENDING'.*EMITIDA/)
})

test('condition semantics distinguish accepted, damaged, rejected and missing quantities', () => {
  assert.match(migration, /v_condition IN \('CONFORME', 'DANADO'\) THEN v_qty_received/)
  assert.match(migration, /i\.condition IN \('CONFORME', 'DANADO'\)/)
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) THEN[\s\S]*UPDATE adquisiciones\.purchase_order_items[\s\S]*END IF;/)
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) AND v_item_type = 'PRODUCT' THEN[\s\S]*INSERT INTO logistica\.kardex_movements/)
  assert.match(migration, /UPDATE adquisiciones\.purchase_order_items[\s\S]*quantity_received = quantity_received \+ v_qty_received/)
  assert.match(worksheet, /value="DANADO"/)
  assert.match(worksheet, /value="RECHAZADO"/)
  assert.match(worksheet, /value="FALTANTE"/)
})

test('product, service and mixed receipt contracts are wired', () => {
  assert.match(migration, /v_item_type = 'PRODUCT' AND v_po_item\.product_id IS NULL/)
  assert.match(migration, /v_item_type = 'SERVICE' AND v_po_item\.product_id IS NOT NULL/)
  assert.match(migration, /CASE WHEN v_item_type = 'SERVICE' THEN v_po_item\.product_description ELSE NULL END/)
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) THEN[\s\S]*quantity_received = quantity_received \+ v_qty_received/)
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) AND v_item_type = 'PRODUCT' THEN/)
  assert.match(worksheet, /quantity: Number\(item\.quantity_pending \|\| 0\)/)
})

test('receipt security, idempotency, documents and correlatives are present', () => {
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /SET search_path = pg_catalog, public, auth, core, portal, logistica, adquisiciones/)
  assert.match(migration, /auth\.uid\(\) IS NULL OR p_user_id IS NULL OR auth\.uid\(\) <> p_user_id/)
  assert.match(migration, /core\.has_permission_for_company\(p_user_id, p_company_id, 'logistica\.receptions\.create'\)/)
  assert.match(migration, /idempotency_key uuid/)
  assert.match(migration, /purchase_receipt_correlatives/)
  assert.match(migration, /receipt_documents/)
  assert.match(action, /requireWmsPermission\('logistica\.receptions\.create'\)/)
  assert.match(action, /p_idempotency_key: data\.idempotency_key/)
})

test('frontend sends one UUID idempotency key without a receipt prefix', () => {
  assert.match(worksheet, /const \[idempotencyKey\] = useState\(\(\) => crypto\.randomUUID\(\)\)/)
  assert.doesNotMatch(worksheet, /receipt:\$\{poId\}/)
  assert.match(worksheet, /idempotency_key: idempotencyKey/)
})

test('accepted service and product quantities have separate stock semantics', () => {
  const acceptedUpdate = migration.match(/IF v_condition IN \('CONFORME', 'DANADO'\) THEN\s+UPDATE[\s\S]*?END IF;/)?.[0] || ''
  const kardexBlock = migration.match(/IF v_condition IN \('CONFORME', 'DANADO'\) AND v_item_type = 'PRODUCT' THEN\s+INSERT INTO[\s\S]*?END IF;/)?.[0] || ''
  assert.match(acceptedUpdate, /UPDATE adquisiciones\.purchase_order_items/)
  assert.match(acceptedUpdate, /quantity_received = quantity_received \+ v_qty_received/)
  assert.doesNotMatch(acceptedUpdate, /v_item_type = 'PRODUCT'/)
  assert.match(kardexBlock, /INSERT INTO logistica\.kardex_movements/)
  assert.doesNotMatch(kardexBlock, /v_item_type = 'SERVICE'/)
  assert.match(migration, /v_condition = 'RECHAZADO'[\s\S]*v_qty_received <> 0/)
  assert.match(migration, /v_condition = 'FALTANTE'[\s\S]*v_qty_received <> 0/)
})

test('idempotency lookup and conflict retry remain intact', () => {
  assert.match(migration, /WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key/)
  assert.match(migration, /EXCEPTION WHEN unique_violation/)
  assert.match(hardeningMigration, /purchase_receipts_company_idempotency_uq/)
})

test('legacy ten-argument RPC remains executable only for authenticated and service role', () => {
  const signature = 'logistica.create_purchase_receipt_db(uuid, uuid, text, uuid, text, text, text, date, jsonb, uuid)'
  assert.ok(hardeningMigration.includes(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC, anon`))
  assert.ok(hardeningMigration.includes(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated, service_role`))
  assert.match(hardeningMigration, /REVOKE EXECUTE ON FUNCTION logistica\.create_purchase_receipt_db\(uuid, uuid, text, uuid, text, jsonb, uuid\) FROM PUBLIC, anon, authenticated/)
})
