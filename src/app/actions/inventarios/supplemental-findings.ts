'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'
import { revalidatePath } from 'next/cache'

async function inventariosAdmin() {
  return createInventariosClient()
}

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export type SupplementalFindingClassification =
  | 'ELIGIBLE_CANONICAL'
  | 'ELIGIBLE_OUT_OF_THEORETICAL'
  | 'BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT'
  | 'BLOCKED_MISSING_BSALE_VARIANT'

export interface SupplementalFinding {
  finding_id: string
  campaign_id: string
  inventory_site_id: string
  site_code: string | null
  site_name: string | null
  inventory_site_location_id: string
  location_code: string | null
  location_name: string | null
  product_id: string
  bsale_variant_id: number | null
  sku: string | null
  barcode: string | null
  name: string
  quantity: number
  status: string
  classification: SupplementalFindingClassification
  in_canonical_theoretical: boolean
  in_normal_snapshot: boolean
  can_consolidate: boolean
  created_at: string
  updated_at: string
}

export interface SupplementalProduct {
  product_id: string
  bsale_variant_id: number | null
  sku: string | null
  barcode: string | null
  name: string
  classification: SupplementalFindingClassification
  in_canonical_theoretical: boolean
  in_normal_snapshot: boolean
  can_consolidate: boolean
}

export interface SupplementalSiteLocation {
  id: string
  code: string
  name: string | null
  is_active: boolean
}

export interface SupplementalFindingSiteOption {
  site_id: string
  site_name: string | null
  site_code: string | null
  location_scope: 'ALL' | 'SELECTED'
}

const KNOWN_ERRORS: Record<string, string> = {
  INV_SUPPLEMENTAL_FINDING_ALREADY_EXISTS:
    'Este producto ya está registrado como hallazgo en esta ubicación. Puedes corregir su cantidad desde el listado.',
  INV_INVALID_QUANTITY: 'La cantidad debe ser mayor a cero.',
  INV_PERMISSION_REQUIRED: 'No tienes permisos para gestionar hallazgos.',
  INV_NOT_FOUND: 'El recurso solicitado no existe.',
}

function safeMessage(message: string, fallback: string): string {
  if (KNOWN_ERRORS[message]) return KNOWN_ERRORS[message]
  if (message === 'INV_SESSION_INVALID_STATE') {
    const detail = extractDetailMessage(message)
    return detail ?? 'La campaña o el hallazgo no están en un estado que permita esta operación.'
  }
  const detail = extractDetailMessage(message)
  if (detail) return detail
  return fallback
}

function extractDetailMessage(message: string): string | null {
  const idx = message.indexOf('DETAIL:')
  if (idx < 0) return null
  const raw = message.slice(idx + 'DETAIL:'.length).trim()
  if (!raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    const friendly = parsed?.message
    return typeof friendly === 'string' && friendly.length > 0 ? friendly : null
  } catch {
    return null
  }
}

const SYNC_ERRORS: Record<string, string> = {
  INV_PERMISSION_REQUIRED: 'No tienes permisos para sincronizar hallazgos.',
  INV_SESSION_INVALID_STATE: 'Uno de los lotes ya no está en un estado válido para sincronizar.',
  INV_SUPPLEMENTAL_COUNTS_INCONSISTENT: 'Se detectó una inconsistencia en los hallazgos. Revisa el lote antes de continuar.',
  INV_SUPPLEMENTAL_COUNTS_INCOMPLETE: 'Uno de los lotes todavía tiene conteos pendientes.',
  INV_NOT_FOUND: 'La campaña o los hallazgos solicitados no existen.',
  INV_INVALID_REQUEST_PAYLOAD: 'La solicitud de sincronización no es válida.',
  INV_SUPPLEMENTAL_SYNC_STATE: 'Uno de los lotes no pudo completar la sincronización.',
}

function safeSyncMessage(message: string): string {
  const code = message.split('DETAIL:')[0].trim()
  return SYNC_ERRORS[code] ?? 'No se pudieron sincronizar los hallazgos. Inténtalo nuevamente.'
}

export async function getActiveCompanySupplementalFindingAccess(): Promise<{
  canManage: boolean
  companyId: string | null
  error: string | null
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { canManage: false, companyId: null, error: 'Debes iniciar sesión.' }
  const companyId = await getActiveCompanyId()
  if (!companyId) return { canManage: false, companyId: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const admin = createAdminClient()
    const { data: profile } = await admin
      .from('users')
      .select('roles:role_id(name, is_active)')
      .eq('id', user.id)
      .eq('is_active', true)
      .is('deleted_at', null)
      .single()
    const role = profile?.roles as { name?: string; is_active?: boolean } | null
    return { canManage: role?.name === 'SUPER_USUARIO' && role.is_active !== false, companyId, error: null }
  } catch {
    return { canManage: false, companyId, error: null }
  }
}

export async function getActiveCompanySupplementalFindings(
  campaignId: string
): Promise<{ data: SupplementalFinding[] | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('list_inventory_campaign_supplemental_findings', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
    })
    if (error) {
      console.error('list_inventory_campaign_supplemental_findings error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudieron cargar los hallazgos.') }
    }
    return { data: (data as SupplementalFinding[] | null) ?? [], error: null }
  } catch (err) {
    console.error('getActiveCompanySupplementalFindings exception:', err)
    return { data: null, error: 'No se pudieron cargar los hallazgos.' }
  }
}

export async function searchSupplementalFindingProducts(
  campaignId: string,
  query: string
): Promise<{ data: SupplementalProduct[] | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  const clean = query.trim()
  if (clean.length < 1) return { data: [], error: null }
  const db = await inventariosAdmin()
  try {
    const { data, error } = await db.rpc('search_inventory_campaign_supplemental_finding_products', {
      p_company_id: companyId,
      p_campaign_id: campaignId,
      p_query: clean,
      p_limit: 20,
    })
    if (error) {
      console.error('search_inventory_campaign_supplemental_finding_products error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudieron buscar productos.') }
    }
    return { data: (data as SupplementalProduct[] | null) ?? [], error: null }
  } catch (err) {
    console.error('searchSupplementalFindingProducts exception:', err)
    return { data: null, error: 'No se pudieron buscar productos.' }
  }
}

export async function getSupplementalSiteLocations(
  campaignId: string,
  siteId: string,
  locationScope: 'ALL' | 'SELECTED'
): Promise<{ data: SupplementalSiteLocation[] | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  const db = await inventariosAdmin()
  try {
    const { data, error } = await db.rpc('list_inventory_site_locations', {
      p_company_id: companyId,
      p_inventory_site_id: siteId,
    })
    if (error) {
      console.error('list_inventory_site_locations error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudieron cargar las ubicaciones.') }
    }
    const all = ((data as { locations?: SupplementalSiteLocation[] } | null)?.locations ?? []).filter(
      (location: SupplementalSiteLocation) => location.is_active
    )
    if (locationScope !== 'SELECTED') return { data: all, error: null }

    let allowed: string[] | null = null
    try {
      const site = await db
        .from('inventory_campaign_sites')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('inventory_site_id', siteId)
        .maybeSingle()
      if (site.data?.id) {
        const selected = await db
          .from('inventory_campaign_site_locations')
          .select('inventory_site_location_id')
          .eq('campaign_site_id', site.data.id)
        allowed = (selected.data ?? []).map(row => (row as { inventory_site_location_id: string }).inventory_site_location_id)
      }
    } catch (scopeError) {
      console.error('getSupplementalSiteLocations scope resolution error:', scopeError)
      allowed = null
    }
    if (allowed === null) return { data: all, error: null }
    return { data: all.filter(location => allowed!.includes(location.id)), error: null }
  } catch (err) {
    console.error('getSupplementalSiteLocations exception:', err)
    return { data: null, error: 'No se pudieron cargar las ubicaciones.' }
  }
}

export async function createSupplementalFinding(input: {
  campaignId: string
  siteId: string
  locationId: string
  productId: string
  quantity: number
}): Promise<{ data: SupplementalFinding | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('create_inventory_campaign_supplemental_finding', {
      p_company_id: companyId,
      p_campaign_id: input.campaignId,
      p_inventory_site_id: input.siteId,
      p_inventory_site_location_id: input.locationId,
      p_product_id: input.productId,
      p_quantity: input.quantity,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('create_inventory_campaign_supplemental_finding error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudo registrar el hallazgo.') }
    }
    const envelope = data as { entity_id?: string; data?: SupplementalFinding } | null
    return { data: envelope?.data ?? null, error: null }
  } catch (err) {
    console.error('createSupplementalFinding exception:', err)
    return { data: null, error: 'No se pudo registrar el hallazgo.' }
  }
}

export async function updateSupplementalFindingQuantity(input: {
  findingId: string
  quantity: number
}): Promise<{ data: SupplementalFinding | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('update_inventory_campaign_supplemental_finding_quantity', {
      p_company_id: companyId,
      p_finding_id: input.findingId,
      p_quantity: input.quantity,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('update_inventory_campaign_supplemental_finding_quantity error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudo actualizar la cantidad.') }
    }
    const envelope = data as { entity_id?: string; data?: SupplementalFinding } | null
    return { data: envelope?.data ?? null, error: null }
  } catch (err) {
    console.error('updateSupplementalFindingQuantity exception:', err)
    return { data: null, error: 'No se pudo actualizar la cantidad.' }
  }
}

export async function removeSupplementalFinding(input: {
  findingId: string
}): Promise<{ data: SupplementalFinding | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('remove_inventory_campaign_supplemental_finding', {
      p_company_id: companyId,
      p_finding_id: input.findingId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('remove_inventory_campaign_supplemental_finding error:', error.message)
      return { data: null, error: safeMessage(error.message, 'No se pudo retirar el hallazgo.') }
    }
    const envelope = data as { entity_id?: string; data?: SupplementalFinding } | null
    return { data: envelope?.data ?? null, error: null }
  } catch (err) {
    console.error('removeSupplementalFinding exception:', err)
    return { data: null, error: 'No se pudo retirar el hallazgo.' }
  }
}

export interface SupplementalBatch {
  supplemental_session_id: string
  supplemental_snapshot_id?: string
  session_status: string
  inventory_site_id: string
  site_name: string
  consolidated_finding_count: number
  pending_count_record_count: number
  recorded_count: number
  consolidated_physical_quantity: number
  pending_physical_quantity: number
  can_record_counts: boolean
  task_status?: string | null
}

interface SupplementalBatchReadModel {
  campaign_id: string
  batch_count: number
  batches: SupplementalBatch[]
}

async function readSupplementalBatches(companyId: string, campaignId: string) {
  const db = await inventariosAdmin()
  const { data, error } = await db.rpc('list_inventory_campaign_supplemental_batches', {
    p_company_id: companyId,
    p_campaign_id: campaignId,
  })
  if (error) {
    console.error('list_inventory_campaign_supplemental_batches error:', error.message)
    return { data: null, error: 'No se pudieron cargar los lotes supplemental.' }
  }
  const model = data as SupplementalBatchReadModel | null
  return { data: { ...(model ?? { campaign_id: campaignId, batch_count: 0, batches: [] }), batches: model?.batches ?? [] }, error: null }
}

export async function getActiveCompanySupplementalBatches(
  campaignId: string
): Promise<{ data: SupplementalBatchReadModel | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    return await readSupplementalBatches(companyId, campaignId)
  } catch (err) {
    console.error('getActiveCompanySupplementalBatches exception:', err)
    return { data: null, error: 'No se pudieron cargar los lotes supplemental.' }
  }
}

export interface SupplementalFindingsSyncResult {
  campaign_id: string
  processed_batch_count: number
  under_review_batch_count: number
  draft_eligible_processed: number
  blocked_draft_remaining: number
  count_entry_count: number
  physical_quantity_sum: number
  batches: Array<{
    supplemental_session_id: string
    inventory_site_id: string
    site_name: string
    initial_state: string
    final_state: string
    finding_count: number
    count_entry_count: number
    physical_quantity_sum: number
  }>
}

export async function syncSupplementalFindings(input: {
  campaignId: string
}): Promise<{ data: SupplementalFindingsSyncResult | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.campaignId)) {
    return { data: null, error: 'La campaña solicitada no existe.' }
  }
  try {
    const db = await inventariosAdmin()
    const { data, error } = await db.rpc('sync_inventory_campaign_supplemental_findings', {
      p_company_id: companyId,
      p_campaign_id: input.campaignId,
      p_idempotency_key: makeKey(),
    })
    if (error) {
      console.error('sync_inventory_campaign_supplemental_findings error:', error.message)
      return { data: null, error: safeSyncMessage(error.message) }
    }
    const envelope = data as { data?: SupplementalFindingsSyncResult } & SupplementalFindingsSyncResult | null
    const result = envelope?.data ?? envelope
    if (!result) return { data: null, error: 'No se recibió un resultado válido de sincronización.' }
    revalidatePath(`/dashboard/inventarios/campanas/${input.campaignId}`)
    return { data: result, error: null }
  } catch (err) {
    console.error('syncSupplementalFindings exception:', err)
    return { data: null, error: 'No se pudieron sincronizar los hallazgos.' }
  }
}
