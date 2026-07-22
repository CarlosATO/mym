'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveCompanyId } from '@/app/actions/companies'

export type SalesOrderClientData = {
  rut: string | null
  phone: string | null
  email: string | null
}

export type SalesOrderPreparationCardInfo = {
  card_id: string
  company_id: string
  status: string
  priority: number
  assigned_user_id: string | null
  route_date: string | null
  normalized_city: string | null
  nv_bsale_id: number
  nv_folio: string
  nv_emission_date: string
  nv_generation_date: string
  client_name: string
  city_raw: string | null
  municipality_raw: string | null
  address_raw: string | null
  seller_bsale_id: number | null
  seller_name: string | null
  total_quantity: number
  total_amount: number | null
  net_amount: number | null
  tax_amount: number | null
  gross_amount: number | null
  invoice_folio: string | null
  is_invoiced: boolean
  created_at: string
  updated_at: string
}

export type SalesOrderPreparationItem = {
  detail_id: number
  company_id: string
  nv_bsale_id: number
  nv_folio: number
  variant_id: number | null
  sku: string | null
  product_name: string
  quantity: number
  unit_value: number | null
  total_amount: number | null
  unit_net_value: number | null
  line_net_amount: number | null
  line_tax_amount: number | null
  line_gross_amount: number | null
}

export type PreviewCandidatesResult = {
  total_candidates: number
  already_materialized: number
  pending_to_create: number
}

export type PreviewNextRouteCandidate = {
  bsale_nv_id: number
  nv_folio: string
  client_name: string
  route_location_normalized: string
  route_city_id?: string
  seller_name: string
  nv_emission_date: string
  nv_generation_date: string
  nv_generation_date_chile: string
  net_amount: number
  gross_amount: number
  route_date: string
  cutoff_at: string
  cutoff_at_chile: string
  inclusion_status: string
  reason?: string
  observation?: string
  authorized_by_name?: string
  authorized_at?: string
  card_id?: string
  card_status?: string
  card_route_date?: string
  original_route_date?: string
}

export type PreviewNextRouteResult = {
  has_route: boolean
  route_date?: string
  route_weekday?: number
  cutoff_at?: string
  cutoff_at_chile?: string
  calendar_id?: string
  calendar_name?: string
  cities?: string[]
  counts?: {
    in_cutoff: number
    out_cutoff: number
    exceptions: number
    existing_cards: number
    previous_pending: number
  }
  candidates?: PreviewNextRouteCandidate[]
  out_of_cutoff?: PreviewNextRouteCandidate[]
  authorized_exceptions?: PreviewNextRouteCandidate[]
  existing_cards?: PreviewNextRouteCandidate[]
  previous_pending?: PreviewNextRouteCandidate[]
}

export type SyncNextRouteResult = {
  dry_run: boolean
  has_route: boolean
  route_date?: string
  cities?: string[]
  would_insert_cards?: number
  would_reprogram_cards?: number
  would_materialize_exceptions?: number
  insert_candidates?: any[]
  reprogram_candidates?: any[]
  exception_candidates?: any[]
  message?: string
}

export type SalesOrderPreparationTrace = {
  materialized: number
  existing: number
  outOfCutoff: number
  routeDate: string | null
  cities: string[]
  completedAt: string | null
}

export async function getSalesOrderPreparationBoard(companyId: string) {
  const supabase = await createClient()
  const admin = await createAdminClient()

  // 1. Obtener contexto de la próxima ruta
  const { data: routeCtxData, error: routeErr } = await (admin as any)
    .schema('logistica')
    .rpc('get_next_dispatch_route_context', {
      p_company_id: companyId
    })

  if (routeErr) {
    console.error('getSalesOrderPreparationBoard route error:', routeErr)
    return { data: [], error: routeErr.message }
  }

  const routeCtx = routeCtxData?.[0]
  if (!routeCtx || !routeCtx.route_date) {
    // Si no hay próxima ruta, devolvemos tablero vacío
    return { data: [], error: null }
  }

  const activeRouteDate = routeCtx.route_date
  const activeCities = routeCtx.normalized_cities || []

  // 2. Filtrar tarjetas por la ruta activa
  let query = supabase
    .schema('logistica')
    .from('vw_sales_order_preparation_board')
    .select('*')
    .eq('company_id', companyId)
    .eq('route_date', activeRouteDate)

  if (activeCities.length > 0) {
    query = query.in('normalized_city', activeCities)
  }

  const { data, error } = await query
    .order('priority', { ascending: false })
    .order('nv_emission_date', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationBoard error:', error)
    return { data: [], error: error.message }
  }

  return { data: data as SalesOrderPreparationCardInfo[], error: null }
}

export async function getSalesOrderPreparationItems(companyId: string, bsaleNvId: number) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .schema('integraciones')
    .from('vw_bsale_sales_order_items_for_preparation')
    .select('*')
    .eq('company_id', companyId)
    .eq('nv_bsale_id', bsaleNvId)
    .order('product_name', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationItems error:', error)
    return { data: [], error: error.message }
  }

  return { data: data as SalesOrderPreparationItem[], error: null }
}

export async function previewSalesOrderPreparationCandidates(companyId: string, fromDate: string, toDate: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .rpc('preview_sales_order_preparation_candidates', {
      p_company_id: companyId,
      p_from_date: fromDate,
      p_to_date: toDate
    })

  if (error) {
    console.error('previewSalesOrderPreparationCandidates error:', error)
    return { data: null, error: error.message }
  }

  const result: PreviewCandidatesResult = {
    total_candidates: data?.[0]?.total_candidates ?? 0,
    already_materialized: data?.[0]?.already_materialized ?? 0,
    pending_to_create: data?.[0]?.pending_to_create ?? 0
  }

  return { data: result, error: null }
}

export async function previewNextRouteCandidates() {
  try {
    const supabase = await createClient()
    const admin = await createAdminClient()
    
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('Unauthorized user')
    }

    const companyId = await getActiveCompanyId()

    console.log('[previewNextRouteCandidates] Starting preview', { userId: user.id, companyId })

    const { data, error } = await (admin as any)
      .schema('logistica')
      .rpc('preview_next_route_candidates', {
        p_company_id: companyId,
      })

    if (error) {
      console.error('[previewNextRouteCandidates] RPC error', {
        companyId,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      })
      return { 
        data: null, 
        error: error.message,
        details: error.details ?? null,
        hint: error.hint ?? null,
        code: error.code ?? null
      }
    }

    console.log(`[previewNextRouteCandidates] Success. has_route:`, data?.has_route)
    return { data: data as PreviewNextRouteResult, error: null }
  } catch (err: any) {
    console.error('[previewNextRouteCandidates] Exception:', err)
    return { 
      data: null, 
      error: err?.message || 'Unknown error in previewNextRouteCandidates',
      details: null,
      hint: null,
      code: null
    }
  }
}

export async function getSalesOrderPreparationTrace(): Promise<{ data: SalesOrderPreparationTrace | null; error: string | null }> {
  try {
    const admin = await createAdminClient()
    const companyId = await getActiveCompanyId()
    const { data, error } = await (admin as any)
      .schema('logistica')
      .rpc('preview_next_route_candidates', { p_company_id: companyId })

    if (error) return { data: null, error: error.message }
    if (!data?.has_route) return { data: null, error: null }

    const { data: latestEvent, error: eventError } = await admin
      .schema('logistica')
      .from('sales_order_preparation_route_events')
      .select('performed_at')
      .eq('company_id', companyId)
      .in('event_type', ['MATERIALIZED', 'MATERIALIZED_EXCEPTION'])
      .order('performed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (eventError) return { data: null, error: eventError.message }
    const { count: materialized } = latestEvent?.performed_at
      ? await admin
        .schema('logistica')
        .from('sales_order_preparation_route_events')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('event_type', ['MATERIALIZED', 'MATERIALIZED_EXCEPTION'])
        .eq('performed_at', latestEvent.performed_at)
      : { count: 0 }

    return {
      data: {
        materialized: materialized || 0,
        existing: Number(data.counts?.existing_cards || 0),
        outOfCutoff: Number(data.counts?.out_cutoff || 0),
        routeDate: data.route_date || null,
        cities: data.cities || [],
        completedAt: latestEvent?.performed_at || null,
      },
      error: null,
    }
  } catch (err: any) {
    return { data: null, error: err?.message || 'Error leyendo rastro de preparación' }
  }
}

export async function syncNextRoutePreparationCards(options?: { dryRun?: boolean; confirmation?: string }): Promise<SyncNextRouteResult | null> {
  const isDryRun = options?.dryRun ?? true
  const confirmation = options?.confirmation ?? null

  if (!isDryRun) {
    throw new Error('Real materialization is not authorized from UI yet.')
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('No user found')
  }

  const companyId = await getActiveCompanyId()

  const { data, error } = await supabase.rpc('sync_next_route_preparation_cards', {
    p_company_id: companyId,
    p_user_id: user.id,
    p_dry_run: isDryRun,
    p_confirmation: confirmation
  })

  if (error) {
    console.error('Error in sync_next_route_preparation_cards:', error)
    if (!isDryRun) {
      throw new Error(error.message)
    }
    return null
  }

  return data as SyncNextRouteResult
}

export async function getSalesOrderClientData(companyId: string, bsaleNvId: number): Promise<{ data: SalesOrderClientData | null, error: string | null }> {
  const supabase = await createClient()

  // First get the client_id from the NV document
  const { data: doc, error: docError } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('client_id')
    .eq('company_id', companyId)
    .eq('bsale_id', bsaleNvId)
    .single()

  if (docError || !doc || !doc.client_id) {
    return { data: null, error: docError?.message || 'Document or client not found' }
  }

  // Then fetch the client data
  const { data: client, error: clientError } = await supabase
    .schema('integraciones')
    .from('bsale_clients')
    .select('code, phone, email')
    .eq('company_id', companyId)
    .eq('bsale_client_id', doc.client_id)
    .single()

  if (clientError || !client) {
    return { data: null, error: clientError?.message || 'Client details not found' }
  }

  return { 
    data: { 
      rut: client.code, 
      phone: client.phone, 
      email: client.email 
    }, 
    error: null 
  }
}

export type SalesOrderPreparationMovement = {
  id: string
  company_id: string
  card_id: string
  from_status: string | null
  to_status: string
  moved_by: string | null
  movement_source: string
  pin_validated: boolean
  observation: string | null
  metadata: {
    moved_by_name?: string
  }
  created_at: string
}

export async function moveSalesOrderPreparationCard(params: {
  cardId: string
  toStatus: string
  observation?: string
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    // -----------------------------------------------------------------------
    // 1. Validar usuario autenticado (JWT vía cliente normal)
    // -----------------------------------------------------------------------
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { ok: false, error: 'No autorizado' }
    }

    // -----------------------------------------------------------------------
    // 2. Validar rol usando el cliente admin (service_role) para leer portal
    //    El cliente admin tiene schema portal por defecto (ver admin.ts)
    //    Tablas reales: portal.users (nombre, apellido, role_id)
    //                   portal.roles (id, name)
    // -----------------------------------------------------------------------
    const admin = createAdminClient()

    const { data: profile, error: profileError } = await admin
      .from('users')
      .select('nombre, apellido, email, role_id, roles:role_id(name)')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return { ok: false, error: 'No se pudo verificar el perfil del usuario' }
    }

    const roleName = (profile.roles as any)?.name as string | undefined
    const ALLOWED_ROLES = ['SUPER_USUARIO', 'GERENCIA', 'BODEGA']

    if (!roleName || !ALLOWED_ROLES.includes(roleName)) {
      return {
        ok: false,
        error: `Rol '${roleName ?? 'sin rol'}' no tiene permiso para mover tarjetas. Requiere: ${ALLOWED_ROLES.join(', ')}.`
      }
    }

    // -----------------------------------------------------------------------
    // 3. Obtener nombre real: nombre + apellido, con email como fallback
    //    Columnas reales en portal.users: nombre, apellido, email
    // -----------------------------------------------------------------------
    const nombre   = (profile.nombre   as string | null) ?? ''
    const apellido = (profile.apellido as string | null) ?? ''
    const userName = `${nombre} ${apellido}`.trim() || (profile.email as string | null) || user.id

    // -----------------------------------------------------------------------
    // 4. Obtener companyId en el servidor (nunca desde el frontend)
    // -----------------------------------------------------------------------
    const companyId = await getActiveCompanyId()

    // -----------------------------------------------------------------------
    // 5. Invocar la RPC con service_role
    //    La RPC solo acepta GRANT EXECUTE TO service_role (post-000006)
    //    Se usa schema('logistica') explícito
    // -----------------------------------------------------------------------
    const { data, error } = await admin
      .schema('logistica')
      .rpc('move_sales_order_preparation_card', {
        p_company_id:  companyId,
        p_card_id:     params.cardId,
        p_to_status:   params.toStatus,
        p_observation: params.observation?.trim() || null,
        p_user_id:     user.id,
        p_user_name:   userName,
      })

    if (error) {
      console.error('[moveSalesOrderPreparationCard] RPC error', {
        cardId: params.cardId,
        toStatus: params.toStatus,
        message: error.message,
        details: error.details,
        hint: error.hint,
      })
      return { ok: false, error: error.message }
    }

    return { ok: true, data }
  } catch (err: any) {
    console.error('[moveSalesOrderPreparationCard] Exception:', err)
    return { ok: false, error: err?.message || 'Error desconocido' }
  }
}

export async function getSalesOrderPreparationMovements(
  cardId: string
): Promise<{ data: SalesOrderPreparationMovement[]; error: string | null }> {
  try {
    // -----------------------------------------------------------------------
    // 1. Validar usuario autenticado (JWT)
    // -----------------------------------------------------------------------
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { data: [], error: 'No autorizado' }
    }

    // -----------------------------------------------------------------------
    // 2. Obtener companyId en el servidor
    // -----------------------------------------------------------------------
    const companyId = await getActiveCompanyId()

    // -----------------------------------------------------------------------
    // 3. Leer movimientos con service_role + filtro estricto por company_id
    //    Garantiza aislamiento multi-tenant aunque la tabla no tenga RLS activo
    // -----------------------------------------------------------------------
    const admin = createAdminClient()

    const { data, error } = await admin
      .schema('logistica')
      .from('sales_order_preparation_movements')
      .select('*')
      .eq('company_id', companyId)
      .eq('card_id', cardId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[getSalesOrderPreparationMovements] Error:', error)
      return { data: [], error: error.message }
    }

    return { data: (data ?? []) as SalesOrderPreparationMovement[], error: null }
  } catch (err: any) {
    console.error('[getSalesOrderPreparationMovements] Exception:', err)
    return { data: [], error: err?.message || 'Error desconocido' }
  }
}

export async function authorizeSalesOrderRouteException(params: {
  bsaleNvId: string | number
  routeDate: string
  reason: string
  observation: string
}) {
  if (!params.reason?.trim()) return { ok: false, error: 'El motivo es obligatorio' }
  if (!params.observation?.trim()) return { ok: false, error: 'La observación es obligatoria' }
  if (!params.routeDate) return { ok: false, error: 'La fecha de ruta es obligatoria' }
  if (!params.bsaleNvId || isNaN(Number(params.bsaleNvId))) return { ok: false, error: 'NV ID inválido' }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { ok: false, error: 'No autorizado o sesión expirada' }
  }

  const companyId = await getActiveCompanyId()
  const adminClient = createAdminClient()
  
  const { data: profile, error: profileError } = await adminClient
    .schema('portal')
    .from('users')
    .select('nombre, apellido, email, role_id, roles:role_id(name)')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return { ok: false, error: 'No se pudo validar el perfil del usuario' }
  }

  const roleName = (profile?.roles as any)?.name
  const allowedRoles = ['SUPER_USUARIO', 'GERENCIA', 'BODEGA']
  
  if (!allowedRoles.includes(roleName)) {
    return { ok: false, error: 'No tienes permisos para autorizar excepciones' }
  }

  const authorizedByName =
    `${profile.nombre ?? ''} ${profile.apellido ?? ''}`.trim()
    || profile.email
    || user.email
    || user.id

  const { data, error } = await adminClient
    .schema('logistica')
    .rpc('authorize_sales_order_route_exception', {
      p_company_id: companyId,
      p_bsale_nv_id: Number(params.bsaleNvId),
      p_route_date: params.routeDate,
      p_reason: params.reason.trim(),
      p_observation: params.observation.trim(),
      p_authorized_by: user.id,
      p_authorized_by_name: authorizedByName,
    })

  if (error) {
    console.error('authorize_sales_order_route_exception error:', error)
    return { ok: false, error: error.message }
  }

  return data as any
}
