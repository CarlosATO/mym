import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sql = await readFile(new URL('../supabase/migrations/20261023150107_logistica_route_invoice_selection_production_compat.sql', import.meta.url), 'utf8')

test('la identidad explicita domina y el fallback de folio es unico', () => {
  assert.match(sql, /IF NEW\.invoice_bsale_id IS NOT NULL[\s\S]*?valid invoice for company/)
  assert.match(sql, /SELECT count\(\*\)[\s\S]*?\) = 1[\s\S]*?SELECT min\(d\.bsale_id\)/)
  assert.doesNotMatch(sql, /ORDER BY d\.bsale_id DESC[\s\S]*?LIMIT 1/)
})

test('todos los writers incluyen la identidad tecnica y protegen reemplazos', () => {
  assert.match(sql, /create_route_guide_draft_unchecked[\s\S]*?invoice_bsale_id, invoice_number/)
  assert.match(sql, /update_route_guide_draft_unchecked[\s\S]*?Rehydrate identities/)
  assert.match(sql, /edit_route_guide_unsettled[\s\S]*?identidad t[eé]cnica de una l[ií]nea existente es inmutable/)
  assert.match(sql, /invoice_bsale_id is immutable for an existing Bsale line/)
})

test('create exige documento, attempt confirmado, card elegible y evidencia NV', () => {
  assert.match(sql, /d\.document_type_id = 5[\s\S]*?d\.state = 0[\s\S]*?cancellationStatus/)
  assert.match(sql, /a\.status = 'CONFIRMED'[\s\S]*?c\.status = 'INVOICED_READY_FOR_ROUTE'/)
  assert.match(sql, /bsale_invoice_sales_order_links l[\s\S]*?l\.sales_order_bsale_id = v_card_nv/)
})

test('locks are deterministas y los duplicados ignoran CANCELLED', () => {
  const ids = [92560, 92551, 92555, 92551].filter((id, i, all) => all.indexOf(id) === i).sort((a, b) => a - b)
  assert.deepEqual(ids, [92551, 92555, 92560])
  assert.match(sql, /SELECT DISTINCT x FROM unnest\(p_invoice_bsale_ids\).*ORDER BY x/)
  assert.match(sql, /rg\.status IN \('DRAFT', 'DISPATCHED'\)/)
  assert.doesNotMatch(sql, /rg\.status IN \('DRAFT', 'DISPATCHED', 'CANCELLED'\)/)
})

test('dispatch prioriza ID tecnico y conserva fallback legacy', () => {
  assert.match(sql, /mine\.invoice_bsale_id IS NOT NULL AND theirs\.invoice_bsale_id = mine\.invoice_bsale_id/)
  assert.match(sql, /mine\.invoice_bsale_id IS NULL AND theirs\.invoice_bsale_id IS NULL AND theirs\.invoice_number = mine\.invoice_number/)
})

test('la migration falla antes de DROP si aparece una dependencia de la vista', () => {
  assert.match(sql, /pg_catalog\.pg_depend/)
  assert.match(sql, /migration stopped before DROP/)
  assert.match(sql, /ALTER VIEW logistica\.vw_sales_order_preparation_board OWNER TO postgres/)
})

test('los writers unchecked no son ejecutables por authenticated o anon', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION logistica\.create_route_guide_draft_unchecked\(/)
  assert.match(sql, /REVOKE ALL ON FUNCTION logistica\.update_route_guide_draft_unchecked\(/)
  assert.match(sql, /REVOKE ALL ON FUNCTION logistica\.dispatch_route_guide_unchecked\(/)
})
