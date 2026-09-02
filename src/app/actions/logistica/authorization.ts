'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type WmsAuthorization = {
  user: { id: string }
  companyId: string
}

export async function requireWmsPermission(permissionCode: string | string[]): Promise<WmsAuthorization> {
  const supabase = await createClient()
  const { data: authData, error: authError } = await supabase.auth.getUser()
  const user = authData.user

  if (authError || !user) throw new Error('No autorizado')

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('id, is_active, deleted_at')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError || !profile || !profile.is_active || profile.deleted_at) {
    throw new Error('El usuario no está activo')
  }

  const companyId = await getActiveCompanyId(user)
  if (!companyId) throw new Error('No se ha seleccionado una empresa activa')

  const { data: company, error: companyError } = await createAdminClient()
    .schema('core')
    .from('companies')
    .select('id, is_active')
    .eq('id', companyId)
    .maybeSingle()

  if (companyError || !company || !company.is_active) {
    throw new Error('La empresa activa no está disponible')
  }

  const { data: moduleAllowed, error: modulePermissionError } = await supabase.rpc('user_has_permission', {
    p_user_id: user.id,
    p_permission_code: 'module.logistica.view',
  })

  if (modulePermissionError || moduleAllowed !== true) {
    throw new Error('No autorizado para el módulo WMS')
  }

  for (const requiredPermission of Array.isArray(permissionCode) ? permissionCode : [permissionCode]) {
    const { data: allowed, error: permissionError } = await supabase.rpc('user_has_permission', {
      p_user_id: user.id,
      p_permission_code: requiredPermission,
    })

    if (permissionError || allowed !== true) {
      throw new Error('No autorizado para esta operación')
    }
  }

  return { user: { id: user.id }, companyId }
}
