'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function inventariosAdmin() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'inventarios' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface InventoryResultItem {
  sku: string
  product: string
  barcode: string | null
  theoretical: number
  physical: number
  difference: number
  difference_type: 'FALTANTE' | 'SOBRANTE' | 'SIN_DIFERENCIA'
  provenance: 'RECUENTO' | 'NORMAL'
}

export interface InventoryResultsResult {
  session: {
    id: string
    session_number: number
    name: string
    inventory_type: string
    status: string
    scope_mode: string
    warehouse_name: string | null
    responsible_user_id: string
    responsible_name: string | null
    approved_at: string | null
    approved_by_name: string | null
    exported_at: string | null
    reconciled_at: string | null
    cancelled_at: string | null
    cancelled_by_name: string | null
    cancellation_reason: string | null
    created_at: string
  }
  official_version: {
    version_number: number
    task_count: number
    contribution_count: number
    normal_contribution_count: number
    recount_contribution_count: number
    item_count: number
    approved_at: string
    approved_by_name: string | null
  } | null
  summary: {
    product_count: number
    no_difference: number
    missing: number
    surplus: number
    absolute_difference_total: number
  }
  total: number
  page: number
  page_size: number
  has_more: boolean
  items: InventoryResultItem[]
}

export async function getInventorySessionResults(
  companyId: string,
  sessionId: string,
  search: string,
  differenceType: string,
  page: number,
  pageSize: number
): Promise<{ data: InventoryResultsResult | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_results', {
      p_company_id: companyId,
      p_session_id: sessionId,
      p_search: search,
      p_difference_type: differenceType,
      p_page: page,
      p_page_size: pageSize,
    })
    if (error) {
      console.error('get_inventory_session_results error:', error.message)
      return { data: null, error: 'No se pudieron cargar los resultados.' }
    }
    return { data: data as InventoryResultsResult, error: null }
  } catch (err) {
    console.error('get_inventory_session_results exception:', err)
    return { data: null, error: 'No se pudieron cargar los resultados.' }
  }
}

export async function getActiveCompanyResults(
  sessionId: string,
  filters: { search?: string; difference_type?: string; page?: number; page_size?: number } = {}
): Promise<{ data: InventoryResultsResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getInventorySessionResults(
    companyId,
    sessionId,
    filters.search ?? '',
    filters.difference_type ?? '',
    filters.page ?? 1,
    filters.page_size ?? 50
  )
  return { ...result, companyId }
}

export interface InventoryResultSession {
  id: string
  session_number: number
  name: string
  inventory_type: string
  status: string
  scope_mode: string
  warehouse_id: string | null
  warehouse_name: string | null
  bsale_office_id: number
  responsible_user_id: string | null
  responsible_name: string | null
  approved_at: string | null
  approved_by_name: string | null
  exported_at: string | null
  reconciled_at: string | null
  cancelled_at: string | null
  cancelled_by_name: string | null
  cancellation_reason: string | null
  created_at: string
  task_count: number
}

export interface InventoryResultSessionListResult {
  total: number
  page: number
  page_size: number
  has_more: boolean
  sessions: InventoryResultSession[]
}

export async function listInventoryResultSessions(
  companyId: string,
  statuses: string[],
  search: string,
  page: number,
  pageSize: number
): Promise<{ data: InventoryResultSessionListResult | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_result_sessions', {
      p_company_id: companyId,
      p_statuses: statuses,
      p_search: search,
      p_page: page,
      p_page_size: pageSize,
    })
    if (error) {
      console.error('list_inventory_result_sessions error:', error.message)
      return { data: null, error: 'No se pudieron cargar las jornadas con resultados.' }
    }
    return { data: data as InventoryResultSessionListResult, error: null }
  } catch (err) {
    console.error('list_inventory_result_sessions exception:', err)
    return { data: null, error: 'No se pudieron cargar las jornadas con resultados.' }
  }
}

export async function getActiveCompanyResultSessions(
  filters: { search?: string; page?: number; page_size?: number } = {}
): Promise<{
  data: InventoryResultSessionListResult | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await listInventoryResultSessions(
    companyId,
    ['APPROVED', 'EXPORTED', 'RECONCILED', 'CANCELLED'],
    filters.search ?? '',
    filters.page ?? 1,
    filters.page_size ?? 100
  )
  return { ...result, companyId }
}
