'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
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

async function getRoleName(roleId: string): Promise<string> {
  const supabase = await createClient()
  const { data } = await supabase.from('roles').select('name').eq('id', roleId).single()
  return data?.name ?? ''
}

export async function createUser(formData: FormData) {
  const supabase = await createClient()
  const { data: { user: currentUser } } = await supabase.auth.getUser()
  if (!currentUser) return { error: 'No autorizado' }

  const email = formData.get('email') as string
  const nombre = formData.get('nombre') as string
  const apellido = formData.get('apellido') as string
  const roleId = formData.get('roleId') as string
  const companyIdsRaw = formData.get('companyIds') as string
  const companyIds: string[] = companyIdsRaw ? JSON.parse(companyIdsRaw) : []
  const tempPassword = crypto.randomUUID().slice(0, 12)

  if (companyIds.length === 0) {
    return { error: 'Debe seleccionar al menos una empresa para el usuario.' }
  }

  const roleName = await getRoleName(roleId)

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

  // Insert into core.user_company_access for each selected company
  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
  for (let i = 0; i < companyIds.length; i++) {
    const { error: accessError } = await coreAdmin
      .from('user_company_access')
      .insert({
        user_id: authData.user.id,
        company_id: companyIds[i],
        role: roleName,
        is_default: i === 0,
        is_active: true,
        created_by: currentUser.id,
      })

    if (accessError) {
      console.error('Error al asignar empresa al usuario:', accessError)
    }
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
  const companyIdsRaw = formData.get('companyIds') as string
  const companyIds: string[] = companyIdsRaw ? JSON.parse(companyIdsRaw) : []

  if (companyIds.length === 0) {
    return { error: 'El usuario debe tener al menos una empresa asignada.' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('users')
    .update({ nombre, apellido, role_id: roleId, is_active: isActive })
    .eq('id', userId)

  if (error) return { error: error.message }

  // Update company access: deactivate removed, add new
  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Get existing access
  const { data: existingAccess } = await coreAdmin
    .from('user_company_access')
    .select('company_id')
    .eq('user_id', userId)
    .eq('is_active', true)

  const existingIds = new Set((existingAccess ?? []).map((a: any) => a.company_id))
  const newIds = new Set(companyIds)

  // Deactivate removed companies
  for (const existingId of existingIds) {
    if (!newIds.has(existingId)) {
      await coreAdmin
        .from('user_company_access')
        .update({ is_active: false, updated_by: currentUser.id })
        .eq('user_id', userId)
        .eq('company_id', existingId)
    }
  }

  // Get role name for new entries
  const roleName = (await supabase.from('roles').select('name').eq('id', roleId).single()).data?.name ?? ''

  // Add new companies
  let defaultSet = false
  for (const newId of newIds) {
    if (!existingIds.has(newId)) {
      await coreAdmin
        .from('user_company_access')
        .insert({
          user_id: userId,
          company_id: newId,
          role: roleName,
          is_default: !defaultSet,
          is_active: true,
          created_by: currentUser.id,
        })
      defaultSet = true
    }
  }

  return { success: true }
}

export async function getUserCompanyIds(userId: string): Promise<string[]> {
  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data } = await coreAdmin
    .from('user_company_access')
    .select('company_id')
    .eq('user_id', userId)
    .eq('is_active', true)
  return (data ?? []).map((a: any) => a.company_id)
}

export async function getAllActiveCompanies() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data } = await coreAdmin
    .from('companies')
    .select('id, business_name, trade_name, rut')
    .eq('is_active', true)
    .order('business_name')
  return data ?? []
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
