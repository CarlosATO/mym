'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type WmsAuthorization = {
  user: { id: string }
  companyId: string
  companyName: string
  effectiveRole: string | null
  isOperatorBodega: boolean
}

async function getEffectiveCompanyRole(userId: string, companyId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .schema('core')
    .from('user_company_access')
    .select('role')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw new Error('No se pudo verificar el rol de la empresa activa')
  return typeof data?.role === 'string' ? data.role : null
}

export async function getEffectiveRoleForActiveCompany(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const companyId = await getActiveCompanyId(user)
  if (!companyId) return null
  try {
    return await getEffectiveCompanyRole(user.id, companyId)
  } catch {
    return null
  }
}

export async function hasWmsPermission(userId: string, permissionCode: string): Promise<boolean> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('user_has_permission', {
    p_user_id: userId,
    p_permission_code: permissionCode,
  })
  return !error && data === true
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
    .select('id, is_active, trade_name, business_name')
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

  const effectiveRole = await getEffectiveCompanyRole(user.id, companyId)
  if (!effectiveRole) throw new Error('No se pudo verificar el rol de la empresa activa')

  return {
    user: { id: user.id },
    companyId,
    companyName: company.trade_name || company.business_name || 'Empresa activa',
    effectiveRole,
    isOperatorBodega: effectiveRole === 'OPERADOR_BODEGA',
  }
}

export async function requirePreparationCardAccess(
  auth: WmsAuthorization,
  cardId: string,
): Promise<void> {
  if (!auth.isOperatorBodega) return

  const db = await createClient()
  const { data: card, error: cardError } = await db
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status')
    .eq('id', cardId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (cardError || !card) throw new Error('Tarjeta no disponible')
  if (card.status === 'INVOICED_READY_FOR_ROUTE') throw new Error('No autorizado para esta tarjeta')
  if (card.status !== 'AUDITED') return

  const { data: readiness, error: readinessError } = await db
    .schema('logistica')
    .rpc('get_sales_order_route_readiness_v1', { p_company_id: auth.companyId })
  const row = (readiness ?? []).find((item: { card_id?: string }) => item.card_id === cardId)
  if (readinessError || !row || !['INCIDENTS', 'BLOCKED'].includes(String((row as { route_readiness?: string }).route_readiness))) {
    throw new Error('No autorizado para esta tarjeta')
  }
}
