import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261030150000_logistica_invoice_stock_verification_guard.sql', import.meta.url), 'utf8')
const strictRpc = await readFile(new URL('../supabase/migrations/20261030120743_logistica_invoice_reconciliation_strict.sql', import.meta.url), 'utf8')

test('la evidencia queda vinculada a empresa, intento, factura, salesId y fingerprint', () => {
  assert.match(migration, /company_id uuid NOT NULL/)
  assert.match(migration, /attempt_id uuid NOT NULL REFERENCES logistica\.sales_order_invoice_attempts/)
  assert.match(migration, /invoice_bsale_id bigint NOT NULL/)
  assert.match(migration, /sales_id text NOT NULL/)
  assert.match(migration, /attempt_fingerprint text NOT NULL/)
  assert.match(migration, /UNIQUE \(company_id, attempt_id\)/)
  assert.match(migration, /verified_at timestamptz NOT NULL/)
  assert.match(migration, /shipping_ids bigint\[\]/)
  assert.match(migration, /sales_order_invoice_stock_verification_lines/)
})

test('la escritura es sólo service_role y la evidencia es inmutable', () => {
  assert.match(migration, /auth\.role\(\) IS DISTINCT FROM 'service_role'/)
  assert.match(migration, /REVOKE ALL ON TABLE logistica\.sales_order_invoice_stock_verifications[\s\S]*FROM PUBLIC, anon, authenticated, service_role/)
  assert.match(migration, /REVOKE ALL ON TABLE logistica\.sales_order_invoice_stock_verification_lines[\s\S]*FROM PUBLIC, anon, authenticated, service_role/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.record_sales_order_invoice_stock_evidence[\s\S]*TO service_role/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON logistica\.sales_order_invoice_stock_verifications/)
  assert.match(migration, /BEFORE UPDATE OR DELETE ON logistica\.sales_order_invoice_stock_verification_lines/)
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_IMMUTABLE/)
})

test('la tabla de intentos no conserva DML directo authenticated y el trigger cubre INSERT/UPDATE', () => {
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE logistica\.sales_order_invoice_attempts[\s\S]*FROM authenticated/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.guard_invoice_stock_confirmation/)
  assert.match(migration, /INVOICE_STOCK_CONFIRMATION_REQUIRES_EXISTING_ATTEMPT/)
  assert.match(migration, /BEFORE INSERT OR UPDATE ON logistica\.sales_order_invoice_attempts/)
  assert.match(migration, /NEW\.status = 'CONFIRMED'[\s\S]*invoice_stock_verification_is_valid\(OLD\.id, NEW\.bsale_invoice_id\)/)
  assert.match(migration, /NEW\.bsale_invoice_id IS NULL[\s\S]*NEW\.bsale_invoice_number IS NULL/)
  assert.match(migration, /d\.number::text = NEW\.bsale_invoice_number/)
})

test('el trigger evita reutilizar evidencia y protege la identidad confirmada', () => {
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_IDENTITY_IMMUTABLE/)
  assert.match(migration, /CONFIRMED_ATTEMPT_IDENTITY_IMMUTABLE/)
  assert.match(migration, /NEW\.sales_id IS DISTINCT FROM OLD\.sales_id/)
  assert.match(migration, /NEW\.fingerprint IS DISTINCT FROM OLD\.fingerprint/)
  assert.match(migration, /NEW\.bsale_invoice_id IS DISTINCT FROM OLD\.bsale_invoice_id/)
  assert.match(migration, /a\.status = 'CONFIRMED'[\s\S]*idempotent', true/)
})

test('la confirmación válida permite la primera vinculación, pero no una sustitución posterior', () => {
  assert.match(migration, /NEW\.bsale_invoice_id IS NULL[\s\S]*NOT EXISTS \([\s\S]*e\.invoice_bsale_id = NEW\.bsale_invoice_id[\s\S]*d\.number::text = NEW\.bsale_invoice_number/)
  assert.match(migration, /NEW\.bsale_invoice_id IS DISTINCT FROM OLD\.bsale_invoice_id/)
  assert.match(migration, /NEW\.bsale_invoice_number IS DISTINCT FROM OLD\.bsale_invoice_number/)
  assert.match(migration, /NEW\.company_id[\s\S]*e\.company_id = NEW\.company_id[\s\S]*e\.sales_id = NEW\.sales_id[\s\S]*e\.attempt_fingerprint = NEW\.fingerprint/)
})

test('la escritura de evidencia serializa el intento y responde idempotente al segundo escritor', () => {
  assert.match(migration, /WHERE id = p_attempt_id\s+-- Serialize evidence writers[\s\S]*FOR UPDATE/)
  assert.match(migration, /UNIQUE \(company_id, attempt_id\)/)
  assert.match(migration, /IF FOUND THEN[\s\S]*existing\.invoice_bsale_id IS DISTINCT FROM p_invoice_bsale_id[\s\S]*'idempotent', true/)
})

test('la evidencia equivalente ignora orden, pero compara todos los hechos operacionales', () => {
  assert.match(migration, /ARRAY\(SELECT id FROM unnest\(existing\.shipping_ids\)[\s\S]*ORDER BY id\)/)
  assert.match(migration, /ARRAY\(SELECT id FROM unnest\(p_shipping_ids\)[\s\S]*ORDER BY id\)/)
  assert.match(migration, /FULL JOIN stored_lines s USING \(line_key\)/)
  assert.match(migration, /existing\.office_id IS DISTINCT FROM p_office_id/)
  assert.match(migration, /i\.expected_quantity IS DISTINCT FROM s\.expected_quantity/)
  assert.match(migration, /i\.dispatched_quantity IS DISTINCT FROM s\.dispatched_quantity/)
  assert.match(migration, /i\.shipping_ids IS DISTINCT FROM s\.shipping_ids/)
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_CONFLICT/)
})

test('los despachos globales y por linea son validos, unicos y correctamente asociados', () => {
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_SHIPPING_SET_INVALID/)
  assert.match(migration, /shipping_id = ANY\(p_shipping_ids\)/)
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_LINE_SHIPPING_SET_INVALID/)
  assert.match(migration, /s\.value !~ '\^\[1-9\]\[0-9\]\*\$'/)
  assert.match(migration, /s\.value = ANY|s\.value::numeric = ANY|active_shipping_id::numeric/)
  assert.match(migration, /GROUP BY x\.line_key, s\.value[\s\S]*HAVING count\(\*\) > 1/)
})

test('el escritor valida empresa, identidad, factura activa, tipo 5, sucursal y cantidades', () => {
  assert.match(migration, /a\.company_id IS DISTINCT FROM p_company_id/)
  assert.match(migration, /a\.sales_id IS DISTINCT FROM p_sales_id/)
  assert.match(migration, /a\.fingerprint IS DISTINCT FROM p_attempt_fingerprint/)
  assert.match(migration, /d\.document_type_id = 5/)
  assert.match(migration, /d\.state = 0/)
  assert.match(migration, /d\.raw_json->>'salesId' = p_sales_id/)
  assert.match(migration, /inv\.office_id IS DISTINCT FROM p_office_id/)
  assert.match(migration, /INVOICE_STOCK_EVIDENCE_PRODUCT_QUANTITY_MISMATCH/)
  assert.match(migration, /x\.dispatched_quantity <> x\.expected_quantity/)
})

test('ambas RPC públicas guardan antes de delegar y mantienen idempotencia histórica', () => {
  assert.match(migration, /ALTER FUNCTION logistica\.reconcile_sales_order_invoice_attempt\(uuid\)[\s\S]*RENAME TO reconcile_sales_order_invoice_attempt_without_stock_guard/)
  assert.match(migration, /ALTER FUNCTION logistica\.confirm_sales_order_invoice_attempt\(uuid, bigint, text\)[\s\S]*RENAME TO confirm_sales_order_invoice_attempt_without_stock_guard/)
  assert.match(migration, /a\.status = 'CONFIRMED'[\s\S]*'idempotent', true/)
  assert.match(migration, /invoice_stock_verification_is_valid\(a\.id, NULL\)/)
  assert.match(migration, /invoice_stock_verification_is_valid\(a\.id, p_invoice_id\)/)
  assert.match(migration, /'reason', 'STOCK_VERIFICATION_REQUIRED'/)
  assert.match(migration, /RETURN logistica\.reconcile_sales_order_invoice_attempt_without_stock_guard/)
  assert.match(migration, /RETURN logistica\.confirm_sales_order_invoice_attempt_without_stock_guard/)
})

test('la migración no escribe Bsale y es transaccional para pruebas con ROLLBACK', () => {
  assert.match(migration, /\nBEGIN;/)
  assert.match(migration, /COMMIT;\s*$/)
  assert.doesNotMatch(migration, /bsaleWriteForCompany|fetch\(|POST \/documents|UPDATE integraciones\.bsale_documents|INSERT INTO integraciones\.bsale_documents/)
  assert.match(migration, /final COMMIT replaced by[\s\S]*ROLLBACK/)
  assert.match(migration, /Do not run the original file[\s\S]*final COMMIT/)
})

test('las RPC históricas sin guard quedan privadas y no hay una tercera confirmación conocida', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.reconcile_sales_order_invoice_attempt_without_stock_guard/)
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.confirm_sales_order_invoice_attempt_without_stock_guard/)
  assert.equal((strictRpc.match(/CREATE OR REPLACE FUNCTION logistica\.reconcile_sales_order_invoice_attempt/g) ?? []).length, 1)
  assert.equal((strictRpc.match(/CREATE OR REPLACE FUNCTION logistica\.confirm_sales_order_invoice_attempt/g) ?? []).length, 1)
})
