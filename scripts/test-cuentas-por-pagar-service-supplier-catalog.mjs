import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { filterServiceSuppliers, upsertSupplierOption } from '../src/modules/cuentas-por-pagar/service-rules.ts'

const supplier = (id, rut) => ({ id, business_name: id, rut, fantasy_name: null, payment_terms: null, credit_days: 0 })

test('el selector conserva RUT válidos y excluye ausentes, malformados o con DV incorrecto', () => {
  const candidates = [
    supplier('Caylo', '76.086.428-5'),
    supplier('Global', '111111111'),
    supplier('Otro válido', '12.345.678-5'),
    supplier('Sin RUT', null),
    supplier('Vacío', ' '),
    supplier('DV incorrecto', '76.086.428-9'),
    supplier('Malformado', '123-ABC'),
  ]
  assert.deepEqual(filterServiceSuppliers(candidates).map(s => s.id), ['Caylo', 'Global', 'Otro válido'])
})

test('un proveedor recién creado con RUT válido sigue disponible para selección automática', () => {
  const created = supplier('Nuevo', '76.086.428-5')
  assert.deepEqual(filterServiceSuppliers(upsertSupplierOption([], created)), [created])
})

test('la migración de catálogo exige empresa, tipo, estado y dígito verificador', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261120150000_cuentas_por_pagar_service_supplier_catalog.sql', import.meta.url), 'utf8')
  assert.match(sql, /s\.company_id IS NULL OR s\.company_id = v_company_id/)
  assert.match(sql, /s\.supplier_kind = 'REAL'/)
  assert.match(sql, /s\.is_active = true/)
  assert.match(sql, /s\.status = 'ACTIVE'/)
  assert.match(sql, /cuentas_por_pagar\.is_valid_chilean_rut\(/)
})
