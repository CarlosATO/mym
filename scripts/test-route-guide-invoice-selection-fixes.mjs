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

test('la selección y el guardado respetan las exclusiones administrativas', () => {
  assert.match(sql, /get_route_invoice_draft_rows[\s\S]*?NOT logistica\.preparation_card_is_excluded/)
  assert.match(sql, /get_route_invoice_selection_candidates[\s\S]*?NOT logistica\.preparation_card_is_excluded/)
  assert.match(sql, /c\.status = 'INVOICED_READY_FOR_ROUTE'[\s\S]*?NOT logistica\.preparation_card_is_excluded/)
  assert.match(sql, /create_route_guide_draft_from_invoices[\s\S]*?preparation_card_is_excluded/)
})

test('los duplicados manuales conservan su contrato y Preparación queda protegida', () => {
  const trigger = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION logistica.populate_route_invoice_identity()'),
    sql.indexOf('DROP TRIGGER IF EXISTS populate_route_invoice_identity')
  )
  assert.match(trigger, /v_new_origin = 'PREPARATION_SELECTION'/)
  assert.match(trigger, /rg\.creation_origin = 'PREPARATION_SELECTION'/)
  assert.match(trigger, /Manual\/manual duplicates remain historical warnings/)
  assert.match(sql, /Manual duplicate warnings remain unchanged/)
})

test('el origen persistente cubre los cuatro escenarios y libera al cancelar', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS creation_origin text NOT NULL DEFAULT 'MANUAL'/)
  assert.match(sql, /'PREPARATION_SELECTION'/)
  assert.match(sql, /status IN \('DRAFT', 'DISPATCHED'\)/)
  assert.match(sql, /creation_origin IN \('MANUAL', 'PREPARATION_SELECTION'\)/)
  assert.match(sql, /lock_route_invoice_identity/)
  assert.match(sql, /create_route_guide_draft_unchecked[\s\S]*?lock_route_invoice_identity/)
  assert.match(sql, /update_route_guide_draft_unchecked[\s\S]*?lock_route_invoice_identity/)
  assert.match(sql, /dispatch_route_guide_unchecked[\s\S]*?lock_route_invoice_identity/)
  assert.doesNotMatch(sql, /status IN \('DRAFT', 'DISPATCHED', 'CANCELLED'\)/)
})

test('locks are deterministas y los duplicados ignoran CANCELLED', () => {
  const ids = [92560, 92551, 92555, 92551].filter((id, i, all) => all.indexOf(id) === i).sort((a, b) => a - b)
  assert.deepEqual(ids, [92551, 92555, 92560])
  assert.match(sql, /SELECT DISTINCT x FROM unnest\(p_invoice_bsale_ids\).*ORDER BY x/)
  assert.match(sql, /rg\.status IN \('DRAFT', 'DISPATCHED'\)/)
  assert.doesNotMatch(sql, /rg\.status IN \('DRAFT', 'DISPATCHED', 'CANCELLED'\)/)
})

test('dispatch prioriza ID tecnico y conserva fallback legacy', () => {
  assert.match(sql, /theirs\.invoice_bsale_id = mine\.invoice_bsale_id/)
  assert.match(sql, /theirs\.invoice_number = mine\.invoice_number/)
})

test('el trigger también valida identidad al mover una línea de empresa o guía', () => {
  assert.match(sql, /BEFORE INSERT OR UPDATE OF company_id, route_guide_id, invoice_number, invoice_bsale_id/)
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
