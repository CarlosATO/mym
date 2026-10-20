import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020120000_logistica_preparation_quantities_incidents.sql', root), 'utf8')
const zeroExclusionMigration = await readFile(new URL('supabase/migrations/20261020130000_logistica_preparation_zero_exclusion_invariant.sql', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')
const pdf = await readFile(new URL('src/lib/pdf/generate-preparation-orders-pdf.ts', root), 'utf8')
const docs = await readFile(new URL('docs/logistica/DOCUMENTO_FUNCIONAL_APP_BODEGA.md', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')

test('el snapshot conserva solicitado y diferencia NULL de cero', () => {
  assert.match(migration, /requested_quantity numeric NOT NULL/)
  assert.match(migration, /prepared_quantity numeric CHECK \(prepared_quantity IS NULL OR/)
  assert.match(migration, /line_status text NOT NULL DEFAULT 'PENDING'/)
  assert.match(migration, /ON CONFLICT \(company_id, card_id, bsale_detail_id\) DO NOTHING/)
  assert.match(drawer, /line\.prepared_quantity == null \? ''/)
  assert.match(drawer, /placeholder=\{line\.prepared_quantity == null \? '—' : undefined\}/)
  assert.match(drawer, /line_status === 'PENDING'/)
})

test('la confirmación backend valida rango, estado e incidencia en una operación', () => {
  assert.match(migration, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(migration, /p_prepared_quantity < 0 OR p_prepared_quantity > v_line\.requested_quantity/)
  assert.match(migration, /UPDATE logistica\.sales_order_preparation_incidents[\s\S]*?INSERT INTO logistica\.sales_order_preparation_incidents[\s\S]*?UPDATE logistica\.sales_order_preparation_lines/)
  assert.match(migration, /status = 'SUPERSEDED'/)
  assert.match(actions, /confirm_sales_order_preparation_line/)
})

test('motivos, exclusion y bloqueo de auditoria estan representados', () => {
  for (const reason of ['SIN_STOCK', 'STOCK_INSUFICIENTE', 'PRODUCTO_DANADO', 'PRODUCTO_VENCIDO_NO_APTO', 'ERROR_PEDIDO', 'SOLICITUD_CLIENTE', 'OTRO']) {
    assert.match(migration, new RegExp(reason))
  }
  assert.match(migration, /LINE_EXCLUDED/)
  assert.match(drawer, /Faltan \$\{pendingLines\.length\}/)
  assert.match(drawer, /Esta preparación contiene diferencias/)
  assert.match(drawer, /No se pudo confirmar la línea/)
})

test('el contrato funcional prohíbe escritura automatica en Bsale y conserva historial', () => {
  assert.match(migration, /No modifica Bsale/)
  assert.match(docs, /PetGroup no modifica, elimina, anula ni recrea documentos Bsale/)
  assert.match(docs, /SUPERSEDED/)
  assert.match(docs, /facturación futura no debe ignorar incidencias administrativas pendientes/)
})

test('el input cero se puede reemplazar y una confirmación exitosa parchea sólo la línea', () => {
  assert.match(drawer, /onFocus=\{\(\) => setLineDrafts\(current => \(\{ \.\.\.current, \[line\.id\]: '' \}\)\)\}/)
  assert.match(drawer, /onBlur=\{\(\) => setLineDrafts\(current => \{/)
  assert.doesNotMatch(drawer, /prepared_quantity == null \? '0'/)
  assert.match(drawer, /raw\.trim\(\) === ''/)
  assert.match(drawer, /onPreparationLineChange\(result\.data\)/)
  assert.match(drawer, /isLoadingPreparationLines/)
})

test('la transición a auditoría mantiene el bloqueo de líneas pendientes', () => {
  assert.match(drawer, /line\.prepared_quantity === null \|\| line\.line_status === 'PENDING'/)
  assert.match(migration, /AND \(line_status = 'PENDING' OR prepared_quantity IS NULL\)/)
})

test('confirmar usa un único preflight de gestión y parchea el resultado RPC', () => {
  assert.match(actions, /async function requireLogisticaManage\(\)/)
  assert.match(actions, /p_permission_code: 'logistica\.preparation\.manage'/)
  assert.match(actions, /confirmSalesOrderPreparationLine[\s\S]*?const \{ supabase, error: permissionError \} = await requireLogisticaManage\(\)/)
  assert.match(drawer, /onPreparationLineChange\(result\.data\)/)
  assert.doesNotMatch(drawer, /savePreparationLine[\s\S]*?loadBoard\(/)
})

test('el PDF operacional usa líneas persistidas y conserva el PDF pendiente', () => {
  assert.match(pdf, /preparationLines\?: SalesOrderPreparationLine\[\]/)
  assert.match(pdf, /entry\.card\.status === 'IN_PREPARATION'/)
  assert.match(pdf, /'SKU', 'Descripción \/ presentación', 'Solicitado', 'Preparado', 'Estado'/)
  assert.match(pdf, /line\.prepared_quantity == null \? '—' : String\(line\.prepared_quantity\)/)
  assert.match(pdf, /preparationLineStatusLabel/)
  assert.match(pdf, /Excluida \/ Con incidencia/)
  assert.match(pdf, /Pendientes de confirmar/)
  assert.match(pdf, /entry\.items\.map\(item =>/)
  assert.match(drawer, /generatePreparationOrdersPdf\(\[\{ card, items, preparationLines, clientData \}\]\)/)
})

test('cero explícito equivale a exclusión operacional en la frontera de aplicación', () => {
  assert.match(actions, /params\.excluded === true \|\| params\.preparedQuantity === 0/)
  assert.match(actions, /p_excluded: excluded/)
  assert.match(drawer, /const effectiveExcluded = excluded \|\| quantity === 0/)
  assert.match(drawer, /const raw = excluded\s*\? '0'/)
})

test('Excluir fuerza cantidad 0 y motivo obligatorio, sin borrar la línea', () => {
  assert.match(drawer, /onClick=\{\(\) => confirmLineInput\(line, true\)\}/)
  assert.match(drawer, /setIncidentLine\(\{ line, quantity, excluded: effectiveExcluded \}\)/)
  assert.match(drawer, /incidentLine\.quantity - incidentLine\.line\.requested_quantity/)
  assert.match(drawer, /disabled=\{!incidentReason/)
  assert.match(migration, /UPDATE logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_lines/)
})

test('ambos caminos terminan en LINE_EXCLUDED, REMOVE_LINE y excluded_from_dispatch', () => {
  assert.match(actions, /p_prepared_quantity: params\.preparedQuantity/)
  assert.match(migration, /CASE WHEN p_excluded THEN 'LINE_EXCLUDED' ELSE 'QUANTITY_REDUCTION' END/)
  assert.match(migration, /CASE WHEN p_excluded THEN 'REMOVE_LINE' ELSE 'SET_QUANTITY' END/)
  assert.match(migration, /excluded_from_dispatch = p_excluded/)
})

test('volver a pendiente conserva snapshot, cantidades previas e historial', () => {
  assert.match(migration, /ON CONFLICT \(company_id, card_id, bsale_detail_id\) DO NOTHING/)
  assert.match(migration, /IF p_to_status = 'IN_PREPARATION' THEN[\s\S]*materialize_sales_order_preparation_snapshot/)
  assert.doesNotMatch(migration, /prepared_quantity = NULL/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_incidents/)
  assert.match(panel, /prunePreparationLinesCache\(preparationLinesCacheRef\.current, rows\.map\(r => r\.card_id\)\)/)
})

test('invariante DB: prepared 0 normaliza a exclusión aunque p_excluded sea false', () => {
  assert.match(zeroExclusionMigration, /v_is_excluded := COALESCE\(p_excluded, false\) OR p_prepared_quantity = 0/)
  assert.match(zeroExclusionMigration, /CASE WHEN v_is_excluded THEN 'LINE_EXCLUDED' ELSE 'QUANTITY_REDUCTION' END/)
  assert.match(zeroExclusionMigration, /CASE WHEN v_is_excluded THEN 'REMOVE_LINE' ELSE 'SET_QUANTITY' END/)
  assert.match(zeroExclusionMigration, /excluded_from_dispatch = v_is_excluded/)
  assert.match(zeroExclusionMigration, /expected_bsale_quantity[\s\S]*?p_prepared_quantity, v_actor/)
  assert.match(zeroExclusionMigration, /CREATE OR REPLACE FUNCTION logistica\.confirm_sales_order_preparation_line\(\s*p_company_id uuid,\s*p_line_id uuid,\s*p_prepared_quantity numeric,\s*p_reason_code text DEFAULT NULL,\s*p_observation text DEFAULT NULL,\s*p_excluded boolean DEFAULT false\s*\)/)
  assert.match(zeroExclusionMigration, /RETURNS logistica\.sales_order_preparation_lines/)
  assert.match(zeroExclusionMigration, /SECURITY DEFINER/)
})

test('invariante DB preserva cantidades > 0 y el historial de incidencias', () => {
  assert.match(zeroExclusionMigration, /IF p_prepared_quantity IS NULL OR p_prepared_quantity < 0 OR p_prepared_quantity > v_line\.requested_quantity/)
  assert.match(zeroExclusionMigration, /IF v_is_excluded OR p_prepared_quantity < v_line\.requested_quantity THEN/)
  assert.match(zeroExclusionMigration, /UPDATE logistica\.sales_order_preparation_incidents[\s\S]*?status = 'SUPERSEDED'/)
  assert.match(zeroExclusionMigration, /UPDATE logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(zeroExclusionMigration, /DELETE FROM/)
  assert.doesNotMatch(zeroExclusionMigration, /requested_quantity\s*=/)
  assert.match(zeroExclusionMigration, /comportamiento para > 0/)
})
