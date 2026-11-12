import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const authorization = await readFile(new URL('src/app/actions/logistica/authorization.ts', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')

test('1. confirmSalesOrderPreparationLine instrumenta telemetría por etapas (authMs, rpcMs, totalMs)', () => {
  // Debe medir tiempo de inicio y duraciones de autorización y RPC
  assert.match(actions, /const actionStart = performance\.now\(\)/)
  assert.match(actions, /const authDuration = performance\.now\(\) - actionStart/)
  assert.match(actions, /const rpcStart = performance\.now\(\)/)
  assert.match(actions, /const rpcDuration = performance\.now\(\) - rpcStart/)
  assert.match(actions, /timing:\s*\{[\s\S]*?authMs[\s\S]*?rpcMs[\s\S]*?totalMs[\s\S]*?\}/)
  assert.match(actions, /console\.info\('\[confirmSalesOrderPreparationLine:timing\]'/)
})

test('2. requireWmsPermission paraleliza verificaciones independientes dependientes de user', () => {
  // Paso 1: Paraleliza profile, activeCompanyId y moduleAllowed
  assert.match(authorization, /Promise\.all\(\[\s*supabase\s*\.from\('users'\)[\s\S]*?getActiveCompanyId\(user\)[\s\S]*?p_permission_code:\s*'module\.logistica\.view'/)
  // Paso 2: Paraleliza company, effectiveRole y permisos adicionales
  assert.match(authorization, /Promise\.all\(\[\s*createAdminClient\(\)[\s\S]*?getEffectiveCompanyRole\(user\.id,\s*companyId\)/)
})

test('3. requirePreparationLineConfirmationAuthorization reutiliza card validada y no duplica consultas a la DB', () => {
  // requirePreparationCardAccess debe recibir opcionalmente la tarjeta ya leída
  assert.match(authorization, /export async function requirePreparationCardAccess\([\s\S]*?existingCard\?:/)
  assert.match(authorization, /requirePreparationCardAccess\(auth,\s*card\.id,\s*card\)/)
  // En caso de que se pase existingCard y su estado sea distinto de AUDITED, no debe consultar la base de datos
  assert.match(authorization, /if \(!existingCard\) \{[\s\S]*?from\('sales_order_preparation_cards'\)/)
  assert.match(authorization, /if \(cardStatus !== 'AUDITED'\) return/)
})

test('4. Todas las comprobaciones de autorización, estado y bloqueo se conservan intactas', () => {
  assert.match(authorization, /if \(authError \|\| !user\) throw new Error\('No autorizado'\)/)
  assert.match(authorization, /if \(profileError \|\| !profile \|\| !profile\.is_active \|\| profile\.deleted_at\)/)
  assert.match(authorization, /if \(!companyId\) throw new Error\('No se ha seleccionado una empresa activa'\)/)
  assert.match(authorization, /if \(companyError \|\| !company \|\| !company\.is_active\)/)
  assert.match(authorization, /if \(modulePermissionError \|\| moduleAllowed !== true\)/)
  assert.match(authorization, /if \(!auth\.isOperatorBodega\) \{\s*throw new Error\('No autorizado para esta operación'\)/)
  assert.match(authorization, /if \(card\.status !== 'IN_PREPARATION'\)/)
  assert.match(authorization, /if \(!card\.locked_by_user_id\)/)
  assert.match(authorization, /if \(card\.locked_by_user_id !== auth\.user\.id\)/)
})

test('5. El frontend en sales-order-drawer.tsx refleja el desglose de tiempo del servidor en consola', () => {
  assert.match(drawer, /result\.timing\.authMs/)
  assert.match(drawer, /result\.timing\.rpcMs/)
  assert.match(drawer, /Autorización \(servidor\):/)
  assert.match(drawer, /RPC PostgreSQL \(Supabase\):/)
})

test('6. No se usan cachés globales o compartidas entre usuarios para autorización', () => {
  // requireWmsPermission no debe leer de ningún Map global ni caché compartida
  assert.doesNotMatch(authorization, /globalAuthCache/)
  assert.doesNotMatch(authorization, /authCache\.get/)
})

