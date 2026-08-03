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

export interface InventorySessionSummary {
  id: string
  session_number: number
  name: string
  inventory_type: string
  status: string
  scope_mode: string
  warehouse_id: string | null
  bsale_office_id: number
  responsible_user_id: string | null
  prepared_at: string | null
  started_at: string | null
  reviewed_at: string | null
  approved_at: string | null
  cancelled_at: string | null
  created_at: string
  created_by: string | null
  zone_count: number
  task_count: number
  task_completed_count: number
  count_entry_count: number
  blocking_incident_count: number
}

export interface InventorySessionListResult {
  total: number
  page: number
  page_size: number
  has_more: boolean
  sessions: InventorySessionSummary[]
}

export interface InventorySessionFilters {
  status?: string
  warehouse_id?: string
  date_from?: string
  date_to?: string
  search?: string
  page?: number
  page_size?: number
}

export interface WarehouseOption {
  id: string
  code: string
  name: string
}

export interface InventorySessionCatalogResult {
  warehouses: WarehouseOption[]
}

export async function listInventorySessions(
  companyId: string,
  filters: InventorySessionFilters = {}
): Promise<{ data: InventorySessionListResult | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_sessions', {
      p_company_id: companyId,
      p_status: filters.status || null,
      p_warehouse_id: filters.warehouse_id || null,
      p_date_from: filters.date_from || null,
      p_date_to: filters.date_to || null,
      p_search: filters.search || null,
      p_page: filters.page ?? 1,
      p_page_size: filters.page_size ?? 25,
    })

    if (error) {
      console.error('list_inventory_sessions error:', error.message)
      return { data: null, error: 'No se pudieron cargar las jornadas.' }
    }

    return { data: data as InventorySessionListResult, error: null }
  } catch (err) {
    console.error('list_inventory_sessions exception:', err)
    return { data: null, error: 'No se pudieron cargar las jornadas.' }
  }
}

export async function getInventorySessionWarehouses(
  companyId: string
): Promise<{ data: WarehouseOption[] | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_catalogs', {
      p_company_id: companyId,
    })

    if (error) {
      console.error('get_inventory_session_catalogs error:', error.message)
      return { data: null, error: 'No se pudieron cargar las bodegas.' }
    }

    const catalogs = data as { warehouses?: WarehouseOption[] } | null
    return { data: catalogs?.warehouses ?? [], error: null }
  } catch (err) {
    console.error('get_inventory_session_catalogs exception:', err)
    return { data: null, error: 'No se pudieron cargar las bodegas.' }
  }
}

export async function listActiveCompanyInventorySessions(
  filters: InventorySessionFilters = {}
): Promise<{ data: InventorySessionListResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await listInventorySessions(companyId, filters)
  return { ...result, companyId }
}

export async function getActiveCompanyWarehouses(): Promise<{
  data: WarehouseOption[] | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getInventorySessionWarehouses(companyId)
  return { ...result, companyId }
}
