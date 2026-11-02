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

export async function requirePreparationCardMoveAuthorization(
  cardId: string,
  toStatus: string,
  observation?: string,
): Promise<WmsAuthorization> {
  const auth = await requireWmsPermission('module.logistica.view')

  const hasManagePermission = await hasWmsPermission(auth.user.id, 'logistica.preparation.manage')
  if (hasManagePermission) {
    await requirePreparationCardAccess(auth, cardId)
    return auth
  }

  if (!auth.isOperatorBodega) {
    throw new Error('No autorizado para esta operación')
  }

  if (toStatus !== 'IN_PREPARATION' && toStatus !== 'IN_AUDIT' && toStatus !== 'PENDING_ROUTE_PREP') {
    throw new Error('No autorizado para mover a esta etapa.')
  }

  const db = await createClient()
  const { data: card, error: cardError } = await db
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status, locked_by_user_id')
    .eq('id', cardId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (cardError || !card) {
    throw new Error('Tarjeta no disponible')
  }

  if (toStatus === 'IN_PREPARATION') {
    if (card.status !== 'PENDING_ROUTE_PREP') {
      throw new Error('No autorizado para mover tarjetas fuera de Pendientes.')
    }
  } else if (toStatus === 'IN_AUDIT') {
    if (card.status !== 'IN_PREPARATION') {
      throw new Error('No autorizado para mover tarjetas fuera de En preparación.')
    }
    if (!card.locked_by_user_id) {
      throw new Error('Esta preparación aún no tiene responsable. Tómala antes de moverla.')
    }
    if (card.locked_by_user_id !== auth.user.id) {
      throw new Error('Esta preparación está asignada a otro usuario.')
    }
  } else if (toStatus === 'PENDING_ROUTE_PREP') {
    if (card.status !== 'IN_PREPARATION') {
      throw new Error('No autorizado para mover tarjetas fuera de En preparación.')
    }
    if (!card.locked_by_user_id) {
      throw new Error('Esta preparación aún no tiene responsable. Tómala antes de moverla.')
    }
    if (card.locked_by_user_id !== auth.user.id) {
      throw new Error('Esta preparación está asignada a otro usuario.')
    }
    if (!observation || !observation.trim()) {
      throw new Error('Se requiere observación para retroceder.')
    }
  }

  await requirePreparationCardAccess(auth, cardId)

  return auth
}

export async function requirePreparationLineConfirmationAuthorization(
  lineId: string,
  companyId?: string,
): Promise<WmsAuthorization> {
  const auth = await requireWmsPermission('module.logistica.view')

  if (companyId && companyId !== auth.companyId) {
    throw new Error('Empresa no autorizada')
  }

  const hasManagePermission = await hasWmsPermission(auth.user.id, 'logistica.preparation.manage')
  if (hasManagePermission) {
    return auth
  }

  if (!auth.isOperatorBodega) {
    throw new Error('No autorizado para esta operación')
  }

  const db = await createClient()
  const { data: line, error: lineError } = await db
    .schema('logistica')
    .from('sales_order_preparation_lines')
    .select('id, card_id, company_id')
    .eq('id', lineId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (lineError || !line) {
    throw new Error('Línea no disponible')
  }

  const { data: card, error: cardError } = await db
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status, locked_by_user_id')
    .eq('id', line.card_id)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (cardError || !card) {
    throw new Error('Tarjeta no disponible')
  }

  if (card.status !== 'IN_PREPARATION') {
    throw new Error('La tarjeta debe estar En preparación.')
  }

  if (!card.locked_by_user_id) {
    throw new Error('Esta preparación aún no tiene responsable. Tómala antes de continuar.')
  }

  if (card.locked_by_user_id !== auth.user.id) {
    throw new Error('Esta preparación está asignada a otro usuario.')
  }

  await requirePreparationCardAccess(auth, card.id)

  return auth
}
