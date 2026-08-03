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
  warehouse_name: string | null
  bsale_office_id: number
  responsible_user_id: string | null
  responsible_name: string | null
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

export interface InventoryParticipant {
  id: string
  user_id: string
  user_name: string | null
  functional_role: string
  active_from: string
  revoked_at: string | null
  created_at: string
  created_by: string | null
}

export interface InventorySessionZone {
  id: string
  zone_code: string
  scan_code: string
  display_name: string
  priority: number
  is_enabled: boolean
  created_at: string
  locations: Array<{
    location_id: string
    snapshot_location_id: string
    code: string
    name: string | null
    aisle: string | null
    rack: string | null
    level: string | null
    position: string | null
    is_active: boolean
  }>
}

export interface InventorySessionTask {
  id: string
  session_zone_id: string
  task_kind: string
  status: string
  version: number
  validation_cycle: number
  current_assignment_id: string | null
  validated_at: string | null
  validated_by: string | null
  validated_by_name: string | null
  current_validation_event_id?: string | null
  pending_validation?: boolean
  cancelled_at: string | null
  cancelled_by: string | null
  cancelled_by_name: string | null
  created_at: string
  created_by: string | null
  assignment: {
    assignment_id: string
    user_id: string
    user_name: string | null
    session_participant_id: string
    functional_role: string
    assigned_at: string
    assigned_by: string
  } | null
}

export interface InventoryIncident {
  id: string
  category_code: string
  severity: string
  status: string
  is_blocking: boolean
  affected_quantity: number | null
  description: string
  task_id: string | null
  snapshot_product_id: string | null
  reported_by: string
  reported_by_name: string | null
  reported_at: string
}

export interface InventoryRecount {
  id: string
  status: string
  ordinal: number
  cycle_number: number
  session_zone_id: string
  snapshot_product_id: string
  source_task_id: string | null
  assigned_user_id: string | null
  assigned_user_name: string | null
  started_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancelled_by_name: string | null
  cancellation_reason: string | null
  reason: string
  created_at: string
  created_by: string | null
  decision_count?: number
}

export interface InventorySessionDetail {
  session: {
    id: string
    company_id: string
    session_number: number
    name: string
    inventory_type: string
    status: string
    scope_mode: string
    warehouse_id: string
    warehouse_name: string | null
    bsale_office_id: number
    responsible_user_id: string
    responsible_name: string | null
    notes: string | null
    prepared_at: string | null
    started_at: string | null
    reviewed_at: string | null
    approved_at: string | null
    approved_by: string | null
    approved_by_name: string | null
    exported_at: string | null
    reconciled_at: string | null
    cancelled_at: string | null
    cancelled_by: string | null
    cancelled_by_name: string | null
    cancellation_reason: string | null
    created_at: string
    created_by: string | null
    created_by_name: string | null
    updated_at: string
    updated_by: string | null
  }
  snapshot: {
    id: string
    snapshot_version: number
    completion_status: string
    content_hash: string | null
    captured_at: string | null
    captured_by: string | null
    captured_by_name: string | null
  } | null
  participants: InventoryParticipant[]
  zones: InventorySessionZone[]
  tasks: InventorySessionTask[]
  incidents: InventoryIncident[]
  recounts: InventoryRecount[]
  counts: {
    count_entry_count: number
    effective_contribution_count: number
    blocking_incident_count: number
    pending_recount_count: number
  }
}

export interface InventorySessionReview {
  tasks: InventorySessionTask[]
  contributions: Array<Record<string, unknown>>
  incidents: InventoryIncident[]
  recounts: InventoryRecount[]
  indicators: {
    session_status: string
    pending_validation_count: number
    effective_contribution_count: number
    blocking_incident_count: number
    pending_recount_count: number
    undecided_recount_count: number
    ready_to_approve: boolean
  }
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

export async function getInventorySessionDetail(
  companyId: string,
  sessionId: string
): Promise<{ data: InventorySessionDetail | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_detail', {
      p_company_id: companyId,
      p_session_id: sessionId,
    })
    if (error) {
      console.error('get_inventory_session_detail error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle de la jornada.' }
    }
    return { data: data as InventorySessionDetail, error: null }
  } catch (err) {
    console.error('get_inventory_session_detail exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle de la jornada.' }
  }
}

export async function getInventorySessionReview(
  companyId: string,
  sessionId: string
): Promise<{ data: InventorySessionReview | null; error: string | null }> {
  try {
    const db = inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_session_review', {
      p_company_id: companyId,
      p_session_id: sessionId,
    })
    if (error) {
      console.error('get_inventory_session_review error:', error.message)
      return { data: null, error: 'No se pudo cargar la revisión de la jornada.' }
    }
    return { data: data as InventorySessionReview, error: null }
  } catch (err) {
    console.error('get_inventory_session_review exception:', err)
    return { data: null, error: 'No se pudo cargar la revisión de la jornada.' }
  }
}

export async function getActiveCompanySessionDetail(
  sessionId: string
): Promise<{ data: InventorySessionDetail | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getInventorySessionDetail(companyId, sessionId)
  return { ...result, companyId }
}

export async function getActiveCompanySessionReview(
  sessionId: string
): Promise<{ data: InventorySessionReview | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getInventorySessionReview(companyId, sessionId)
  return { ...result, companyId }
}
