'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

// ---------- Tipos del Informe Global del Inventario ----------

export type CampaignVarianceStatus = 'FALTANTE' | 'SOBRANTE' | 'SIN_DIFERENCIA'
export type CampaignCoverageStatus = 'COUNTED' | 'NOT_COUNTED' | 'OUT_OF_SNAPSHOT'

export interface CampaignVarianceItem {
  product_key: string
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  name: string | null
  in_theoretical_stock: boolean
  in_any_snapshot: boolean
  theoretical_quantity: number
  physical_quantity: number
  contribution_count: number
  difference_quantity: number
  unit_cost: number | null
  difference_value: number | null
  variance_status: CampaignVarianceStatus
  coverage_status: CampaignCoverageStatus
}

export interface CampaignVarianceSummary {
  total_products: number
  faltantes: number
  sobrantes: number
  sin_diferencia: number
  out_of_snapshot: number
  contados: number
  total_theoretical: number
  total_physical: number
  total_faltante_units: number
  total_sobrante_units: number
  net_valuation: number
  absolute_valuation: number
}

export interface CampaignVariancesResult {
  campaign_id: string
  campaign_status: string
  is_final: boolean
  summary: CampaignVarianceSummary
  total: number
  page: number
  page_size: number
  has_more: boolean
  items: CampaignVarianceItem[]
}

export interface CampaignReviewSummary {
  campaign_id: string
  campaign_status: string
  is_final: boolean
  stock: {
    products_theoretical: number
    products_counted: number
    products_with_difference: number
    faltantes: number
    sobrantes: number
    sin_diferencia: number
    out_of_snapshot: number
    units_faltante: number
    units_sobrante: number
    net_valuation: number
    absolute_valuation: number
  }
  operation: {
    total_sessions: number
    sessions_by_status: Record<string, number>
    zones_total: number
    zones_completed: number
    zones_in_progress: number
    zones_not_started: number
    locations_total: number
    locations_visited: number
    locations_open: number
    locations_visited_without_counts: number
    locations_never_visited: number
    pending_barcode_proposals: number
    blocking_incident_count: number
    pending_recount_count: number
  }
}

export interface CampaignBreakdownContribution {
  session_id: string
  session_name: string
  session_status: string
  zone_code: string | null
  zone_name: string | null
  location_code: string | null
  location_name: string | null
  counted_by: string | null
  counted_by_name: string | null
  physical_quantity: number
  identification_method: string | null
  scanned_code: string | null
  captured_at: string | null
  contribution_source: string | null
  task_cycle: number | null
}

export interface CampaignBreakdown {
  campaign_id: string
  campaign_status: string
  is_final: boolean
  header: {
    bsale_variant_id: number
    sku: string | null
    name: string | null
    product_id: string | null
    in_theoretical_stock: boolean
    in_any_snapshot: boolean
    theoretical_quantity: number
    physical_quantity: number
    difference_quantity: number | null
    unit_cost: number | null
    difference_value: number | null
    variance_status: CampaignVarianceStatus
    coverage_status: CampaignCoverageStatus
  }
  contributions: CampaignBreakdownContribution[]
}

export interface CampaignCloseReadiness {
  campaign_id: string
  campaign_status: string
  can_close: boolean
  summary: {
    sessions_total: number
    sessions_approved: number
    zones_total: number
    zones_completed: number
    locations_total: number
    locations_visited: number
  }
  warnings: {
    sessions_draft: number
    sessions_prepared: number
    sessions_counting: number
    sessions_under_review: number
    tasks_assigned: number
    tasks_in_progress: number
    tasks_paused: number
    locations_open: number
    locations_never_visited: number
    locations_visited_without_counts: number
    zones_not_started: number
    zones_incomplete: number
    blocking_incident_count: number
    pending_recount_count: number
    pending_barcode_proposals: number
    products_out_of_snapshot: number
  }
}

// ---------- Llamadas RPC ----------

export type CampaignSortBy =
  | 'SKU'
  | 'NAME'
  | 'THEORETICAL'
  | 'PHYSICAL'
  | 'DIFFERENCE'
  | 'VARIANCE_STATUS'
  | 'COVERAGE_STATUS'
  | 'UNIT_COST'
  | 'DIFFERENCE_VALUE'

export type CampaignSortDirection = 'ASC' | 'DESC'

export async function getCampaignVariances(
  companyId: string,
  campaignId: string,
  filters: {
    search?: string
    variance_status?: string
    coverage_status?: string
    page?: number
    page_size?: number
    sort_by?: CampaignSortBy
    sort_direction?: CampaignSortDirection
  } = {}
): Promise<{ data: CampaignVariancesResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaign_variances', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_search: filters.search ?? '',
      p_variance_status: filters.variance_status ?? '',
      p_coverage_status: filters.coverage_status ?? '',
      p_page: filters.page ?? 1,
      p_page_size: filters.page_size ?? 50,
      p_sort_by: filters.sort_by ?? null,
      p_sort_direction: filters.sort_direction ?? 'ASC',
    })
    if (error) {
      console.error('list_inventory_campaign_variances error:', error.message)
      return { data: null, error: 'No se pudieron cargar las diferencias del inventario.' }
    }
    return { data: data as CampaignVariancesResult, error: null }
  } catch (err) {
    console.error('list_inventory_campaign_variances exception:', err)
    return { data: null, error: 'No se pudieron cargar las diferencias del inventario.' }
  }
}

export async function getCampaignReviewSummary(
  companyId: string,
  campaignId: string
): Promise<{ data: CampaignReviewSummary | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_review_summary', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('get_inventory_campaign_review_summary error:', error.message)
      return { data: null, error: 'No se pudo cargar el resumen del inventario.' }
    }
    return { data: data as CampaignReviewSummary, error: null }
  } catch (err) {
    console.error('get_inventory_campaign_review_summary exception:', err)
    return { data: null, error: 'No se pudo cargar el resumen del inventario.' }
  }
}

export async function getCampaignProductBreakdown(
  companyId: string,
  campaignId: string,
  bsaleVariantId: number
): Promise<{ data: CampaignBreakdown | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_product_breakdown', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_bsale_variant_id: bsaleVariantId,
    })
    if (error) {
      console.error('get_inventory_campaign_product_breakdown error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle del producto.' }
    }
    return { data: data as CampaignBreakdown, error: null }
  } catch (err) {
    console.error('get_inventory_campaign_product_breakdown exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle del producto.' }
  }
}

export async function getCampaignCloseReadiness(
  companyId: string,
  campaignId: string
): Promise<{ data: CampaignCloseReadiness | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_close_readiness', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('get_inventory_campaign_close_readiness error:', error.message)
      return { data: null, error: 'No se pudo cargar la preparación para el cierre.' }
    }
    return { data: data as CampaignCloseReadiness, error: null }
  } catch (err) {
    console.error('get_inventory_campaign_close_readiness exception:', err)
    return { data: null, error: 'No se pudo cargar la preparación para el cierre.' }
  }
}

// ---------- Acciones con empresa activa ----------

export async function getActiveCompanyCampaignReport(
  campaignId: string,
  filters: {
    search?: string
    variance_status?: string
    coverage_status?: string
    page?: number
    page_size?: number
    sort_by?: CampaignSortBy
    sort_direction?: CampaignSortDirection
  } = {}
): Promise<{ data: CampaignVariancesResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignVariances(companyId, campaignId, filters)
  return { ...result, companyId }
}

export async function getActiveCompanyCampaignSummary(
  campaignId: string
): Promise<{ data: CampaignReviewSummary | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignReviewSummary(companyId, campaignId)
  return { ...result, companyId }
}

export async function getActiveCompanyCampaignBreakdown(
  campaignId: string,
  bsaleVariantId: number
): Promise<{ data: CampaignBreakdown | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignProductBreakdown(companyId, campaignId, bsaleVariantId)
  return { ...result, companyId }
}

export async function getActiveCompanyCampaignReadiness(
  campaignId: string
): Promise<{ data: CampaignCloseReadiness | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignCloseReadiness(companyId, campaignId)
  return { ...result, companyId }
}

// ---------- Exportación Excel (datos completos, servidor) ----------

export interface CampaignExportContribution {
  sku: string | null
  name: string | null
  session_name: string | null
  session_status: string | null
  zone_code: string | null
  zone_name: string | null
  location_code: string | null
  location_name: string | null
  counted_by: string | null
  counted_by_name: string | null
  physical_quantity: number
  identification_method: string | null
  scanned_code: string | null
  captured_at: string | null
  contribution_source: string | null
}

export interface CampaignExportOperationalRow {
  tipo: string
  seccion: string | null
  zona: string | null
  ubicacion: string | null
  estado: string | null
  detalle: string | null
}

export interface CampaignExportResult {
  campaign_id: string
  campaign_status: string
  contributions: CampaignExportContribution[]
  operational_rows: CampaignExportOperationalRow[]
}

const PAGE_SIZE = 100

export async function getCampaignExport(
  companyId: string,
  campaignId: string
): Promise<{ data: CampaignExportResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_export', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('get_inventory_campaign_export error:', error.message)
      return { data: null, error: 'No se pudo generar la exportación del inventario.' }
    }
    return { data: data as CampaignExportResult, error: null }
  } catch (err) {
    console.error('get_inventory_campaign_export exception:', err)
    return { data: null, error: 'No se pudo generar la exportación del inventario.' }
  }
}

/**
 * Obtiene TODO el dataset global de diferencias del Inventario recorriendo las
 * páginas del RPC paginado en el servidor (no en el navegador). No depende del
 * filtro actual de la pantalla.
 */
export async function getAllCampaignVariances(
  companyId: string,
  campaignId: string
): Promise<{ items: CampaignVarianceItem[]; error: string | null }> {
  const all: CampaignVarianceItem[] = []
  let page = 1
  while (true) {
    const { data, error } = await getCampaignVariances(companyId, campaignId, {
      page,
      page_size: PAGE_SIZE,
      sort_by: 'SKU',
      sort_direction: 'ASC',
    })
    if (error || !data) {
      return { items: [], error: error ?? 'No se pudo cargar el informe completo.' }
    }
    all.push(...data.items)
    if (!data.has_more || data.items.length === 0) break
    page += 1
  }
  return { items: all, error: null }
}
