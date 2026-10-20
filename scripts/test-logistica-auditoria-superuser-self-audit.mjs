import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { evaluateAuditTake } from '../src/modules/logistica/auditoria/audit-policy.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020200000_logistica_audit_superuser_self_audit.sql', root), 'utf8')
const baseMigration = await readFile(new URL('supabase/migrations/20261020150000_logistica_sales_order_audit_base.sql', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')

test('A-B. sólo SUPER_USUARIO puede autoauditar', () => {
  assert.equal(evaluateAuditTake({
    actorUserId: 'preparer', preparerUserId: 'preparer', isSuperUsuario: false,
    lockedByUserId: null, canManage: true, canAuthorizeException: true,
  }).ok, false)
  assert.equal(evaluateAuditTake({
    actorUserId: 'preparer', preparerUserId: 'preparer', isSuperUsuario: true,
    lockedByUserId: null, canManage: true, canAuthorizeException: false,
  }).ok, true)
  assert.match(migration, /AND NOT portal\.is_super_usuario\(v_actor\)/)
})

test('C-D. una preparación ajena conserva el acceso permitido', () => {
  for (const isSuperUsuario of [false, true]) {
    assert.equal(evaluateAuditTake({
      actorUserId: 'auditor', preparerUserId: 'preparer', isSuperUsuario,
      lockedByUserId: null, canManage: true, canAuthorizeException: false,
    }).ok, true)
  }
})

test('E. SUPER_USUARIO sin permiso de auditoría no obtiene bypass', () => {
  assert.equal(evaluateAuditTake({
    actorUserId: 'preparer', preparerUserId: 'preparer', isSuperUsuario: true,
    lockedByUserId: null, canManage: false, canAuthorizeException: false,
  }).ok, false)
  assert.match(drawer, /!isSelfAuditBlocked && !canManage/)
})

test('F. autoauditoría no altera el lock exclusivo ni el takeover', () => {
  const locked = evaluateAuditTake({
    actorUserId: 'preparer', preparerUserId: 'preparer', isSuperUsuario: true,
    lockedByUserId: 'other-auditor', canManage: true, canAuthorizeException: false,
  })
  assert.equal(locked.ok, false)
  assert.match(baseMigration, /v_audit\.locked_by_user_id IS NOT NULL/)
  assert.match(migration, /portal\.is_super_usuario\(v_actor\)/)
})

test('G. frontend y backend usan el mismo rol canónico', () => {
  assert.match(panel, /isSuperUsuario=\{roleName === 'SUPER_USUARIO'\}/)
  assert.match(drawer, /const isSelfAuditBlocked = isPreparer && !isSuperUsuario/)
  assert.match(migration, /portal\.is_super_usuario\(v_actor\)/)
  assert.doesNotMatch(migration, /@|email|hardcode/i)
})
