import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  canClaimPreparation,
  canTakeoverPreparation,
  getPreparationLockLabel,
  isPreparationLockError,
  isPreparationReadOnly,
} from '../src/modules/logistica/preparacion-pedidos/preparation-lock-policy.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020140000_logistica_preparation_exclusive_lock.sql', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')
const card = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', root), 'utf8')
const dialog = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-lock-dialog.tsx', root), 'utf8')
const layout = await readFile(new URL('src/app/dashboard/logistica/logistica-layout-client.tsx', root), 'utf8')
const pageLayout = await readFile(new URL('src/app/dashboard/logistica/layout.tsx', root), 'utf8')
const docs = await readFile(new URL('docs/logistica/DOCUMENTO_FUNCIONAL_APP_BODEGA.md', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

const allowed = { currentUserId: 'user-a', canManage: true, canTakeover: true }

test('board expone lock y nombres batch sin N+1', () => {
  assert.match(migration, /c\.locked_by_user_id, c\.locked_at/)
  assert.match(actions, /const userIds = \[\.\.\.new Set\(rows\.flatMap\(row => \[row\.assigned_user_id, row\.locked_by_user_id\]\)/)
  assert.match(actions, /\.select\('id, nombre, apellido'\)/)
  assert.match(actions, /\.in\('id', userIds\)/)
  assert.match(actions, /assigned_user_name/)
  assert.match(actions, /locked_by_user_name/)
  const boardStart = actions.indexOf('export async function getSalesOrderPreparationBoard')
  const boardEnd = actions.indexOf('export async function getSalesOrderPreparationItems', boardStart)
  const boardBody = actions.slice(boardStart, boardEnd)
  assert.doesNotMatch(boardBody, /for \(const .* of .*\)[\s\S]{0,120}await createAdminClient\(\)/)
})

test('PENDING -> IN_PREPARATION adquiere lock en el mismo movimiento RPC', () => {
  assert.match(migration, /v_from_status = 'PENDING_ROUTE_PREP'/)
  assert.match(migration, /locked_by_user_id = CASE WHEN p_to_status = 'IN_PREPARATION' THEN p_user_id ELSE NULL END/)
  assert.match(migration, /locked_at = CASE WHEN p_to_status = 'IN_PREPARATION' THEN now\(\) ELSE NULL END/)
  assert.match(migration, /assigned_user_id = CASE\s+WHEN p_to_status IN \('IN_PREPARATION', 'IN_AUDIT'\) THEN p_user_id/)
  assert.doesNotMatch(migration, /PERFORM logistica\.acquire_sales_order_preparation_lock/)
})

test('carrera Pending -> Preparacion usa FOR UPDATE y rechaza al segundo', () => {
  assert.match(migration, /FROM logistica\.sales_order_preparation_cards WHERE id = p_card_id FOR UPDATE/)
  assert.match(migration, /Esta Nota de Venta ya fue tomada por otro preparador\./)
  assert.match(migration, /v_card\.locked_by_user_id <> p_user_id/)
  assert.match(migration, /Esta preparación está asignada a otro usuario\./)
})

test('confirm RPC valida status y owner en DB', () => {
  const confirmStart = migration.indexOf('CREATE OR REPLACE FUNCTION logistica.confirm_sales_order_preparation_line')
  const confirmEnd = migration.indexOf('REVOKE ALL ON FUNCTION logistica.confirm_sales_order_preparation_line', confirmStart)
  const confirmBody = migration.slice(confirmStart, confirmEnd)
  assert.match(confirmBody, /v_card\.status <> 'IN_PREPARATION'/)
  assert.match(confirmBody, /v_card\.locked_by_user_id IS NULL/)
  assert.match(confirmBody, /v_card\.locked_by_user_id <> v_actor/)
  assert.match(confirmBody, /Esta preparación está asignada a otro usuario\./)
  assert.match(confirmBody, /v_is_excluded := COALESCE\(p_excluded, false\) OR p_prepared_quantity = 0/)
})

test('movimientos IN_PREPARATION exigen owner y liberan lock al salir', () => {
  assert.match(migration, /IF v_from_status = 'IN_PREPARATION' THEN[\s\S]*?v_card\.locked_by_user_id IS NULL[\s\S]*?v_card\.locked_by_user_id <> p_user_id/)
  assert.match(migration, /CASE WHEN p_to_status = 'IN_PREPARATION' THEN p_user_id ELSE NULL END/)
  assert.match(migration, /'lock_released', v_from_status = 'IN_PREPARATION' AND p_to_status IN \('IN_AUDIT', 'PENDING_ROUTE_PREP'\)/)
  assert.match(migration, /WHEN p_to_status IN \('IN_PREPARATION', 'IN_AUDIT'\) THEN p_user_id/)
})

test('IN_AUDIT -> IN_PREPARATION adquiere lock para el actor', () => {
  assert.match(migration, /IF v_from_status = 'IN_AUDIT' AND p_to_status NOT IN \('IN_PREPARATION', 'PENDING_ROUTE_PREP'\)/)
  assert.match(migration, /CASE WHEN p_to_status = 'IN_PREPARATION' THEN p_user_id ELSE NULL END/)
})

test('claim legacy y takeover están separados, atómicos y autorizados en DB', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.take_sales_order_preparation_card/)
  assert.match(migration, /SELECT \* INTO v_card[\s\S]*?FOR UPDATE/)
  assert.match(migration, /v_card\.locked_by_user_id IS NULL[\s\S]*?PREPARATION_LOCK_CLAIM/)
  assert.match(migration, /portal\.has_permission\('logistica\.preparation\.manage'\)/)
  assert.match(migration, /portal\.has_permission\('logistica\.preparation\.authorize_exception'\)/)
  assert.match(migration, /El motivo es obligatorio para tomar la preparación de otro usuario\./)
  assert.match(migration, /PREPARATION_LOCK_TAKEOVER/)
  assert.match(migration, /movement_source, observation, metadata/)
  assert.match(migration, /'previous_user_id', v_previous_user_id/)
  assert.match(migration, /'new_user_id', v_actor/)
  assert.match(migration, /'reason', NULLIF\(btrim\(p_reason\), ''\)/)
  assert.match(actions, /export async function takeSalesOrderPreparationCard/)
  assert.match(actions, /rpc\('take_sales_order_preparation_card'/)
  assert.doesNotMatch(actions, /p_is_admin|isAdmin:\s*true/)
})

test('no hay timeout, heartbeat ni liberación automática', () => {
  assert.doesNotMatch(migration, /locked_at\s*<\s*now\(\)\s*-/i)
  assert.doesNotMatch(migration, /interval '/i)
  assert.doesNotMatch(migration, /heartbeat|ttl|expire/i)
})

test('UI owner, read-only, claim y takeover están conectados', () => {
  assert.match(layout, /currentUserId={profile\.id}/)
  assert.match(layout, /permissions={permissions}/)
  assert.match(pageLayout, /id: user\.id/)
  assert.match(card, /getPreparationLockLabel/)
  assert.match(drawer, /const isReadOnly = isPreparationReadOnly\(lockView\)/)
  assert.match(drawer, /Esta Nota de Venta está siendo preparada por \$\{lockOwnerName\}/)
  assert.match(drawer, /Esta preparación aún no tiene responsable\./)
  assert.match(drawer, /TOMAR|Tomar preparación/)
  assert.match(drawer, /disabled=\{isMoving \|\| isReadOnly\}/)
  assert.match(drawer, /savingLineId === line\.id \|\| line\.excluded_from_dispatch \|\| isReadOnly/)
  assert.match(panel, /dragDisabled=\{card\.status === 'AUDITED' \|\| isPreparationReadOnly\(/)
  assert.match(card, /disabled: isOverlay \|\| isPending \|\| dragDisabled/)
  assert.match(dialog, /Tomar preparación de otro usuario/)
  assert.match(dialog, /El motivo es obligatorio/)
  assert.match(dialog, /Responsable actual/)
  assert.match(dialog, /Nuevo responsable/)
})

test('cache stale / takeover fuerza refresh de lock y read-only', () => {
  assert.match(panel, /isPreparationLockError/)
  assert.match(panel, /handleOwnershipConflict/)
  assert.match(panel, /await loadBoard\(\)/)
  assert.match(drawer, /reportLockConflict\(result\.error\)/)
  assert.match(drawer, /reportLockConflict\(moveResult\.error\)/)
  assert.match(panel, /applyPreparationLockPatchToState/)
})

test('sync Bsale no toca locks', () => {
  const syncStart = actions.indexOf('export async function syncOperationalBsaleSalesOrders()')
  const syncBody = actions.slice(syncStart)
  assert.match(syncBody, /syncOperationalBsaleSalesOrdersIfStale|runManualWarehouseBsaleRefresh/)
  assert.doesNotMatch(syncBody, /locked_by_user_id|locked_at/)
})

test('documentación y script de test quedan registrados', () => {
  assert.match(docs, /Un lock no expira|El lock no expira|no expira/)
  assert.match(docs, /takeover/i)
  assert.match(docs, /sales_order_preparation_movements/)
  assert.equal(packageJson.scripts['test:logistica-preparacion-locking'], 'node --experimental-strip-types --test scripts/test-logistica-preparacion-locking-contract.mjs')
})

test('policy: owner, legacy y terceros', () => {
  const owner = { ...allowed, status: 'IN_PREPARATION', currentUserId: 'a', lockedByUserId: 'a' }
  const other = { ...allowed, status: 'IN_PREPARATION', currentUserId: 'b', lockedByUserId: 'a' }
  const legacy = { ...allowed, status: 'IN_PREPARATION', currentUserId: 'b', lockedByUserId: null }

  assert.equal(isPreparationReadOnly(owner), false)
  assert.equal(isPreparationReadOnly(other), true)
  assert.equal(isPreparationReadOnly(legacy), true)
  assert.equal(canClaimPreparation(legacy), true)
  assert.equal(canClaimPreparation(other), false)
  assert.equal(canTakeoverPreparation(other), true)
  assert.equal(canTakeoverPreparation({ ...other, canTakeover: false }), false)
  assert.equal(getPreparationLockLabel(owner), 'Tu preparación')
  assert.equal(getPreparationLockLabel(legacy), 'Sin responsable asignado')
  assert.equal(getPreparationLockLabel({ ...other, lockedByName: 'Juan Pérez' }), 'En preparación por Juan Pérez')
  assert.equal(isPreparationLockError('Esta preparación está asignada a otro usuario.'), true)
  assert.equal(isPreparationLockError('La cantidad debe estar entre 0 y la cantidad solicitada.'), false)
})
