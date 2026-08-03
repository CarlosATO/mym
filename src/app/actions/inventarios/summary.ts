'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

export interface InventoryDashboardSummary {
  kpis: {
    active_count: number
    counting_count: number
    review_count: number
    blocking_count: number
    average_progress: number
  }
  attention_sessions: Array<{
    id: string
    session_number: number
    name: string
    status: string
    inventory_type: string
    scope_mode: string
    warehouse_name: string | null
    responsible_name: string | null
    task_count: number
    task_completed_count: number
    blocking_incident_count: number
    created_at: string
  }>
  recent_alerts: Array<{
    id: string
    session_id: string
    session_number: number
    session_name: string
    category_code: string
    severity: string
    status: string
    is_blocking: boolean
    affected_quantity: number | null
    description: string
    reported_by_name: string | null
    reported_at: string
  }>
}

export async function getActiveCompanyDashboardSummary(): Promise<{
  data: InventoryDashboardSummary | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_dashboard_summary', {
      p_company_id: companyId,
    })
    if (error) {
      console.error('get_inventory_dashboard_summary error:', error.message)
      return { data: null, error: 'No se pudo cargar el resumen.', companyId }
    }
    return { data: data as InventoryDashboardSummary, error: null, companyId }
  } catch (err) {
    console.error('get_inventory_dashboard_summary exception:', err)
    return { data: null, error: 'No se pudo cargar el resumen.', companyId }
  }
}
