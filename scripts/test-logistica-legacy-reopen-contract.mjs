import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(
  new URL('supabase/migrations/20261017130000_logistica_reopen_legacy_archived_preparation_card.sql', root),
  'utf8',
)

const body = migration.slice(migration.indexOf('AS $$'), migration.indexOf('$$;'))
const update = migration.slice(
  migration.indexOf('UPDATE logistica.sales_order_preparation_cards c'),
  migration.indexOf('RETURNING c.* INTO v_card'),
)
const movement = migration.slice(
  migration.indexOf('INSERT INTO logistica.sales_order_preparation_movements'),
  migration.lastIndexOf('RETURN jsonb_build_object'),
)

test('1. la RPC existe con la firma administrativa esperada', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.reopen_legacy_archived_preparation_card\(\s*p_company_id uuid,\s*p_bsale_nv_id bigint,\s*p_reason text\s*\)\s*RETURNS jsonb/)
})

test('2. es SECURITY DEFINER y search_path fijo', () => {
  assert.match(migration, /LANGUAGE plpgsql\s*SECURITY DEFINER\s*SET search_path = pg_catalog, public/)
})

test('3. revoca PUBLIC y anon y concede a authenticated', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.reopen_legacy_archived_preparation_card\(uuid, bigint, text\) FROM PUBLIC, anon;/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.reopen_legacy_archived_preparation_card\(uuid, bigint, text\) TO authenticated, service_role;/)
})

test('4. exige auth.uid y no acepta actor desde el cliente', () => {
  assert.match(body, /v_actor uuid := auth\.uid\(\);/)
  assert.match(body, /IF v_actor IS NULL THEN\s*RAISE EXCEPTION 'Usuario no autenticado\.'/)
  assert.doesNotMatch(migration, /p_moved_by|p_actor|p_user_id/)
})

test('5. exige acceso a la empresa y rol SUPER_USUARIO, no GERENCIA', () => {
  assert.match(body, /core\.has_company_access\(v_actor, p_company_id\)/)
  assert.match(body, /portal\.is_super_usuario\(v_actor\)/)
  assert.match(body, /No autorizado: se requiere rol SUPER_USUARIO/)
  assert.doesNotMatch(body, /IN \('SUPER_USUARIO', 'GERENCIA'\)/)
})

test('6. reason obligatorio con trim', () => {
  assert.match(body, /v_reason text := btrim\(coalesce\(p_reason, ''\)\)/)
  assert.match(body, /IF v_reason = '' THEN\s*RAISE EXCEPTION 'El motivo \(reason\) es obligatorio\.'/)
})

test('7. resuelve la tarjeta por company_id + bsale_nv_id, no por folio', () => {
  assert.match(body, /FROM logistica\.sales_order_preparation_cards c\s*WHERE c\.company_id = p_company_id\s*AND c\.bsale_nv_id = p_bsale_nv_id/)
  assert.doesNotMatch(migration, /p_nv_folio|p_folio/)
})

test('8. exige exactamente una tarjeta legacy cerrada', () => {
  assert.match(body, /SELECT count\(\*\) INTO v_legacy_count/)
  assert.match(body, /c\.closed_at IS NOT NULL\s*AND c\.closure_reason = 'LEGACY_BACKFILL_ARCHIVED'/)
  assert.match(body, /IF v_legacy_count > 1 THEN\s*RAISE EXCEPTION 'Inconsistencia/)
})

test('9. bloquea tarjetas abiertas y motivos distintos con respuesta/errores controlados', () => {
  assert.match(body, /'status', 'already_open'/)
  assert.match(body, /no tiene closure_reason=LEGACY_BACKFILL_ARCHIVED/)
  assert.match(body, /coalesce\(v_open_card\.closure_reason, 'NULL'\)/)
})

test('10. restringe la reapertura a PENDING_ROUTE_PREP', () => {
  assert.match(body, /IF v_card\.status <> 'PENDING_ROUTE_PREP' THEN\s*RAISE EXCEPTION 'La tarjeta legacy esta en %; solo se permite reabrir desde PENDING_ROUTE_PREP\.'/)
})

test('11. exige documento type23 y state0', () => {
  assert.match(body, /v_nv\.document_type_id IS DISTINCT FROM 23/)
  assert.match(body, /v_nv\.state IS DISTINCT FROM 0/)
  assert.match(body, /evidencia definitiva en Bsale \(state=%\)/)
})

test('12. bloquea invoice link canonico', () => {
  assert.match(body, /FROM integraciones\.bsale_invoice_sales_order_links link[\s\S]*invoice\.document_type_id = 5/)
  assert.match(body, /IF v_has_invoice THEN\s*RAISE EXCEPTION 'La tarjeta ya posee evidencia definitiva en Bsale \(invoice link\)/)
})

test('13. bloquea cobertura COMPLETA, is_pending falso o remaining <= 0', () => {
  assert.match(body, /IF v_cov\.coverage_status = 'COMPLETA'/)
  assert.match(body, /v_cov\.is_pending IS DISTINCT FROM true/)
  assert.match(body, /coalesce\(v_cov\.remaining_qty, 0\) <= 0/)
  assert.match(body, /no esta pendiente de despacho/)
})

test('14. bloquea exclusion administrativa activa', () => {
  assert.match(body, /FROM logistica\.sales_order_preparation_exclusions e[\s\S]*e\.active = true/)
  assert.match(body, /IF v_has_exclusion THEN\s*RAISE EXCEPTION 'La NV % tiene una exclusion administrativa activa/)
})

test('15. actualiza solo closed_at, closure_reason y updated_at', () => {
  assert.match(update, /SET closed_at = NULL,\s*closure_reason = NULL,\s*updated_at = v_reopened_at/)
  const setBlock = update.slice(update.indexOf('SET'), update.indexOf('WHERE'))
  assert.doesNotMatch(setBlock, /\bstatus\s*=/)
  assert.doesNotMatch(setBlock, /\bbsale_nv_id\s*=/)
  assert.doesNotMatch(setBlock, /\bbsale_nv_folio\s*=/)
  assert.doesNotMatch(setBlock, /\bcreated_at\s*=/)
})

test('16. bloquea fila y usa revalidacion defensiva en el UPDATE', () => {
  assert.match(body, /FOR UPDATE;/)
  assert.match(update, /d\.document_type_id = 23\s*AND d\.state = 0/)
  assert.match(update, /NOT EXISTS \([\s\S]*bsale_invoice_sales_order_links/)
  assert.match(update, /NOT EXISTS \([\s\S]*sales_order_preparation_exclusions/)
  assert.match(update, /cv\.is_pending = true[\s\S]*cv\.remaining_qty > 0[\s\S]*cv\.coverage_status <> 'COMPLETA'/)
})

test('17. movement humano USER con moved_by = auth.uid real', () => {
  assert.match(movement, /p_company_id, v_card\.id, v_card\.status, v_card\.status, v_actor, 'USER'/)
  assert.match(movement, /pin_validated, observation, metadata, automation_key/)
  assert.match(movement, /false, v_reason,/)
})

test('18. movement registra accion y motivo previo', () => {
  assert.match(movement, /'previous_closure_reason', 'LEGACY_BACKFILL_ARCHIVED'/)
  assert.match(movement, /'action', 'REOPEN_LEGACY_ARCHIVED'/)
  assert.match(movement, /'actor_id', v_actor/)
  assert.match(movement, /'previous_closed_at', v_previous_closed_at/)
})

test('19. automation_key es determinista por ciclo de archivo y no eterna', () => {
  assert.match(body, /v_automation_key := 'BODEGA_LEGACY_REOPEN:' \|\| to_char\(v_previous_closed_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'\)/)
  assert.match(movement, /ON CONFLICT \(company_id, card_id, automation_key\) WHERE automation_key IS NOT NULL DO NOTHING/)
  assert.doesNotMatch(body, /BODEGA_LEGACY_REOPEN:.*now\(\)/)
})

test('20. segunda llamada no duplica movement ni timestamps', () => {
  assert.match(body, /'status', 'already_open'/)
  assert.match(body, /La reapertura ya fue registrada para este ciclo de archivo/)
  assert.match(body, /ON CONFLICT \(company_id, card_id, automation_key\) WHERE automation_key IS NOT NULL DO NOTHING/)
})

test('21. respuesta de exito incluye contrato minimo', () => {
  assert.match(migration, /'ok', true,\s*'status', 'reopened',\s*'card_id', v_card\.id,\s*'bsale_nv_id', v_card\.bsale_nv_id,\s*'nv_folio', v_card\.bsale_nv_folio,\s*'card_status', v_card\.status,\s*'reason', v_reason/)
})

test('22. conserva closed_at original para metadata antes del UPDATE', () => {
  assert.match(body, /v_previous_closed_at := v_card\.closed_at;/)
  assert.match(movement, /'previous_closed_at', v_previous_closed_at/)
})

test('23. no modifica board, datos de rutas ni A1', () => {
  assert.doesNotMatch(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
  assert.doesNotMatch(migration, /sales_order_preparation_route_events/)
  assert.doesNotMatch(migration, /ALTER TABLE logistica\.sales_order_preparation_cards/)
})

test('24. no contiene data-fix ni lista de las 61', () => {
  assert.doesNotMatch(migration, /83326|83327|83878|90045|91741|92172/)
  assert.doesNotMatch(migration, /UPDATE logistica\.sales_order_preparation_cards[\s\S]{0,200}LEGACY_BACKFILL_ARCHIVED/)
})

test('25. no reabre por coverage ni por is_pending fuera de esta RPC', () => {
  assert.doesNotMatch(migration, /reconcile_bodega_preparation_cards/)
  assert.match(body, /IF v_cov\.coverage_status = 'COMPLETA'/)
  assert.match(body, /no esta pendiente de despacho/)
})
