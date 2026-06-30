'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getActiveCompanyId } from '@/app/actions/companies'

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

    const companyId = await getActiveCompanyId()
    if (!companyId) throw new Error('No se pudo cargar la empresa activa. Verifique que haya una empresa seleccionada.')

    const t0 = performance.now();

    // Fetch existing settlements (and their guide IDs) - All columns to satisfy TypeScript RouteSettlement interface
    const { data: settlementsData, error: sError } = await adquisicionesDb
      .from('route_settlements')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (sError) throw sError

    const existingGuideIds = new Set(
      settlementsData?.filter(s => s.status !== 'CANCELLED').map(s => s.route_guide_id) || []
    )
    const allGuideIds = Array.from(new Set(settlementsData?.map(s => s.route_guide_id) || []))

    // get guides that are DISPATCHED (for pending)
    const { data: dispatchedGuidesData, error: dgError } = await logisticaDb
      .from('route_guides')
      .select(`
        id, guide_number, guide_date, route_name_snapshot, vehicle_name_snapshot,
        driver_name_snapshot, seller_name_snapshot, dispatcher_name_snapshot,
        total_amount, total_cash_expected, total_check_expected, total_transfer, total_credit, total_invoices
      `)
      .eq('company_id', companyId)
      .eq('status', 'DISPATCHED')
      .order('guide_date', { ascending: false })

    if (dgError) throw dgError

    const t1 = performance.now();

    const pendingGuides = dispatchedGuidesData?.filter(guide => !existingGuideIds.has(guide.id)) || []

    const t2 = performance.now();

    // Map settlements with guide data
    let guidesMap: Record<string, any> = {}
    if (allGuideIds.length > 0) {
      const { data: specificGuidesData } = await logisticaDb
        .from('route_guides')
        .select('id, guide_number, guide_date, route_name_snapshot, driver_name_snapshot, seller_name_snapshot, total_amount')
        .eq('company_id', companyId)
        .in('id', allGuideIds)
      
      if (specificGuidesData) {
        guidesMap = specificGuidesData.reduce((acc: Record<string, any>, g: any) => {
          acc[g.id] = g
          return acc
        }, {})
      }
    }

    const t3 = performance.now();

    const mappedSettlements = settlementsData?.map(s => {
      const g = guidesMap[s.route_guide_id] || {}
      return {
        ...s,
        guide_number: g.guide_number,
        route_name: g.route_name_snapshot,
        driver_name: g.driver_name_snapshot,
        seller_name: g.seller_name_snapshot
      }
    }) || []

    // Calculate KPIs
    const kpis = {
      pending_count: pendingGuides.length,
      in_review_count: mappedSettlements.filter(s => s.status === 'IN_REVIEW').length,
      settled_count: mappedSettlements.filter(s => s.status === 'SETTLED').length,
      with_difference_count: mappedSettlements.filter(s => s.status === 'SETTLED_WITH_DIFFERENCE').length
    }

    // Map all dispatched guides (pending)
    const pendingRows = pendingGuides.map(g => ({
      route_guide_id: g.id,
      guide_number: g.guide_number,
      guide_date: g.guide_date,
      route_name: g.route_name_snapshot,
      driver_name: g.driver_name_snapshot,
      seller_name: g.seller_name_snapshot,
      total_route_amount: g.total_amount,
      total_cash_expected: g.total_cash_expected,
      total_cash_received: 0,
      total_cash_difference: g.total_cash_expected,
      total_transfer_pending: g.total_transfer,
      total_invoices: g.total_invoices,
      settlement_id: null,
      settlement_number: null,
      settlement_status: null,
      operational_status: 'PENDING_SETTLEMENT',
      action_type: 'CREATE'
    }))

    // Map existing settlements
    const settlementRows = mappedSettlements.map(s => {
      // Find the corresponding guide to get guide_date and total_amount if not in settlement
      // Wait, we didn't fetch guide_date for allGuideIds in guidesMap. Let's make sure we do!
      // I'll update the guidesMap query below.
      const g = guidesMap[s.route_guide_id] || {}
      return {
        route_guide_id: s.route_guide_id,
        guide_number: g.guide_number || s.guide_number, // fallback if we already mapped it
        guide_date: g.guide_date,
        route_name: g.route_name_snapshot || s.route_name,
        driver_name: g.driver_name_snapshot || s.driver_name,
        seller_name: g.seller_name_snapshot || s.seller_name,
        total_route_amount: s.total_route_amount,
        total_cash_expected: s.total_cash_expected,
        total_cash_received: s.total_cash_received,
        total_cash_difference: s.total_cash_difference,
        total_transfer_pending: s.total_transfer_pending,
        total_invoices: s.total_invoices,
        settlement_id: s.id,
        settlement_number: s.settlement_number,
        settlement_status: s.status,
        operational_status: s.status === 'IN_REVIEW' ? 'CREATED_NOT_REVIEWED' : s.status,
        action_type: 'VIEW'
      }
    })

    const rows = [...pendingRows, ...settlementRows]
    
    // Sort rows by guide_number descending by default (can be adjusted by frontend)
    rows.sort((a, b) => {
      const gA = a.guide_number || ''
      const gB = b.guide_number || ''
      return gB.localeCompare(gA)
    })

    const t4 = performance.now();

    if (process.env.NODE_ENV === 'development') {
      console.log(`[RendicionRutas:Server] dashboard ms: ${Math.round(t4 - t0)}ms`);
      console.log(`[RendicionRutas:Server] rows count: ${rows.length}`);
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
