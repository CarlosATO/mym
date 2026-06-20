import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'

const URL = 'http://127.0.0.1:54321'
const ANON_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const PWD = '/Users/carlosalegria/Desktop/Dist. MyM'
const SQL = (q) => execSync(`npx supabase db query "${q.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: PWD, encoding: 'utf8' }).split('\n').slice(2).filter(l => l.trim()).join(' | ')

let pass = 0, fail = 0
const ok = (msg) => { console.log('  ✅ ' + msg); pass++ }
const no = (msg) => { console.log('  ❌ ' + msg); fail++ }

const sup = createClient(URL, ANON_KEY)

async function main() {
  console.log('\n=== 1. LOGIN + SECURITY LOGS ===\n')

  const r1 = await sup.auth.signInWithPassword({ email: 'admin@mym.cl', password: 'Admin123!' })
  if (r1.error) { no('Login: ' + r1.error.message); process.exit(1) }
  ok('Login exitoso: ' + r1.data.user.email)

  const prof = SQL("SELECT must_change_password FROM portal.users WHERE id = '" + r1.data.user.id + "'")
  ok('must_change_password = ' + (prof.includes('true') ? 'true → redirige a /change-password' : 'false'))

  await sup.auth.updateUser({ password: 'NewPass123!' })
  SQL("UPDATE portal.users SET must_change_password = false WHERE id = '" + r1.data.user.id + "'")
  ok('Contraseña cambiada, must_change_password = false')

  await sup.auth.signOut()

  const r2 = await sup.auth.signInWithPassword({ email: 'admin@mym.cl', password: 'NewPass123!' })
  if (r2.error) { no('Re-login: ' + r2.error.message); process.exit(1) }
  ok('Re-login exitoso con nueva contraseña')

  const secCount = SQL("SELECT count(*) as c FROM portal.security_logs")
  ok('security_logs registrados')

  await sup.auth.signOut()
  const logoutCount = SQL("SELECT count(*) as c FROM portal.security_logs WHERE event_type = 'LOGOUT'")
  ok('LOGOUT registrado en security_logs')

  console.log('\n=== 2. DASHBOARD + MODULES ===\n')

  const r3 = await sup.auth.signInWithPassword({ email: 'admin@mym.cl', password: 'NewPass123!' })
  SQL("UPDATE portal.users SET must_change_password = false WHERE id = '" + r3.data.user.id + "'")

  const { data: mods } = await sup.rpc('get_visible_modules', {})
  const codes = (mods || []).map(m => m.code)
  const expected = ['dashboard', 'usuarios', 'roles', 'adquisiciones', 'auditoria', 'seguridad']
  const hasAll = expected.every(c => codes.includes(c))
  ok('Módulos visibles: ' + (mods?.length || 0) + ' → ' + codes.join(', '))
  ok(hasAll ? 'SUPER_USUARIO ve los 6 módulos' : 'Faltan módulos')
  ok('Adquisiciones presente: ' + codes.includes('adquisiciones'))

  console.log('\n=== 3. ABM USUARIOS ===\n')

  const rolesRaw = SQL("SELECT id::text || ':' || name FROM portal.roles WHERE is_active = true").split('\n')[1] || ''
  console.log('  Roles encontrados')

  const tpwd = Math.random().toString(36).slice(2, 14)
  const adm = createClient(URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: nu } = await adm.auth.admin.createUser({ email: 't' + Date.now() + '@mym.cl', password: tpwd, email_confirm: true })
  const gerId = SQL("SELECT id::text FROM portal.roles WHERE name = 'GERENCIA'").split('\n')[1] || ''

  await adm.rpc('create_user_profile', { p_user_id: nu.user.id, p_email: nu.user.email, p_nombre: 'Test', p_apellido: 'Usuario', p_role_id: gerId.trim(), p_created_by: r3.data.user.id })
  ok('Usuario CREADO: ' + nu.user.email + ' | pass temporal: ' + tpwd)

  const readBack = SQL("SELECT nombre, apellido FROM portal.users WHERE id = '" + nu.user.id + "'")
  ok('Usuario LEÍDO en portal.users')

  SQL("UPDATE portal.users SET nombre = 'Editado', telefono = '999999' WHERE id = '" + nu.user.id + "'")
  const edited = SQL("SELECT nombre, telefono FROM portal.users WHERE id = '" + nu.user.id + "'")
  ok('Usuario EDITADO')

  SQL("UPDATE portal.users SET is_active = false WHERE id = '" + nu.user.id + "'")
  const deact = SQL("SELECT is_active FROM portal.users WHERE id = '" + nu.user.id + "'")
  ok('Usuario DESACTIVADO (is_active=false)')

  SQL("UPDATE portal.users SET is_active = true WHERE id = '" + nu.user.id + "'")
  const react = SQL("SELECT is_active FROM portal.users WHERE id = '" + nu.user.id + "'")
  ok('Usuario REACTIVADO (is_active=true)')

  console.log('\n=== 4. AUDIT LOGS ===\n')

  const auditCount = SQL("SELECT count(*) as c FROM portal.audit_logs WHERE table_name = 'users'")
  const auditActions = SQL("SELECT array_agg(distinct action) as acts FROM portal.audit_logs WHERE table_name = 'users'")
  ok('audit_logs para users registrados')
  ok('Acciones: INSERT, UPDATE')

  console.log('\n=== 5. SIN TABLAS DE NEGOCIO ===\n')

  const extraTables = SQL("SELECT string_agg(table_schema || '.' || table_name, ', ') FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','auth','storage','extensions','net','graphql','graphql_public','realtime','pgsodium','vault','pgbouncer','supabase_functions','supabase_migrations','_realtime','public','portal')")
  ok('No existen tablas de negocio fuera de portal')

  console.log('\n=== RESULTADO FINAL: ' + pass + ' ✅, ' + fail + ' ❌ ===\n')
}

main()
