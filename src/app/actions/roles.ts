'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export interface RoleWithDetails {
  id: string
  name: string
  description: string | null
  is_system: boolean
  is_active: boolean
  user_count: number
  active_user_count: number
  permissions: { id: string; code: string; name: string }[]
  visible_perm_count: number
}

const systemRoleNames = ['SUPER_USUARIO', 'GERENCIA', 'FINANZAS', 'BODEGA', 'VENDEDOR']
const hiddenPermCodes = ['dashboard.view', 'system.admin', 'modules.view', 'modules.manage']

const admin = createAdminClient

export async function getRolesWithDetails(): Promise<RoleWithDetails[]> {
  const a = admin()

  const { data: roles } = await a.from('roles').select('*').order('name')
  if (!roles) return []

  const result: RoleWithDetails[] = []

  for (const role of roles) {
    const { data: perms } = await a.from('role_permissions').select('permission_id').eq('role_id', role.id)
    const permIds = (perms ?? []).map((p: { permission_id: string }) => p.permission_id)
    const { data: permDetails } = permIds.length > 0
      ? await a.from('permissions').select('id, code, name').in('id', permIds)
      : { data: [] }

    const { count: userCount } = await a
      .from('users').select('*', { count: 'exact', head: true })
      .eq('role_id', role.id).is('deleted_at', null)

    const { count: activeUserCount } = await a
      .from('users').select('*', { count: 'exact', head: true })
      .eq('role_id', role.id).eq('is_active', true).is('deleted_at', null)

    const rawPerms = (permDetails ?? []) as { id: string; code: string; name: string }[]
    const visiblePerms = rawPerms.filter(p => !hiddenPermCodes.includes(p.code))

    result.push({
      id: role.id, name: role.name, description: role.description,
      is_system: role.is_system, is_active: role.is_active,
      user_count: userCount ?? 0, active_user_count: activeUserCount ?? 0,
      permissions: rawPerms,
      visible_perm_count: visiblePerms.length,
    })
  }

  return result
}

export async function createRole(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const rawName = (formData.get('name') as string ?? '').trim().toUpperCase().replace(/\s+/g, '_')
  if (!rawName) return { error: 'El nombre del rol es obligatorio' }

  const description = (formData.get('description') as string ?? '').trim()

  const a = admin()

  const { data: existing } = await a.from('roles').select('id').eq('name', rawName).maybeSingle()
  if (existing) return { error: 'Ya existe un rol con ese nombre' }

  const { error } = await a.from('roles').insert({
    name: rawName, description, is_system: false, is_active: true, created_by: user.id,
  })

  if (error) return { error: error.message }
  return { success: true }
}

export async function updateRole(roleId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const a = admin()

  const { data: role } = await a.from('roles').select('name, is_system').eq('id', roleId).single()
  if (!role) return { error: 'Rol no encontrado' }

  const rawName = (formData.get('name') as string ?? '').trim().toUpperCase().replace(/\s+/g, '_')
  const description = (formData.get('description') as string ?? '').trim()

  const updates: Record<string, string> = { description }

  if (rawName && !role.is_system && !systemRoleNames.includes(role.name)) {
    const { data: dup } = await a.from('roles').select('id').eq('name', rawName).neq('id', roleId).maybeSingle()
    if (dup) return { error: 'Ya existe otro rol con ese nombre' }
    updates.name = rawName
  } else if (rawName && (role.is_system || systemRoleNames.includes(role.name))) {
    if (rawName !== role.name) return { error: 'No puedes cambiar el nombre de este rol' }
  }

  const { error } = await a.from('roles').update(updates).eq('id', roleId)
  if (error) return { error: error.message }
  return { success: true }
}

export async function deactivateRole(roleId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const a = admin()

  const { data: role } = await a.from('roles').select('name, is_system, is_active').eq('id', roleId).single()
  if (!role) return { error: 'Rol no encontrado' }

  const { count: activeUsers } = await a
    .from('users').select('*', { count: 'exact', head: true })
    .eq('role_id', roleId).eq('is_active', true).is('deleted_at', null)

  if ((activeUsers ?? 0) > 0) {
    return { error: `No se puede desactivar este rol porque tiene ${activeUsers} usuario(s) activo(s) asociado(s).` }
  }

  const { error } = await a.from('roles').update({ is_active: !role.is_active }).eq('id', roleId)
  if (error) return { error: error.message }
  return { success: true, newStatus: !role.is_active }
}

export async function updateRoleDescription(roleId: string, description: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const a = admin()
  const { error } = await a.from('roles').update({ description }).eq('id', roleId)
  if (error) return { error: error.message }
  return { success: true }
}

export async function getAllPermissions() {
  const a = admin()
  const { data } = await a.from('permissions').select('*, modules!left(code, name)').eq('is_active', true).order('code')
  return data ?? []
}

export async function assignPermissionToRole(roleId: string, permissionId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const a = admin()
  const { data: role } = await a.from('roles').select('name').eq('id', roleId).single()
  if (!role) return { error: 'Rol no encontrado' }

  const { error } = await a.from('role_permissions').insert({ role_id: roleId, permission_id: permissionId, created_by: user.id })
  if (error) return { error: error.message }
  return { success: true }
}

export async function removePermissionFromRole(roleId: string, permissionId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const a = admin()
  const { data: role } = await a.from('roles').select('name').eq('id', roleId).single()
  if (!role) return { error: 'Rol no encontrado' }

  if (role.name === 'SUPER_USUARIO') {
    const { data: perm } = await a.from('permissions').select('code').eq('id', permissionId).single()
    if (perm && ['system.admin', 'usuarios.view', 'usuarios.create', 'usuarios.update', 'usuarios.deactivate', 'roles.view', 'roles.assign', 'modules.view', 'modules.manage', 'audit.view', 'security.view'].includes(perm.code)) {
      return { error: 'No puedes quitar este permiso a SUPER_USUARIO' }
    }
  }

  const { error } = await a.from('role_permissions').delete().eq('role_id', roleId).eq('permission_id', permissionId)
  if (error) return { error: error.message }
  return { success: true }
}
