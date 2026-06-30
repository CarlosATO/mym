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
  total_cash_received: number
  total_cash_difference: number
  total_transfer_pending: number
  total_invoices: number
  settlement_id: string | null
  settlement_number: string | null
  settlement_status: string | null
  has_worked_items: boolean
  operational_status: 'PENDING_SETTLEMENT' | 'CREATED_NOT_REVIEWED' | 'IN_REVIEW' | 'SETTLED' | 'SETTLED_WITH_DIFFERENCE' | 'CLOSED' | 'CANCELLED'
  action_type: 'CREATE' | 'VIEW'
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

// 0. getRouteSettlementsDashboardData (Consolidated for performance)
export async function getRouteSettlementsDashboardData() {
  const adquisicionesDb = await createAdquisicionesClient()
  const logisticaDb = await createLogisticaClient()
  
  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')

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
          total_cash_received,
          total_cash_difference,
          total_transfer_pending,
          total_invoices
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
          total_transfer,
          total_invoices
        `)
        .eq('company_id', companyId)
        .eq('status', 'DISPATCHED')
    ])

    if (settlementsRes.error) throw settlementsRes.error
    if (dispatchedGuidesRes.error) throw dispatchedGuidesRes.error

    const settlementIds = (settlementsRes.data || []).map(settlement => settlement.id)
    const settlementItemsWorkedMap = new Map<string, boolean>()

    if (settlementIds.length > 0) {
      const settlementItemsRes = await adquisicionesDb
        .from('route_settlement_items')
        .select('settlement_id, created_at, updated_at')
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
      }
    }

    const settlementsByGuideId = new Map(
      (settlementsRes.data || []).map(settlement => [settlement.route_guide_id, settlement])
    )

    const rows: RouteSettlementsDashboardRow[] = (dispatchedGuidesRes.data || []).map(guide => {
      const settlement = settlementsByGuideId.get(guide.id)
      const hasWorkedItems = settlement ? settlementItemsWorkedMap.get(settlement.id) === true : false
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
        total_cash_received: Number(settlement?.total_cash_received ?? 0),
        total_cash_difference: Number(settlement?.total_cash_difference ?? 0),
        total_transfer_pending: Number(settlement?.total_transfer_pending ?? guide.total_transfer ?? 0),
        total_invoices: Number(settlement?.total_invoices ?? guide.total_invoices ?? 0),
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
    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')


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
    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')



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

// 3. createRouteSettlementFromGuide
export async function createRouteSettlementFromGuide(routeGuideId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')

    const { data, error } = await adquisicionesDb.rpc('create_route_settlement_from_guide', {
      p_route_guide_id: routeGuideId,
      p_user_id: userData.user.id
    })

    if (error) {
      console.error('DB Error:', error);
      throw new Error('No se pudo crear la rendición.');
    }
    return { data, error: null }
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
    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')



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
