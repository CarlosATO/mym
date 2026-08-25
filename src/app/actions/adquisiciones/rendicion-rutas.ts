'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getActiveCompanyId } from '@/app/actions/companies'

export interface RouteSettlementsDashboardKpis {
  pending_count: number
  in_review_count: number
  settled_count: number
  with_difference_count: number
}

export interface RouteSettlementsDashboardRow {
  route_guide_id: string
  guide_number: string | null
  guide_date: string | null
  route_name: string | null
  driver_name: string | null
  seller_name: string | null
  total_route_amount: number
  total_cash_expected: number
  total_check_expected: number
  total_transfer_expected: number
  total_credit_amount: number
  total_cash_received: number
  total_cash_difference: number
  total_transfer_confirmed: number
  total_transfer_pending: number
  total_invoices: number
  paid_count: number
  total_rendible_count: number
  settlement_id: string | null
  settlement_number: string | null
  settlement_status: string | null
  has_worked_items: boolean
  operational_status: 'PENDING_SETTLEMENT' | 'CREATED_NOT_REVIEWED' | 'IN_REVIEW' | 'SETTLED' | 'SETTLED_WITH_DIFFERENCE' | 'CLOSED' | 'CANCELLED'
  action_type: 'CREATE' | 'VIEW'
}

export interface CreateRouteSettlementResult {
  success: true
  settlement_id: string
  route_guide_id: string
  settlement_number: string
  status: string
  created: boolean
  replayed: boolean
}

export interface RouteSettlementDetailInvoice {
  settlement_item_id: string
  route_guide_item_id: string
  invoice_number: string
  expected_payment_method: string
  expected_amount: number
  customer_bsale_id: number | null
  applied_amount: number
  unapplied_amount: number
  invoice_result: 'PENDING' | 'PARTIAL' | 'PAID' | 'PENDING_PAYMENT' | 'CREDIT' | 'NOT_DELIVERED' | 'REVIEW_REQUIRED'
  resolved_for_settlement: boolean
  resolution_type: 'PENDING_PAYMENT' | 'CREDIT' | 'NOT_DELIVERED' | 'REVIEW_REQUIRED' | null
  resolution_notes: string | null
  resolved_by: string | null
  resolved_at: string | null
  legacy_status: string
  legacy_received_amount: number
  legacy_difference_amount: number
  legacy_notes: string | null
}

export interface RouteSettlementDetailAllocation {
  allocation_id: string
  settlement_item_id: string
  invoice_number: string
  amount_applied: number
  voided_at: string | null
}

export interface RouteSettlementDetailPayment {
  id: string
  payment_method_received: string
  amount_received: number
  amount_applied: number
  unallocated_amount: number
  verification_status: string
  received_at: string
  reference_number: string | null
  bank_name: string | null
  check_number: string | null
  check_date: string | null
  notes: string | null
  custody_user_id: string | null
  custody_received_at: string | null
  voided_at: string | null
  void_reason: string | null
  allocations: RouteSettlementDetailAllocation[]
}

export interface RouteSettlementDetailClient {
  customer_bsale_id: number | null
  customer_name: string
  rut: string | null
  invoice_count: number
  expected_amount: number
  applied_amount: number
  pending_amount: number
  payment_count: number
  resolved_invoice_count: number
  unresolved_invoice_count: number
  review_required_count: number
  status: 'PENDING' | 'PARTIAL' | 'PAID'
  invoices: RouteSettlementDetailInvoice[]
  payments: RouteSettlementDetailPayment[]
}

export interface RouteSettlementBlockingInvoice {
  settlement_item_id: string
  invoice_number: string
  customer_bsale_id: number | null
  customer_name: string
  reason: string
}

export interface RouteSettlementDetail {
  settlement: {
    id: string
    settlement_number: string
    route_guide_id: string
    route_guide_number: string
    guide_date: string
    settlement_date: string
    workflow_status: string | null
    financial_result: string | null
    derived_workflow_status: string | null
    derived_financial_result: string | null
    can_close: boolean
    unresolved_invoice_count: number
    resolved_invoice_count: number
    review_required_count: number
    pending_payment_count: number
    credit_count: number
    not_delivered_count: number
    paid_count: number
    partial_count: number
    blocking_invoices: RouteSettlementBlockingInvoice[]
    status: string
    customer_count: number
    invoice_count: number
    total_expected: number
    total_applied_new: number
    total_pending_new: number
    total_difference_new: number
    notes: string | null
  }
  clients: RouteSettlementDetailClient[]
}

export interface RegisterRouteSettlementPaymentInput {
  settlementId: string
  paymentId?: string | null
  customerBsaleId: number
  paymentMethod: 'CASH' | 'TRANSFER' | 'CHECK'
  amountReceived: string
  referenceNumber?: string
  bankName?: string
  checkNumber?: string
  checkDate?: string
  notes?: string
  allocations: Array<{
    settlementItemId: string
    amountApplied: string
  }>
}

function toOperationalStatus(status: string | null, hasWorkedItems: boolean): RouteSettlementsDashboardRow['operational_status'] {
  if (!status) return 'PENDING_SETTLEMENT'
  if (status === 'IN_REVIEW') return hasWorkedItems ? 'IN_REVIEW' : 'PENDING_SETTLEMENT'
  if (status === 'SETTLED') return 'SETTLED'
  if (status === 'SETTLED_WITH_DIFFERENCE') return 'SETTLED_WITH_DIFFERENCE'
  if (status === 'CLOSED') return 'CLOSED'
  if (status === 'CANCELLED') return 'CANCELLED'
  return 'PENDING_SETTLEMENT'
}

async function createAdquisicionesClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'adquisiciones' },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )
}

async function createLogisticaClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'logistica' },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        },
      },
    }
  )
}

async function requirePermission(db: any, userId: string, permissionCode: string) {
  const { data, error } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userId,
    p_permission_code: permissionCode,
  })

  if (error) throw error
  if (!data) throw new Error('No tiene permisos para realizar esta acción.')
}

// 0. getRouteSettlementsDashboardData (Consolidated for performance)
export async function getRouteSettlementsDashboardData() {
  const adquisicionesDb = await createAdquisicionesClient()
  const logisticaDb = await createLogisticaClient()
  
  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const t0 = performance.now()

    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:Server] dashboard start')
    }

    const [settlementsRes, dispatchedGuidesRes] = await Promise.all([
      adquisicionesDb
        .from('route_settlements')
        .select(`
          id,
          route_guide_id,
          settlement_number,
          status,
          total_route_amount,
          total_cash_expected,
          total_check_expected,
          total_transfer_expected,
          total_credit_amount,
          total_cash_received,
          total_cash_difference,
          total_transfer_confirmed,
          total_transfer_pending,
          total_invoices,
          paid_count
        `)
        .eq('company_id', companyId),
      logisticaDb
        .from('route_guides')
        .select(`
          id,
          guide_number,
          guide_date,
          route_name_snapshot,
          driver_name_snapshot,
          seller_name_snapshot,
          total_amount,
          total_cash_expected,
          total_check_expected,
          total_transfer,
          total_credit,
          total_invoices
        `)
        .eq('company_id', companyId)
        .eq('status', 'DISPATCHED')
    ])

    if (settlementsRes.error) throw settlementsRes.error
    if (dispatchedGuidesRes.error) throw dispatchedGuidesRes.error

    const settlementIds = (settlementsRes.data || []).map(settlement => settlement.id)
    const settlementItemsWorkedMap = new Map<string, boolean>()
    const settlementItemStatsMap = new Map<string, { total_rendible_count: number; paid_count: number }>()

    if (settlementIds.length > 0) {
      const settlementItemsRes = await adquisicionesDb
        .from('route_settlement_items')
        .select('settlement_id, expected_payment_method, status, created_at, updated_at')
        .eq('company_id', companyId)
        .in('settlement_id', settlementIds)

      if (settlementItemsRes.error) throw settlementItemsRes.error

      for (const item of settlementItemsRes.data || []) {
        const alreadyWorked = settlementItemsWorkedMap.get(item.settlement_id) === true
        if (!alreadyWorked && item.updated_at !== item.created_at) {
          settlementItemsWorkedMap.set(item.settlement_id, true)
          continue
        }

        if (!settlementItemsWorkedMap.has(item.settlement_id)) {
          settlementItemsWorkedMap.set(item.settlement_id, false)
        }

        const effectiveMethod = (['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(item.status))
          ? (item.status === 'PAID_CASH' ? 'CASH' : item.status === 'TRANSFER_CONFIRMED' ? 'TRANSFER' : 'CHECK')
          : item.expected_payment_method

        if (['CASH', 'TRANSFER', 'CHECK'].includes(effectiveMethod)) {
          const current = settlementItemStatsMap.get(item.settlement_id) ?? { total_rendible_count: 0, paid_count: 0 }
          current.total_rendible_count += 1
          if (['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(item.status)) {
            current.paid_count += 1
          }
          settlementItemStatsMap.set(item.settlement_id, current)
        }
      }
    }

    const guideRendibleCountMap = new Map<string, number>()
    const dispatchedGuideIds = (dispatchedGuidesRes.data || []).map(guide => guide.id)
    if (dispatchedGuideIds.length > 0) {
      const guideItemsRes = await logisticaDb
        .from('route_guide_items')
        .select('route_guide_id, payment_method_normalized')
        .eq('company_id', companyId)
        .in('route_guide_id', dispatchedGuideIds)

      if (guideItemsRes.error) throw guideItemsRes.error

      for (const item of guideItemsRes.data || []) {
        if (!['CASH', 'TRANSFER', 'CHECK'].includes(item.payment_method_normalized)) continue
        guideRendibleCountMap.set(item.route_guide_id, (guideRendibleCountMap.get(item.route_guide_id) ?? 0) + 1)
      }
    }

    const settlementsByGuideId = new Map(
      (settlementsRes.data || []).map(settlement => [settlement.route_guide_id, settlement])
    )

    const rows: RouteSettlementsDashboardRow[] = (dispatchedGuidesRes.data || []).map(guide => {
      const settlement = settlementsByGuideId.get(guide.id)
      const hasWorkedItems = settlement ? settlementItemsWorkedMap.get(settlement.id) === true : false
      const settlementItemStats = settlement ? settlementItemStatsMap.get(settlement.id) : null
      const operationalStatus = toOperationalStatus(settlement?.status ?? null, hasWorkedItems)

      return {
        route_guide_id: guide.id,
        guide_number: guide.guide_number,
        guide_date: guide.guide_date,
        route_name: guide.route_name_snapshot,
        driver_name: guide.driver_name_snapshot,
        seller_name: guide.seller_name_snapshot,
        total_route_amount: Number(settlement?.total_route_amount ?? guide.total_amount ?? 0),
        total_cash_expected: Number(settlement?.total_cash_expected ?? guide.total_cash_expected ?? 0),
        total_check_expected: Number(settlement?.total_check_expected ?? guide.total_check_expected ?? 0),
        total_transfer_expected: Number(settlement?.total_transfer_expected ?? guide.total_transfer ?? 0),
        total_credit_amount: Number(settlement?.total_credit_amount ?? guide.total_credit ?? 0),
        total_cash_received: Number(settlement?.total_cash_received ?? 0),
        total_cash_difference: Number(settlement?.total_cash_difference ?? 0),
        total_transfer_confirmed: Number(settlement?.total_transfer_confirmed ?? 0),
        total_transfer_pending: Number(settlement?.total_transfer_pending ?? guide.total_transfer ?? 0),
        total_invoices: Number(settlement?.total_invoices ?? guide.total_invoices ?? 0),
        paid_count: Number(settlementItemStats?.paid_count ?? settlement?.paid_count ?? 0),
        total_rendible_count: Number(settlementItemStats?.total_rendible_count ?? guideRendibleCountMap.get(guide.id) ?? 0),
        settlement_id: settlement?.id ?? null,
        settlement_number: settlement?.settlement_number ?? null,
        settlement_status: settlement?.status ?? null,
        has_worked_items: hasWorkedItems,
        operational_status: operationalStatus,
        action_type: settlement ? 'VIEW' : 'CREATE'
      }
    })

    rows.sort((a, b) => (b.guide_number || '').localeCompare(a.guide_number || ''))

    const kpis: RouteSettlementsDashboardKpis = {
      pending_count: rows.filter(row => row.operational_status === 'PENDING_SETTLEMENT').length,
      in_review_count: rows.filter(row => row.operational_status === 'IN_REVIEW').length,
      settled_count: rows.filter(row => row.operational_status === 'SETTLED').length,
      with_difference_count: rows.filter(row => row.operational_status === 'SETTLED_WITH_DIFFERENCE').length
    }

    const t1 = performance.now()

    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:Server] rows count', rows.length)
      console.log('[RendicionRutas:Server] dashboard end', `${Math.round(t1 - t0)}ms`)
    }

    return { 
      data: {
        kpis,
        rows
      }, 
      error: null 
    }
  } catch (err: any) {
    console.error('getRouteSettlementsDashboardData error:', err)
    return { data: null, error: err.message }
  }
}

// 1. getPendingRouteGuidesForSettlement
export async function getPendingRouteGuidesForSettlement() {
  const adquisicionesDb = await createAdquisicionesClient()
  const logisticaDb = await createLogisticaClient()
  
  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    // Find company_id
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')


    // get guides that are DISPATCHED
    const { data, error } = await logisticaDb
      .from('route_guides')
      .select(`
        id, guide_number, guide_date, route_name_snapshot, vehicle_name_snapshot,
        driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot,
        total_amount, total_cash_expected, total_check_expected, total_transfer, total_credit, total_invoices
      `)
      .eq('company_id', companyId)
      .eq('status', 'DISPATCHED')
      .order('guide_date', { ascending: false })

    if (error) throw error

    // Fetch existing settlements to filter out
    const { data: existingSettlements, error: esError } = await adquisicionesDb
      .from('route_settlements')
      .select('route_guide_id')
      .eq('company_id', companyId)
      .neq('status', 'CANCELLED')
    
    if (esError) throw esError

    const existingGuideIds = new Set(existingSettlements?.map((s: { route_guide_id: string }) => s.route_guide_id) || [])

    const pendingGuides = data?.filter((guide: { id: string }) => !existingGuideIds.has(guide.id)) || []

    return { data: pendingGuides, error: null }
  } catch (err: any) {
    console.error('getPendingRouteGuidesForSettlement error:', err)
    return { data: null, error: err.message }
  }
}

// 2. getRouteSettlements
export async function getRouteSettlements() {
  const adquisicionesDb = await createAdquisicionesClient()
  const logisticaDb = await createLogisticaClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    // Find company_id
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')



    const { data, error } = await adquisicionesDb
      .from('route_settlements')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Fetch guide info manually to avoid cross-schema join issues in PostgREST
    const guideIds = Array.from(new Set(data?.map((s: { route_guide_id: string }) => s.route_guide_id) || []))
    
    let guidesMap: Record<string, any> = {}
    if (guideIds.length > 0) {
      const { data: guidesData } = await logisticaDb
        .from('route_guides')
        .select('id, guide_number, route_name_snapshot, driver_name_snapshot, seller_name_snapshot')
        .eq('company_id', companyId)
        .in('id', guideIds)
      
      if (guidesData) {
        guidesMap = guidesData.reduce((acc: Record<string, any>, g: any) => {
          acc[g.id] = g
          return acc
        }, {})
      }
    }

    const mappedData = data?.map((s: any) => {
      const g = guidesMap[s.route_guide_id] || {}
      return {
        ...s,
        guide_number: g.guide_number,
        route_name: g.route_name_snapshot,
        driver_name: g.driver_name_snapshot,
        seller_name: g.seller_name_snapshot
      }
    }) || []

    return { data: mappedData, error: null }
  } catch (err: any) {
    console.error('getRouteSettlements error:', err)
    return { data: null, error: err.message }
  }
}

async function findExistingRouteSettlement(
  db: Awaited<ReturnType<typeof createAdquisicionesClient>>,
  companyId: string,
  routeGuideId: string
): Promise<CreateRouteSettlementResult | null> {
  const { data, error } = await db
    .from('route_settlements')
    .select('id, route_guide_id, settlement_number, status')
    .eq('company_id', companyId)
    .eq('route_guide_id', routeGuideId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  if (data.status === 'CANCELLED') {
    throw new Error('La guía ya tiene una rendición anulada y no puede reutilizarse.')
  }

  return {
    success: true,
    settlement_id: data.id,
    route_guide_id: data.route_guide_id,
    settlement_number: data.settlement_number,
    status: data.status,
    created: false,
    replayed: true,
  }
}

function isUniqueViolation(error: { code?: string; message?: string } | null) {
  return error?.code === '23505' || /unique|duplicate key|duplicate record/i.test(error?.message ?? '')
}

// 3. createRouteSettlementFromGuide
export async function createRouteSettlementFromGuide(routeGuideId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.create')

    const existing = await findExistingRouteSettlement(adquisicionesDb, companyId, routeGuideId)
    if (existing) return { data: existing, error: null }

    const { data, error } = await adquisicionesDb.rpc('create_route_settlement_from_guide', {
      p_route_guide_id: routeGuideId,
      p_user_id: userData.user.id
    })

    if (error) {
      if (isUniqueViolation(error)) {
        const racedSettlement = await findExistingRouteSettlement(adquisicionesDb, companyId, routeGuideId)
        if (racedSettlement) return { data: racedSettlement, error: null }
        throw new Error('No se pudo iniciar la rendición porque la guía fue procesada simultáneamente.')
      }
      throw new Error(error.message || 'No se pudo crear la rendición.')
    }

    if (!data?.success || !data.id || !data.settlement_number) {
      throw new Error(data?.error || 'No se pudo iniciar la rendición.')
    }

    return {
      data: {
        success: true,
        settlement_id: data.id,
        route_guide_id: data.route_guide_id ?? routeGuideId,
        settlement_number: data.settlement_number,
        status: data.status ?? 'IN_REVIEW',
        created: data.created ?? true,
        replayed: data.replayed ?? false,
      } satisfies CreateRouteSettlementResult,
      error: null,
    }
  } catch (err: any) {
    console.error('createRouteSettlementFromGuide error:', err)
    return { data: null, error: err.message }
  }
}

// 4. getRouteSettlementById
export async function getRouteSettlementById(settlementId: string) {
  const adquisicionesDb = await createAdquisicionesClient()
  const logisticaDb = await createLogisticaClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    // Find company_id
    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')



    // Query 1: settlement
    const { data: settlement, error: sError } = await adquisicionesDb
      .from('route_settlements')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', settlementId)
      .single()
    if (sError) throw sError

    // Query 2: items
    const { data: items, error: iError } = await adquisicionesDb
      .from('route_settlement_items')
      .select('*')
      .eq('company_id', companyId)
      .eq('settlement_id', settlementId)
      .order('created_at', { ascending: true })
    if (iError) throw iError

    // Query 3: guide info
    const { data: guide, error: gError } = await logisticaDb
      .from('route_guides')
      .select('guide_number, guide_date, route_name_snapshot, vehicle_name_snapshot, driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot')
      .eq('company_id', companyId)
      .eq('id', settlement.route_guide_id)
      .single()
    if (gError) throw gError

    return { 
      data: {
        ...settlement,
        items: items || [],
        guide_info: guide
      }, 
      error: null 
    }
  } catch (err: any) {
    console.error('getRouteSettlementById error:', err)
    return { data: null, error: err.message }
  }
}

export async function getRouteSettlementDetail(settlementId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const { data, error } = await adquisicionesDb.rpc('get_route_settlement_detail', {
      p_settlement_id: settlementId,
    })

    if (error) throw error
    if (!data?.settlement || data.settlement.id === undefined) {
      throw new Error('No se pudo cargar el detalle de la rendición.')
    }

    return { data: data as RouteSettlementDetail, error: null }
  } catch (err: any) {
    console.error('getRouteSettlementDetail error:', err)
    return { data: null, error: err.message }
  }
}

export async function closeRouteSettlement(settlementId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.close')

    const { data, error } = await adquisicionesDb.rpc('close_route_settlement', {
      p_settlement_id: settlementId,
      p_user_id: userData.user.id,
    })

    if (error) {
      const message = error.message || ''
      if (/sin resolver|unresolved|no resuelta/i.test(message)) {
        throw new Error('Todavía existen facturas por resolver.')
      }
      if (/requieren revisión|review|required/i.test(message)) {
        throw new Error('Hay facturas que requieren revisión antes de cerrar.')
      }
      if (/cerrada|cancelada|already closed/i.test(message)) {
        throw new Error('Esta rendición ya está cerrada.')
      }
      if (/permiso|permission|autoriz/i.test(message)) {
        throw new Error('No tienes permisos para cerrar esta rendición.')
      }
      throw new Error('No se pudo cerrar la rendición. Inténtalo nuevamente.')
    }

    return { data, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo cerrar la rendición.'
    console.error('closeRouteSettlement error:', err)
    return { data: null, error: message }
  }
}

export type RouteSettlementResolutionType = 'PENDING_PAYMENT' | 'CREDIT' | 'NOT_DELIVERED' | 'REVIEW_REQUIRED'

export async function setRouteSettlementItemResolution(
  settlementItemId: string,
  resolutionType: RouteSettlementResolutionType | null,
  resolutionNotes: string | null
) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    const notes = resolutionNotes?.trim() || null
    if ((resolutionType === 'NOT_DELIVERED' || resolutionType === 'REVIEW_REQUIRED') && !notes) {
      throw new Error('Debes ingresar un motivo.')
    }

    const { data, error } = await adquisicionesDb.rpc('set_route_settlement_item_resolution', {
      p_settlement_item_id: settlementItemId,
      p_resolution_type: resolutionType,
      p_resolution_notes: notes,
    })

    if (error) {
      const message = error.message || ''
      if (/no puedes marcar como no entregada|allocation|pago aplicado|applied/i.test(message)) {
        throw new Error('No puedes marcar como no entregada una factura que ya tiene un pago aplicado.')
      }
      if (/motivo|obligatorio|notes/i.test(message)) throw new Error('Debes ingresar un motivo.')
      if (/permiso|permission|autoriz/i.test(message)) throw new Error('No tienes permisos para modificar esta rendición.')
      throw new Error('No se pudo actualizar la situación de la factura. Inténtalo nuevamente.')
    }

    return { data, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo actualizar la situación de la factura.'
    console.error('setRouteSettlementItemResolution error:', err)
    return { data: null, error: message }
  }
}

export async function registerRouteSettlementPayment(input: RegisterRouteSettlementPaymentInput) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    if (!/^[1-9]\d*$/.test(input.amountReceived)) {
      throw new Error('El monto recibido debe ser un número entero mayor que cero.')
    }
    if (!input.allocations.some(allocation => /^[1-9]\d*$/.test(allocation.amountApplied))) {
      throw new Error('Debes aplicar un monto a al menos una factura.')
    }
    if (input.paymentMethod === 'CHECK' && !input.checkNumber?.trim()) {
      throw new Error('El número de cheque es obligatorio.')
    }

    const { data, error } = await adquisicionesDb.rpc('upsert_route_settlement_payment', {
      p_settlement_id: input.settlementId,
      p_payment_id: input.paymentId ?? null,
      p_customer_bsale_id: input.customerBsaleId,
      p_payment_method_received: input.paymentMethod,
      p_amount_received: input.amountReceived,
      p_received_at: new Date().toISOString(),
      p_verification_status: 'CONFIRMED',
      p_reference_number: input.referenceNumber?.trim() || null,
      p_bank_name: input.bankName?.trim() || null,
      p_check_number: input.checkNumber?.trim() || null,
      p_check_date: input.checkDate || null,
      p_notes: input.notes?.trim() || null,
      p_allocations: input.allocations.map(allocation => ({
        settlement_item_id: allocation.settlementItemId,
        amount_applied: allocation.amountApplied,
      })),
    })

    if (error) {
      const message = error.message || ''
      if (/superan|supera expected|amount_received/i.test(message)) {
        throw new Error('El monto aplicado supera el límite permitido para una factura o para el pago.')
      }
      if (/cliente|customer_bsale|factura.*rendici[oó]n|pertenece/i.test(message)) {
        throw new Error('Una de las facturas no pertenece a este cliente o rendición.')
      }
      if (/cerrada|cancelada/i.test(message)) {
        throw new Error('La rendición ya no está disponible para registrar pagos.')
      }
      throw new Error('No se pudo registrar el pago. Revisa los datos e inténtalo nuevamente.')
    }

    return { data, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo registrar el pago.'
    console.error('registerRouteSettlementPayment error:', err)
    return { data: null, error: message }
  }
}

export async function voidRouteSettlementPayment(paymentId: string, voidReason: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    if (!voidReason.trim()) throw new Error('El motivo de anulación es obligatorio.')

    const { data, error } = await adquisicionesDb.rpc('void_route_settlement_payment', {
      p_payment_id: paymentId,
      p_void_reason: voidReason.trim(),
    })

    if (error) {
      const message = error.message || ''
      if (/ya est[aá] anulado|VOIDED/i.test(message)) throw new Error('Este pago ya fue anulado.')
      if (/cerrada|cancelada/i.test(message)) throw new Error('La rendición ya no permite modificaciones.')
      throw new Error('No se pudo anular el pago. Inténtalo nuevamente.')
    }

    return { data, error: null }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No se pudo anular el pago.'
    console.error('voidRouteSettlementPayment error:', err)
    return { data: null, error: message }
  }
}

// ─── Fase 3 ──────────────────────────────────────────────────────────────────

export interface RouteGuideWorkspaceItem {
  id: string
  line_number: number
  invoice_number: string
  customer_name: string
  customer_address: string
  commune: string
  amount: number
  payment_method_normalized: 'CASH' | 'CHECK' | 'TRANSFER' | 'CREDIT' | 'UNKNOWN'
  payment_method_original: string | null
  requires_settlement: boolean
}

export interface RouteGuideWorkspaceData {
  guide: {
    id: string
    company_id: string
    guide_number: string
    guide_date: string
    route_name_snapshot: string
    vehicle_name_snapshot: string
    driver_name_snapshot: string | null
    seller_name_snapshot: string | null
    dispatcher_name_snapshot: string
    total_invoices: number
    total_amount: number
    total_cash_expected: number
    total_check_expected: number
    total_credit: number
    total_transfer: number
  }
  items: RouteGuideWorkspaceItem[]
}

/**
 * 5. getRouteGuideWorkspaceData
 * Lee la guía + sus ítems desde logistica. Solo lectura. NO crea RR.
 * Se llama al hacer doble clic en una guía sin rendición.
 */
export async function getRouteGuideWorkspaceData(routeGuideId: string) {
  const logisticaDb = await createLogisticaClient()

  try {
    const { data: userData, error: userError } = await logisticaDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')
    await requirePermission(logisticaDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const [guideRes, itemsRes] = await Promise.all([
      logisticaDb
        .from('route_guides')
        .select(`
          id, company_id, guide_number, guide_date,
          route_name_snapshot, vehicle_name_snapshot,
          driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot,
          total_invoices, total_amount, total_cash_expected,
          total_check_expected, total_credit, total_transfer
        `)
        .eq('company_id', companyId)
        .eq('id', routeGuideId)
        .single(),
      logisticaDb
        .from('route_guide_items')
        .select(`
          id, line_number, invoice_number, customer_name,
          customer_address, commune, amount,
          payment_method_normalized, payment_method_original, requires_settlement
        `)
        .eq('company_id', companyId)
        .eq('route_guide_id', routeGuideId)
        .order('line_number', { ascending: true }),
    ])

    if (guideRes.error) throw guideRes.error
    if (itemsRes.error) throw itemsRes.error
    if (!guideRes.data) throw new Error('Guía no encontrada')

    return {
      data: {
        guide: guideRes.data,
        items: (itemsRes.data || []) as RouteGuideWorkspaceItem[],
      } satisfies RouteGuideWorkspaceData,
      error: null,
    }
  } catch (err: any) {
    console.error('getRouteGuideWorkspaceData error:', err)
    return { data: null, error: err.message as string }
  }
}

export interface SettlementItemUpdate {
  id: string           // route_settlement_item id
  received_amount: number
  status: string
  notes: string | null
  transfer_confirmed: boolean
  transfer_reference: string | null
  check_received: boolean
  check_bank: string | null
  check_number: string | null
  check_amount: number | null
  is_pending: boolean
  requires_followup: boolean
}

export interface SaveRouteSettlementResult {
  settlement_id: string
  settlement_number: string
  settlement_status: string
  operational_status: RouteSettlementsDashboardRow['operational_status']
  item_id_map: Record<string, string>
}

/**
 * 6. saveRouteSettlementChanges
 * Guarda cambios reales en la rendición.
 * Si no existe RR para la guía: la crea primero (create_route_settlement_from_guide),
 * luego llama update_route_settlement con los ítems modificados.
 * Si ya existe RR: llama directamente update_route_settlement.
 * Solo los ítems en changedItems son enviados al RPC (el RPC acepta subset).
 * REGLA CRÍTICA: Solo llamar desde el botón "Guardar cambios". Nunca al abrir.
 */
export async function saveRouteSettlementChanges(
  routeGuideId: string,
  changedItems: SettlementItemUpdate[],
  notes: string | null
) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    // 1. Verificar si ya existe RR para esta guía
    const { data: existing, error: existingErr } = await adquisicionesDb
      .from('route_settlements')
      .select('id, settlement_number, status')
      .eq('company_id', companyId)
      .eq('route_guide_id', routeGuideId)
      .neq('status', 'CANCELLED')
      .maybeSingle()

    if (existingErr) throw existingErr

    let settlementId = ''
    let settlementNumber = ''

    if (!existing) {
      // 2a. No existe RR → crear
      await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.create')
      const { data: created, error: createErr } = await adquisicionesDb.rpc(
        'create_route_settlement_from_guide',
        { p_route_guide_id: routeGuideId, p_user_id: userData.user.id }
      )
      if (createErr) {
        if (isUniqueViolation(createErr)) {
          const racedSettlement = await findExistingRouteSettlement(adquisicionesDb, companyId, routeGuideId)
          if (racedSettlement) {
            settlementId = racedSettlement.settlement_id
            settlementNumber = racedSettlement.settlement_number
          } else {
            throw new Error('No se pudo crear la rendición porque la guía fue procesada simultáneamente.')
          }
        } else {
          throw new Error(`Error creando rendición: ${createErr.message}`)
        }
      }
      if (!createErr && !created?.success) throw new Error(created?.error || 'No se pudo crear la rendición')

      if (!settlementId) {
        settlementId = (created.settlement_id ?? created.id) as string
        settlementNumber = created.settlement_number as string
      }
    } else {
      // 2b. Ya existe RR
      settlementId = existing.id
      settlementNumber = existing.settlement_number
    }

    // 3. Obtener el mapa actualizado de ítems para esta rendición
    const { data: dbItems, error: dbItemsErr } = await adquisicionesDb
      .from('route_settlement_items')
      .select('id, route_guide_item_id, invoice_number')
      .eq('company_id', companyId)
      .eq('settlement_id', settlementId)

    if (dbItemsErr) throw dbItemsErr

    const validSettlementItemIds = new Set((dbItems || []).map(si => si.id))
    const guideItemToSettlementItem = new Map(
      (dbItems || []).map(si => [si.route_guide_item_id, si.id])
    )

    // Remap ids from guide_item_id to settlement_item_id si vienen mal desde el cliente
    const remappedItems = changedItems.map(ci => {
      if (validSettlementItemIds.has(ci.id)) {
        return ci // Ya es un settlement_item_id válido
      }
      const resolvedId = guideItemToSettlementItem.get(ci.id)
      if (resolvedId) {
        return { ...ci, id: resolvedId } // Remapeado desde route_guide_item_id
      }
      
      throw new Error(`No se pudo resolver el ID del ítem enviado: ${ci.id}. Asegúrese de enviar IDs válidos de la rendición.`)
    })

    const { data: updated, error: updateErr } = await adquisicionesDb.rpc(
      'update_route_settlement',
      {
        p_settlement_id: settlementId,
        p_items: remappedItems,
        p_notes: notes ?? '',
        p_user_id: userData.user.id,
      }
    )
    if (updateErr) throw new Error(`Error actualizando rendición: ${updateErr.message}`)
    // @ts-ignore
    if (!updated?.id && !updated?.success) throw new Error(updated?.error || 'Error actualizando rendición')

    const { data: itemRows, error: itemRowsErr } = await adquisicionesDb
      .from('route_settlement_items')
      .select('id, route_guide_item_id')
      .eq('company_id', companyId)
      .eq('settlement_id', settlementId)

    if (itemRowsErr) throw itemRowsErr

    const itemIdMap = Object.fromEntries(
      (itemRows || []).map(item => [item.route_guide_item_id, item.id])
    ) as Record<string, string>

    // 3. Leer estado actualizado para refrescar la fila en bandeja
    const { data: refreshed, error: refreshedErr } = await adquisicionesDb
      .from('route_settlements')
      .select('status')
      .eq('company_id', companyId)
      .eq('id', settlementId)
      .single()

    if (refreshedErr) throw refreshedErr

    // Determinar operational_status liviano (sin cargar items)
    const dbStatus = refreshed?.status ?? 'IN_REVIEW'
    let operationalStatus: RouteSettlementsDashboardRow['operational_status'] = 'PENDING_SETTLEMENT'
    if (dbStatus === 'SETTLED') operationalStatus = 'SETTLED'
    else if (dbStatus === 'SETTLED_WITH_DIFFERENCE') operationalStatus = 'SETTLED_WITH_DIFFERENCE'
    else if (dbStatus === 'CLOSED') operationalStatus = 'CLOSED'
    else if (dbStatus === 'CANCELLED') operationalStatus = 'CANCELLED'
    else if (dbStatus === 'IN_REVIEW') operationalStatus = 'IN_REVIEW'

    // Invalidar caché del dashboard para que la próxima carga sea fresca
    // (se hace en el componente llamando loadDashboardData(true))

    return {
      data: {
        settlement_id: settlementId,
        settlement_number: settlementNumber,
        settlement_status: dbStatus,
        operational_status: operationalStatus,
        item_id_map: itemIdMap,
      } satisfies SaveRouteSettlementResult,
      error: null,
    }
  } catch (err: any) {
    console.error('saveRouteSettlementChanges error:', err)
    return { data: null, error: err.message as string }
  }
}
