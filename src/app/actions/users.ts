'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function getUsers() {
  const admin = createAdminClient()
  const { data } = await admin
    .from('users')
    .select('*, roles!inner(name, description)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  return data ?? []
}

export async function createUser(formData: FormData) {
  const supabase = await createClient()
  const { data: { user: currentUser } } = await supabase.auth.getUser()
  if (!currentUser) return { error: 'No autorizado' }

  const email = formData.get('email') as string
  const nombre = formData.get('nombre') as string
  const apellido = formData.get('apellido') as string
  const roleId = formData.get('roleId') as string
  const tempPassword = crypto.randomUUID().slice(0, 12)

  const admin = createAdminClient()

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { nombre, apellido },
  })

  if (authError) return { error: authError.message }

  const { error: profileError } = await admin.rpc('create_user_profile', {
    p_user_id: authData.user.id,
    p_email: email,
    p_nombre: nombre,
    p_apellido: apellido,
    p_role_id: roleId,
    p_created_by: currentUser.id,
  })

  if (profileError) {
    await admin.auth.admin.deleteUser(authData.user.id)
    return { error: 'Error al crear perfil: ' + profileError.message }
  }

  await admin.rpc('log_security_event', {
    p_event_type: 'ACCOUNT_CREATED',
    p_success: true,
    p_user_id: authData.user.id,
    p_email: email,
    p_metadata: JSON.stringify({ created_by: currentUser.id }),
  })

  return { tempPassword, userId: authData.user.id }
}

export async function updateUser(userId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user: currentUser } } = await supabase.auth.getUser()
  if (!currentUser) return { error: 'No autorizado' }

  const nombre = formData.get('nombre') as string
  const apellido = formData.get('apellido') as string
  const roleId = formData.get('roleId') as string
  const isActive = formData.get('is_active') === 'true'

  const admin = createAdminClient()
  const { error } = await admin
    .from('users')
    .update({ nombre, apellido, role_id: roleId, is_active: isActive })
    .eq('id', userId)

  if (error) return { error: error.message }
  return { success: true }
}

export async function toggleUserStatus(userId: string, activate: boolean) {
  const admin = createAdminClient()
  const { error } = await admin
    .from('users')
    .update({ is_active: activate })
    .eq('id', userId)

  if (error) return { error: error.message }
  return { success: true }
}

export async function getRoles() {
  const admin = createAdminClient()
  const { data } = await admin
    .from('roles')
    .select('*')
    .eq('is_active', true)
    .order('name')
  return data ?? []
}

export async function getVisibleModules() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data } = await supabase.rpc('get_visible_modules', { p_user_id: user.id })
  return data ?? []
}

export async function getCurrentProfile() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle()

  return data
}
