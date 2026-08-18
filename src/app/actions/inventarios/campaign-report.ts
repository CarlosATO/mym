'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'

async function inventariosAdmin() {
  return createInventariosClient()
}

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

// Cliente server con rol de servicio: solo se usa en el servidor para generar
// signed URLs de evidencia (los objetos son de propietarios Mobile distintos al
// revisor admin; el cliente de sesión está sujeto a RLS de owner).
function inventariosServiceStorage() {
  return createSupabaseClient(supabaseUrl, serviceKey, {
    db: { schema: 'inventarios' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ---------- Tipos del Informe Global del Inventario ----------

export type CampaignVarianceStatus = 'FALTANTE' | 'SOBRANTE' | 'SIN_DIFERENCIA' | 'SIN_CONTEO'
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
  physical_quantity: number | null
  contribution_count: number
  difference_quantity: number | null
  unit_cost: number | null
  difference_value: number | null
  variance_status: CampaignVarianceStatus
  coverage_status: CampaignCoverageStatus
  barcode?: string | null
  barcode_source?: string | null
  approved_barcodes?: string[]
  has_evidence?: boolean
  evidence_id?: string | null
}

export interface CampaignAllProductItem {
  product_key: string
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  name: string | null
  theoretical_quantity: number
  physical_quantity: number | null
  difference_quantity: number | null
  variance_status: CampaignVarianceStatus | 'SIN_CONTEO'
  coverage_status: CampaignCoverageStatus | 'NOT_COUNTED'
  unit_cost: number | null
  difference_value: number | null
  barcode: string | null
  approved_barcodes: string[]
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
  physical_quantity: number | null
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
    physical_quantity: number | null
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
  can_close_authorized: boolean
  warning_count: number
  blocker_count: number
  blockers: {
    blocking_incident_count: number
    undecided_recount_count: number
  }
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

export interface CampaignCloseResult {
  campaign_id: string
  status: string
  closed_at: string
  closed_by: string
  sessions_total: number
  sessions_approved: number
  sessions_cancelled: number
  tasks_completed_admin: number
  tasks_cancelled_unvisited: number
  locations_closed: number
  assignments_released: number
  recounts_cancelled: number
  partial_zones: number
  unvisited_zones: number
  pending_barcodes: number
  official_result_created: boolean
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
    const result = data as CampaignVariancesResult
    return { data: result, error: null }
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
    const [{ data, error }, universe] = await Promise.all([
      db.rpc('get_inventory_campaign_review_summary', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      }),
      getCampaignAllProducts(companyId, campaignId),
    ])
    if (error) {
      console.error('get_inventory_campaign_review_summary error:', error.message)
      return { data: null, error: 'No se pudo cargar el resumen del inventario.' }
    }
    const summary = data as CampaignReviewSummary
    const report = await getCampaignVariances(companyId, campaignId, { page: 1, page_size: 1 })
    if (report.data) {
      const stock = report.data.summary
      summary.stock = {
        ...summary.stock,
        products_theoretical: universe.items.length,
        products_counted: stock.contados,
        products_with_difference: stock.faltantes + stock.sobrantes,
        faltantes: stock.faltantes,
        sobrantes: stock.sobrantes,
        sin_diferencia: stock.sin_diferencia,
        out_of_snapshot: stock.out_of_snapshot,
        units_faltante: stock.total_faltante_units,
        units_sobrante: stock.total_sobrante_units,
        net_valuation: stock.net_valuation,
        absolute_valuation: stock.absolute_valuation,
      }
    }
    return { data: summary, error: null }
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

export async function getCampaignAllProducts(
  companyId: string,
  campaignId: string
): Promise<{ items: CampaignAllProductItem[]; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_all_products', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('get_inventory_campaign_all_products error:', error.message)
      return { items: [], error: 'No se pudo cargar el universo completo de productos.' }
    }
    const result = data as { items?: CampaignAllProductItem[] } | null
    return { items: result?.items ?? [], error: null }
  } catch (err) {
    console.error('get_inventory_campaign_all_products exception:', err)
    return { items: [], error: 'No se pudo cargar el universo completo de productos.' }
  }
}

export async function getActiveCompanyCampaignExport(
  campaignId: string
): Promise<{ data: CampaignExportResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignExport(companyId, campaignId)
  return { ...result, companyId }
}

// ---------- Detalle del readiness por categoría ----------

export type CampaignReadinessDetailType =
  | 'PENDING_SESSIONS'
  | 'COUNTING_SESSIONS'
  | 'OPEN_LOCATIONS'
  | 'NEVER_VISITED_LOCATIONS'
  | 'IN_PROGRESS_ZONES'
  | 'PENDING_BARCODES'
  | 'OUT_OF_SNAPSHOT_PRODUCTS'

export interface CampaignReadinessDetailRow {
  bodega?: string | null
  zona?: string | null
  ubicacion?: string | null
  estado?: string | null
  situacion?: string | null
  responsable?: string | null
  abierta_desde?: string | null
  zonas_total?: number | null
  zonas_completadas?: number | null
  zonas_en_curso?: number | null
  ubicaciones_visitadas?: number | null
  ubicaciones_total?: number | null
  codigo_escaneado?: string | null
  producto?: string | null
  sku?: string | null
  stock_teorico?: number | null
  costo_unitario?: number | null
}

export interface CampaignReadinessDetailResult {
  campaign_id: string
  campaign_status: string
  detail_type: CampaignReadinessDetailType
  count: number
  rows: CampaignReadinessDetailRow[]
}

export async function getCampaignReadinessDetail(
  companyId: string,
  campaignId: string,
  detailType: CampaignReadinessDetailType
): Promise<{ data: CampaignReadinessDetailResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_campaign_readiness_detail', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_detail_type: detailType,
    })
    if (error) {
      console.error('get_inventory_campaign_readiness_detail error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle.' }
    }
    return { data: data as CampaignReadinessDetailResult, error: null }
  } catch (err) {
    console.error('get_inventory_campaign_readiness_detail exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle.' }
  }
}

export async function getActiveCompanyCampaignReadinessDetail(
  campaignId: string,
  detailType: CampaignReadinessDetailType
): Promise<{ data: CampaignReadinessDetailResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignReadinessDetail(companyId, campaignId, detailType)
  return { ...result, companyId }
}

// ---------- Cierre global del Inventario ----------

export async function adminCloseCampaign(
  companyId: string,
  campaignId: string,
  reason: string,
  confirmIncompleteCoverage: boolean,
  idempotencyKey: string
): Promise<{ data: CampaignCloseResult | null; error: string | null; businessCode?: string }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('admin_close_inventory_campaign', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_reason: reason,
      p_confirm_incomplete_coverage: confirmIncompleteCoverage,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('admin_close_inventory_campaign error:', error.message)
      const message = error.message ?? 'No se pudo cerrar el inventario.'
      const businessCode = message.includes('INV_PERMISSION_REQUIRED')
        ? 'PERMISSION_REQUIRED'
        : message.includes('INV_CONFIRM_REQUIRED')
          ? 'CONFIRM_REQUIRED'
          : message.includes('INV_SESSION_BLOCKING_INCIDENTS')
            ? 'BLOCKING_INCIDENTS'
            : message.includes('INV_SESSION_ALREADY_PREPARED')
              ? 'ALREADY_CLOSED'
              : undefined
      return { data: null, error: message, businessCode }
    }
    const envelope = data as { data?: CampaignCloseResult } & Partial<CampaignCloseResult>
    const payload = (envelope.data ?? envelope) as CampaignCloseResult
    return { data: payload, error: null }
  } catch (err) {
    console.error('admin_close_inventory_campaign exception:', err)
    return { data: null, error: 'No se pudo cerrar el inventario.' }
  }
}

export async function getActiveCompanyCampaignClose(
  campaignId: string,
  reason: string,
  confirmIncompleteCoverage: boolean,
  idempotencyKey: string
): Promise<{ data: CampaignCloseResult | null; error: string | null; businessCode?: string; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await adminCloseCampaign(companyId, campaignId, reason, confirmIncompleteCoverage, idempotencyKey)
  return { ...result, companyId }
}

// ---------- Revisión de incidencias de códigos de barras ----------

export interface BarcodeIncidentSummaryItem {
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  product_name: string | null
  bsale_barcode: string | null
  pending_barcode_count: number
  occurrence_count: number
  location_count: number
  latest_detected_at: string | null
  status: string
}

export interface BarcodeIncidentSummaryResult {
  campaign_id: string
  total: number
  page: number
  page_size: number
  can_review_barcodes_authorized: boolean
  items: BarcodeIncidentSummaryItem[]
}

export interface BarcodeIncidentOccurrence {
  proposal_id: string
  count_entry_id?: string | null
  session_id: string
  bodega: string | null
  zone_code: string | null
  location_code: string | null
  counted_by: string | null
  counted_by_name: string | null
  captured_at: string | null
  physical_quantity: number
  identification_method: string | null
  scanned_code: string
  evidence_id: string | null
  evidence_available: boolean
}

export interface BarcodeIncidentDetailResult {
  campaign_id: string
  campaign_status: string
  can_review_barcodes_authorized: boolean
  product: {
    bsale_variant_id: number
    product_id: string | null
    sku: string | null
    product_name: string | null
    bsale_barcode: string | null
  } | null
  barcodes: Array<{
    scanned_code: string
    location_count: number
    occurrence_count: number
    first_detected_at: string | null
    latest_detected_at: string | null
    status: string
  }>
  occurrences: BarcodeIncidentOccurrence[]
}

export interface BarcodeEvidenceReference {
  evidence_id: string
  bucket: string
  path: string
  mime_type: string | null
  file_size_bytes: number | null
  captured_at: string | null
  proposal_id: string | null
  count_entry_id: string | null
  sync_status: string | null
  available_in_storage: boolean
  signed_url: string | null
}

export interface BarcodeDecisionResult {
  state: string
  barcode: string
  bsale_variant_id: number
  alias_id: string | null
  association_created?: boolean
  association_already_existed?: boolean
  proposals_resolved: number
  alias_created?: boolean
  count_entries_preserved?: boolean
  reason_code?: string | null
}

export interface BarcodeProductSearchItem {
  bsale_variant_id: number
  product_id: string | null
  sku: string | null
  product_name: string | null
  bsale_code: string | null
}

export interface BarcodeProductSearchResult {
  campaign_id: string
  items: BarcodeProductSearchItem[]
}

export type CountInvalidateReasonCode =
  | 'DUPLICATE_COUNT'
  | 'ENTRY_ERROR'
  | 'NOT_PART_OF_INVENTORY'
  | 'INVALID_EVIDENCE'
  | 'OTHER'

export interface BarcodePhysicalActionResult {
  proposal_id: string
  root_count_entry_id: string
  count_entry_id?: string
  previous_count_entry_id?: string
  replacement_count_entry_id?: string
  correction_id?: string
  original_bsale_variant_id?: number
  target_bsale_variant_id?: number
  physical_quantity?: number
  removed_quantity?: number
  reason_code?: string
  proposal_status?: string
  target_proposal_id?: string | null
  target_alias_already_approved?: boolean
  barcode_conflict?: { found?: boolean; [key: string]: unknown }
}

export async function listBarcodeIncidentSummary(
  companyId: string,
  campaignId: string,
  page: number = 1,
  pageSize: number = 50
): Promise<{ data: BarcodeIncidentSummaryResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_barcode_incident_summary', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_page: page,
      p_page_size: pageSize,
    })
    if (error) {
      console.error('list_inventory_barcode_incident_summary error:', error.message)
      return { data: null, error: 'No se pudieron cargar las incidencias de códigos.' }
    }
    return { data: data as BarcodeIncidentSummaryResult, error: null }
  } catch (err) {
    console.error('list_inventory_barcode_incident_summary exception:', err)
    return { data: null, error: 'No se pudieron cargar las incidencias de códigos.' }
  }
}

export async function getBarcodeIncidentDetail(
  companyId: string,
  campaignId: string,
  bsaleVariantId: number
): Promise<{ data: BarcodeIncidentDetailResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_barcode_incident_detail', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_bsale_variant_id: bsaleVariantId,
    })
    if (error) {
      console.error('get_inventory_barcode_incident_detail error:', error.message)
      return { data: null, error: 'No se pudo cargar el detalle de la incidencia.' }
    }
    return { data: data as BarcodeIncidentDetailResult, error: null }
  } catch (err) {
    console.error('get_inventory_barcode_incident_detail exception:', err)
    return { data: null, error: 'No se pudo cargar el detalle de la incidencia.' }
  }
}

export async function getBarcodeEvidenceReference(
  companyId: string,
  campaignId: string,
  evidenceId: string
): Promise<{ data: BarcodeEvidenceReference | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('get_inventory_evidence_review_reference', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_evidence_id: evidenceId,
    })
    if (error) {
      console.error('get_inventory_evidence_review_reference error:', error.message)
      return { data: null, error: 'No se pudo acceder a la evidencia.' }
    }
    const reference = data as BarcodeEvidenceReference
    let signedUrl: string | null = null
    if (reference.available_in_storage) {
      const bucket = reference.bucket || 'inventory-evidence'
      const storage = inventariosServiceStorage()
      const { data: signedData, error: signedError } = await storage.storage
        .from(bucket)
        .createSignedUrl(reference.path, 300)
      if (signedError || !signedData?.signedUrl) {
        console.error('get_inventory_evidence_review_reference signedUrl error:', signedError?.message)
      } else {
        try {
          const probe = await fetch(signedData.signedUrl, { method: 'HEAD' })
          const length = Number(probe.headers.get('content-length') ?? '0')
          if (probe.ok && length >= 100) {
            signedUrl = signedData.signedUrl
          } else {
            console.error('get_inventory_evidence_review_reference probe not ok:', probe.status, 'length', length)
          }
        } catch (probeErr) {
          console.error('get_inventory_evidence_review_reference probe error:', probeErr)
        }
      }
    }
    return { data: { ...reference, signed_url: signedUrl }, error: null }
  } catch (err) {
    console.error('get_inventory_evidence_review_reference exception:', err)
    return { data: null, error: 'No se pudo acceder a la evidencia.' }
  }
}

export async function approveBarcode(
  companyId: string,
  campaignId: string,
  scannedCode: string,
  bsaleVariantId: number,
  idempotencyKey: string
): Promise<{ data: BarcodeDecisionResult | null; error: string | null; businessCode?: string }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('approve_inventory_barcode', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_scanned_code: scannedCode,
      p_bsale_variant_id: bsaleVariantId,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('approve_inventory_barcode error:', error.message)
      const raw = error.message ?? 'No se pudo autorizar el código.'
      const message = raw.toLowerCase().includes('constraint') || raw.toLowerCase().includes('violates')
        ? 'No fue posible autorizar el código. Intenta nuevamente.'
        : raw
      const businessCode = message.includes('INV_BARCODE_ALREADY_ASSOCIATED')
        ? 'BARCODE_ALREADY_ASSOCIATED'
        : message.includes('INV_PERMISSION_REQUIRED')
          ? 'PERMISSION_REQUIRED'
          : undefined
      return { data: null, error: message, businessCode }
    }
    const envelope = data as { data?: BarcodeDecisionResult } & Partial<BarcodeDecisionResult>
    const payload = (envelope.data ?? envelope) as BarcodeDecisionResult
    return { data: payload, error: null }
  } catch (err) {
    console.error('approve_inventory_barcode exception:', err)
    return { data: null, error: 'No se pudo autorizar el código.' }
  }
}

export type BarcodeRejectReasonCode =
  | 'CODE_NOT_MATCH_PRODUCT'
  | 'PHOTO_INVALID'
  | 'LABEL_OTHER_PRODUCT'
  | 'INTERNAL_NOT_REUSABLE'
  | 'OTHER'

export async function rejectBarcode(
  companyId: string,
  campaignId: string,
  scannedCode: string,
  bsaleVariantId: number,
  reasonCode: BarcodeRejectReasonCode,
  reviewNotes: string,
  idempotencyKey: string
): Promise<{ data: BarcodeDecisionResult | null; error: string | null; businessCode?: string }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('reject_inventory_barcode', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_scanned_code: scannedCode,
      p_bsale_variant_id: bsaleVariantId,
      p_reason_code: reasonCode,
      p_idempotency_key: idempotencyKey,
      p_review_notes: reviewNotes,
    })
    if (error) {
      console.error('reject_inventory_barcode error:', error.message)
      const raw = error.message ?? 'No se pudo rechazar el código.'
      const message = raw.toLowerCase().includes('constraint') || raw.toLowerCase().includes('violates')
        ? 'No fue posible rechazar el código. Intenta nuevamente.'
        : raw
      const businessCode = message.includes('INV_PERMISSION_REQUIRED') ? 'PERMISSION_REQUIRED' : undefined
      return { data: null, error: message, businessCode }
    }
    const envelope = data as { data?: BarcodeDecisionResult } & Partial<BarcodeDecisionResult>
    const payload = (envelope.data ?? envelope) as BarcodeDecisionResult
    return { data: payload, error: null }
  } catch (err) {
    console.error('reject_inventory_barcode exception:', err)
    return { data: null, error: 'No se pudo rechazar el código.' }
  }
}

export async function searchBarcodeIncidentTargetProducts(
  companyId: string,
  campaignId: string,
  query: string,
  excludeBsaleVariantId: number,
): Promise<{ data: BarcodeProductSearchResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('search_barcode_incident_target_products', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_query: query,
      p_exclude_bsale_variant_id: excludeBsaleVariantId,
      p_limit: 20,
    })
    if (error) {
      console.error('search_barcode_incident_target_products error:', error.message)
      return { data: null, error: 'No se pudieron buscar productos.' }
    }
    return { data: data as BarcodeProductSearchResult, error: null }
  } catch (err) {
    console.error('search_barcode_incident_target_products exception:', err)
    return { data: null, error: 'No se pudieron buscar productos.' }
  }
}

export async function correctBarcodeIncidentProduct(
  companyId: string,
  campaignId: string,
  proposalId: string,
  targetBsaleVariantId: number,
  reason: string,
  idempotencyKey: string,
): Promise<{ data: BarcodePhysicalActionResult | null; error: string | null; businessCode?: string }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('admin_correct_barcode_incident_product', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_proposal_id: proposalId,
      p_target_bsale_variant_id: targetBsaleVariantId,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('admin_correct_barcode_incident_product error:', error.message)
      const message = error.message ?? 'No se pudo corregir el producto contado.'
      const businessCode = message.includes('INV_CAMPAIGN_ALREADY_APPROVED')
        ? 'CAMPAIGN_ALREADY_APPROVED'
        : message.includes('INV_SESSION_ALREADY_APPROVED')
          ? 'SESSION_ALREADY_APPROVED'
          : message.includes('INV_PERMISSION_REQUIRED')
            ? 'PERMISSION_REQUIRED'
            : undefined
      return { data: null, error: message, businessCode }
    }
    const envelope = data as { data?: BarcodePhysicalActionResult } & Partial<BarcodePhysicalActionResult>
    return { data: (envelope.data ?? envelope) as BarcodePhysicalActionResult, error: null }
  } catch (err) {
    console.error('admin_correct_barcode_incident_product exception:', err)
    return { data: null, error: 'No se pudo corregir el producto contado.' }
  }
}

export async function invalidateBarcodeIncidentCount(
  companyId: string,
  campaignId: string,
  proposalId: string,
  reasonCode: CountInvalidateReasonCode,
  reason: string,
  idempotencyKey: string,
): Promise<{ data: BarcodePhysicalActionResult | null; error: string | null; businessCode?: string }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('admin_invalidate_barcode_incident_count', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_proposal_id: proposalId,
      p_reason_code: reasonCode,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      console.error('admin_invalidate_barcode_incident_count error:', error.message)
      const message = error.message ?? 'No se pudo eliminar el conteo.'
      const businessCode = message.includes('INV_CAMPAIGN_ALREADY_APPROVED')
        ? 'CAMPAIGN_ALREADY_APPROVED'
        : message.includes('INV_SESSION_ALREADY_APPROVED')
          ? 'SESSION_ALREADY_APPROVED'
          : message.includes('INV_PERMISSION_REQUIRED')
            ? 'PERMISSION_REQUIRED'
            : undefined
      return { data: null, error: message, businessCode }
    }
    const envelope = data as { data?: BarcodePhysicalActionResult } & Partial<BarcodePhysicalActionResult>
    return { data: (envelope.data ?? envelope) as BarcodePhysicalActionResult, error: null }
  } catch (err) {
    console.error('admin_invalidate_barcode_incident_count exception:', err)
    return { data: null, error: 'No se pudo eliminar el conteo.' }
  }
}

export async function getActiveCompanyBarcodeSummary(
  campaignId: string,
  page: number = 1,
  pageSize: number = 50
): Promise<{ data: BarcodeIncidentSummaryResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await listBarcodeIncidentSummary(companyId, campaignId, page, pageSize)
  return { ...result, companyId }
}

export async function getActiveCompanyBarcodeDetail(
  campaignId: string,
  bsaleVariantId: number
): Promise<{ data: BarcodeIncidentDetailResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getBarcodeIncidentDetail(companyId, campaignId, bsaleVariantId)
  return { ...result, companyId }
}

export async function getActiveCompanyBarcodeEvidence(
  campaignId: string,
  evidenceId: string
): Promise<{ data: BarcodeEvidenceReference | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getBarcodeEvidenceReference(companyId, campaignId, evidenceId)
  return { ...result, companyId }
}

export async function searchActiveCompanyBarcodeIncidentTargetProducts(
  campaignId: string,
  query: string,
  excludeBsaleVariantId: number,
): Promise<{ data: BarcodeProductSearchResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await searchBarcodeIncidentTargetProducts(companyId, campaignId, query, excludeBsaleVariantId)
  return { ...result, companyId }
}

export async function correctActiveCompanyBarcodeIncidentProduct(
  campaignId: string,
  proposalId: string,
  targetBsaleVariantId: number,
  reason: string,
  idempotencyKey: string,
): Promise<{ data: BarcodePhysicalActionResult | null; error: string | null; businessCode?: string; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await correctBarcodeIncidentProduct(companyId, campaignId, proposalId, targetBsaleVariantId, reason, idempotencyKey)
  return { ...result, companyId }
}

export async function invalidateActiveCompanyBarcodeIncidentCount(
  campaignId: string,
  proposalId: string,
  reasonCode: CountInvalidateReasonCode,
  reason: string,
  idempotencyKey: string,
): Promise<{ data: BarcodePhysicalActionResult | null; error: string | null; businessCode?: string; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await invalidateBarcodeIncidentCount(companyId, campaignId, proposalId, reasonCode, reason, idempotencyKey)
  return { ...result, companyId }
}

// ---------- Catálogo de códigos aprobados del campaign (Informe / Excel) ----------

export interface CampaignApprovedBarcode {
  bsale_variant_id: number
  sku: string | null
  product_name: string | null
  original_barcode: string | null
  original_barcode_source: string | null
  approved_barcode: string
  occurrence_count: number
  location_count: number
  first_detected_at: string | null
  latest_detected_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  status: string
}

export interface CampaignApprovedBarcodeResult {
  campaign_id: string
  items: CampaignApprovedBarcode[]
}

export async function getCampaignApprovedBarcodes(
  companyId: string,
  campaignId: string
): Promise<{ data: CampaignApprovedBarcodeResult | null; error: string | null }> {
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaign_approved_barcodes', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_campaign_approved_barcodes error:', error.message)
      return { data: null, error: 'No se pudo cargar el catálogo de códigos.' }
    }
    return { data: data as CampaignApprovedBarcodeResult, error: null }
  } catch (err) {
    console.error('list_inventory_campaign_approved_barcodes exception:', err)
    return { data: null, error: 'No se pudo cargar el catálogo de códigos.' }
  }
}

export async function getActiveCompanyCampaignApprovedBarcodes(
  campaignId: string
): Promise<{ data: CampaignApprovedBarcodeResult | null; error: string | null; companyId: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  }
  const result = await getCampaignApprovedBarcodes(companyId, campaignId)
  return { ...result, companyId }
}
