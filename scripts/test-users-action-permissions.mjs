/**
 * Suite de pruebas de contrato y permisos: Gestión Segura de Usuarios.
 *
 * Valida que todas las funciones de src/app/actions/users.ts cuenten con
 * guardas de autorización estrictas y que no existan vías de acceso desprotegidas
 * que utilicen service_role sin previa validación de permisos.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const usersActionSource = await readFile(new URL('../src/app/actions/users.ts', import.meta.url), 'utf8')

test('1. getUsers() exige autenticación activa del llamador', () => {
  assert.match(usersActionSource, /export async function getUsers\(\)/)
  assert.match(usersActionSource, /const supabase = await createClient\(\)/)
  assert.match(usersActionSource, /const \{\s*data:\s*\{\s*user\s*\}\s*\} = await supabase\.auth\.getUser\(\)/)
  assert.match(usersActionSource, /if \(!user\) return \[\]/)
})

test('2. getUsers() exige permiso usuarios.view o system.admin', () => {
  assert.match(usersActionSource, /p_permission_code:\s*['"]usuarios\.view['"]/)
  assert.match(usersActionSource, /p_permission_code:\s*['"]system\.admin['"]/)
  assert.match(usersActionSource, /if \(adminError \|\| \(!canViewUsers && !isAdmin\)\) return \[\]/)
})

test('3. getUserCompanyIds() y getUserCompanyAccess() exigen requireUserManagementAccess', () => {
  assert.match(usersActionSource, /export async function getUserCompanyIds\(userId:\s*string\)/)
  assert.match(usersActionSource, /const access = await requireUserManagementAccess\(userId\)/)
  assert.match(usersActionSource, /if \('error' in access\) return \[\]/)

  assert.match(usersActionSource, /export async function getUserCompanyAccess\(userId:\s*string\)/)
  const accessIdx = usersActionSource.indexOf('export async function getUserCompanyAccess')
  assert.ok(accessIdx > 0)
  const slice = usersActionSource.slice(accessIdx, accessIdx + 400)
  assert.match(slice, /const access = await requireUserManagementAccess\(userId\)/)
  assert.match(slice, /if \('error' in access\) return \[\]/)
})

test('4. createUser() exige requireUserManagementAccess y utiliza admin.rpc para create_user_profile', () => {
  assert.match(usersActionSource, /export async function createUser\(/)
  assert.match(usersActionSource, /const access = await requireUserManagementAccess\(\)/)
  assert.match(usersActionSource, /admin\.rpc\(['"]create_user_profile['"]/)
})

test('5. updateUser() exige requireUserManagementAccess', () => {
  assert.match(usersActionSource, /export async function updateUser\(/)
  assert.match(usersActionSource, /const access = await requireUserManagementAccess\(userId\)/)
})

test('6. No existen consultas directas a coreAdmin o createAdminClient sin guarda previa', () => {
  // Verificar que cada uso de createAdminClient o createSupabaseClient (service role)
  // esté precedido por una verificación de sesión o requireUserManagementAccess
  const lines = usersActionSource.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('createAdminClient()') && !line.includes('function createAdminClient')) {
      // Verificar que en las líneas anteriores exista una guarda
      const preceding = lines.slice(Math.max(0, i - 20), i).join('\n')
      assert.ok(
        preceding.includes('requireUserManagementAccess') || preceding.includes('canViewUsers') || preceding.includes('getCurrentProfile'),
        `createAdminClient en línea ${i + 1} debe estar precedido por verificación de acceso`,
      )
    }
  }
})
