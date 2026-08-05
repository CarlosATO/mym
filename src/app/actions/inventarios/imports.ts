'use server'

import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompanyId } from '@/app/actions/companies'
import {
  IMPORT_BUCKET,
  IMPORT_MAX_SIZE,
  computeSha256,
  detectExtension,
  isAllowedMime,
  parseImportBuffer,
  safeFileName,
  FileParseError,
} from '@/modules/inventarios/lib/excel-import'
import { buildImportTemplate, type TemplateLocation } from '@/modules/inventarios/lib/excel-template'

async function inventariosDb() {
  return createInventariosClient()
}

export interface StockImportListItem {
  id: string
  company_id: string
  inventory_site_id: string
  site_name: string
  site_code: string
  site_type: string
  modality: string
  cutoff_at: string
  original_filename: string
  status: string
  row_count: number
  error_count: number
  warning_count: number
  created_at: string
  created_by_name: string | null
  validated_at: string | null
  file_sha256: string | null
}

export interface StockImportDetail {
  id: string
  company_id: string
  inventory_site_id: string
  site_name: string
  site_code: string
  site_type: string
  warehouse_id: string | null
  modality: string
  cutoff_at: string
  original_filename: string
  mime_type: string | null
  file_size: number | null
  file_sha256: string | null
  storage_path: string | null
  previous_storage_path: string | null
  previous_file_sha256: string | null
  status: string
  row_count: number
  error_count: number
  warning_count: number
  file_issues: { level: string; code: string; message: string }[]
  validated_at: string | null
  validated_by_name: string | null
  created_at: string
  created_by_name: string | null
}

export interface StockImportRowItem {
  row_index: number
  sku: string
  barcode: string | null
  entered_name: string | null
  product_id: string | null
  product_sku: string | null
  product_name: string | null
  location_code: string | null
  location_name: string | null
  quantity: number | null
  cost: number | null
  row_status: string
  issues: { level: string; code: string; message: string }[]
}

export interface StockImportIssueItem {
  row_index: number
  sku: string
  location_code: string | null
  level: string
  code: string
  message: string
}

export interface CampaignStockImportIssueItem {
  row_index: number | null
  severity: string
  code: string
  field: string | null
  message: string
  metadata: Record<string, unknown>
  product_id: string | null
  resolved_inventory_site_id: string | null
  inventory_site_location_id: string | null
  entered_site_code: string | null
  entered_location_code: string | null
}

export interface CampaignStockImportRowItem {
  row_index: number
  sku: string
  barcode: string | null
  entered_name: string | null
  product_id: string | null
  entered_site_code: string | null
  resolved_inventory_site_id: string | null
  entered_location_code: string | null
  inventory_site_location_id: string | null
  quantity: number | null
  cost: number | null
  row_status: string
  issues: { severity: string; code: string; field: string | null; message: string; metadata: Record<string, unknown> }[]
}

export interface CampaignStockImportDetail {
  import: {
    id: string
    company_id: string
    campaign_id: string
    theoretical_scope: 'TOTAL_CAMPAIGN' | 'BY_SITE' | 'BY_LOCATION'
    status: string
    row_count: number
    error_count: number
    warning_count: number
    original_filename: string
    file_issues: { level: string; code: string; field?: string | null; message: string; metadata?: Record<string, unknown> }[]
    validated_at: string | null
    created_at: string
    updated_at: string
  }
  campaign: {
    id: string
    name: string
    product_scope: 'ALL' | 'SELECTED'
    status: string
  }
  summary: {
    total_rows: number
    valid_rows: number
    warning_rows: number
    error_rows: number
    issue_warning_count: number
    issue_error_count: number
  }
  rows: CampaignStockImportRowItem[]
  issues: CampaignStockImportIssueItem[]
}

export interface SiteOption {
  id: string
  company_id: string
  name: string
  code: string
  site_type: 'INTERNAL_WAREHOUSE' | 'OWN_STORE' | 'EXTERNAL_SITE'
  warehouse_id: string | null
  is_active: boolean
}

export async function getCompanyImportPermissions(): Promise<{
  canRead: boolean
  canManage: boolean
  companyId: string | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return { canRead: false, canManage: false, companyId: null, error: 'No tienes una empresa activa seleccionada.' }
  }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('get_company_permissions', {
      p_user_id: (await db.auth.getUser()).data.user?.id,
      p_company_id: companyId,
    })
    if (error) {
      console.error('get_company_permissions error:', error.message)
      return { canRead: false, canManage: false, companyId, error: 'No se pudieron cargar los permisos.' }
    }
    const codes: string[] = (data ?? []).map((p: { permission_code: string }) => p.permission_code)
    return {
      canRead: codes.includes('inventarios.imports.read'),
      canManage: codes.includes('inventarios.imports.manage'),
      companyId,
      error: null,
    }
  } catch (err) {
    console.error('getCompanyImportPermissions exception:', err)
    return { canRead: false, canManage: false, companyId, error: 'No se pudieron cargar los permisos.' }
  }
}

export async function getImportSites(): Promise<{
  data: SiteOption[] | null
  error: string | null
  companyId: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.', companyId: null }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('list_inventory_sites', { p_company_id: companyId })
    if (error) {
      console.error('list_inventory_sites error:', error.message)
      return { data: null, error: 'No se pudieron cargar las unidades inventariables.', companyId }
    }
    const sites = (data as { sites?: SiteOption[] } | null)?.sites ?? []
    return { data: sites, error: null, companyId }
  } catch (err) {
    console.error('getImportSites exception:', err)
    return { data: null, error: 'No se pudieron cargar las unidades inventariables.', companyId }
  }
}

export async function getImportSiteLocations(siteId: string): Promise<{
  data: TemplateLocation[] | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('list_inventory_site_locations', {
      p_company_id: companyId,
      p_inventory_site_id: siteId,
    })
    if (error) {
      console.error('list_inventory_site_locations error:', error.message)
      return { data: null, error: 'No se pudieron cargar las ubicaciones.' }
    }
    const locations = (data as { locations?: TemplateLocation[] } | null)?.locations ?? []
    return { data: locations, error: null }
  } catch (err) {
    console.error('getImportSiteLocations exception:', err)
    return { data: null, error: 'No se pudieron cargar las ubicaciones.' }
  }
}

export async function downloadImportTemplate(params: {
  siteId: string
  siteName: string
  siteCode: string
  modality: 'GENERAL' | 'POR_UBICACION'
  cutoffAt: string
}): Promise<{ data: { base64: string; filename: string } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('list_inventory_site_locations', {
      p_company_id: companyId,
      p_inventory_site_id: params.siteId,
    })
    if (error) {
      console.error('list_inventory_site_locations error:', error.message)
      return { data: null, error: 'No se pudieron cargar las ubicaciones.' }
    }
    const locations = (data as { locations?: TemplateLocation[] } | null)?.locations ?? []
    const buffer = buildImportTemplate({
      modality: params.modality,
      siteName: params.siteName,
      siteCode: params.siteCode,
      cutoffAt: params.cutoffAt,
      locations,
    })
    const base64 = Buffer.from(buffer).toString('base64')
    const ext = params.modality === 'GENERAL' ? 'general' : 'por-ubicacion'
    const filename = `plantilla-stock-${ext}.xlsx`
    return { data: { base64, filename }, error: null }
  } catch (err) {
    console.error('downloadImportTemplate exception:', err)
    return { data: null, error: 'No se pudo generar la plantilla.' }
  }
}

export async function createStockImport(params: {
  siteId: string
  modality: 'GENERAL' | 'POR_UBICACION'
  cutoffAt: string
  filename: string
}): Promise<{ data: { import_id: string; storage_path: string } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('create_stock_import', {
      p_company_id: companyId,
      p_inventory_site_id: params.siteId,
      p_modality: params.modality,
      p_cutoff_at: params.cutoffAt,
      p_original_filename: params.filename,
    })
    if (error) {
      console.error('create_stock_import error:', error.message)
      return { data: null, error: safeRpcError(error.message) }
    }
    const result = data as { data?: { import_id?: string; storage_prefix?: string } } | null
    const importId = result?.data?.import_id
    const prefix = result?.data?.storage_prefix
    if (!importId || !prefix) return { data: null, error: 'No se pudo crear la importación.' }
    const safeName = safeFileName(params.filename)
    const storagePath = `${prefix}${Date.now()}-${safeName}`
    return { data: { import_id: importId, storage_path: storagePath }, error: null }
  } catch (err) {
    console.error('createStockImport exception:', err)
    return { data: null, error: 'No se pudo crear la importación.' }
  }
}

export async function registerStockImportFile(params: {
  importId: string
  storagePath: string
  filename: string
  mimeType: string
  fileSize: number
}): Promise<{ data: { import_id: string } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { error } = await db.rpc('register_stock_import_file', {
      p_company_id: companyId,
      p_import_id: params.importId,
      p_storage_path: params.storagePath,
      p_original_filename: params.filename,
      p_mime_type: params.mimeType,
      p_file_size: params.fileSize,
    })
    if (error) {
      console.error('register_stock_import_file error:', error.message)
      return { data: null, error: safeRpcError(error.message) }
    }
    return { data: { import_id: params.importId }, error: null }
  } catch (err) {
    console.error('registerStockImportFile exception:', err)
    return { data: null, error: 'No se pudo registrar el archivo.' }
  }
}

async function downloadImportBytes(storagePath: string) {
  const db = await inventariosDb()
  const { data, error } = await db.storage.from(IMPORT_BUCKET).download(storagePath)
  if (error) throw new Error(`No se pudo descargar el archivo: ${error.message}`)
  return data
}

async function runValidation(params: {
  importId: string
  mimeType: string | null
  fileSize: number | null
  filename: string
  mode: 'VALIDATE' | 'REVALIDATE'
}) {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('No tienes una empresa activa seleccionada.')

  const db = await inventariosDb()
  const { data: detailData, error: detailErr } = await db.rpc('get_stock_import', {
    p_company_id: companyId,
    p_import_id: params.importId,
  })
  if (detailErr || !detailData) throw new Error('La importación no existe o no tienes acceso.')
  const detail = (detailData as { import: StockImportDetail }).import

  if (detail.status === 'CONSUMED') throw new Error('La importación ya fue consumida y no se puede revalidar.')
  if (!detail.storage_path) throw new Error('La importación no tiene un archivo registrado.')

  const blob = await downloadImportBytes(detail.storage_path)
  const arrayBuffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)

  if (bytes.byteLength > IMPORT_MAX_SIZE) {
    throw new Error('El archivo supera el límite de 20 MB.')
  }
  const ext = detectExtension(detail.original_filename || params.filename)
  if (!isAllowedMime(detail.mime_type, detail.original_filename || params.filename)) {
    throw new Error('El tipo de archivo no es válido. Solo XLSX, XLS o CSV.')
  }
  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    throw new Error('El tipo de archivo no es válido. Solo XLSX, XLS o CSV.')
  }

  const sha256 = computeSha256(bytes)

  let parsed
  try {
    parsed = parseImportBuffer(arrayBuffer)
  } catch (e) {
    if (e instanceof FileParseError) {
      const { error } = await db.rpc('fail_stock_import', {
        p_company_id: companyId,
        p_import_id: params.importId,
        p_issue_code: e.code,
        p_safe_message: e.message,
      })
      if (error) console.error('fail_stock_import error:', error.message)
      throw new Error(`${e.message} La importación quedó en estado REJECTED.`)
    }
    throw new Error('No se pudo leer el archivo. Verifica que sea un archivo Excel o CSV válido.')
  }

  const { rows, file_issues } = parsed

  const rpc = params.mode === 'REVALIDATE' ? 'revalidate_stock_import' : 'validate_stock_import'
  const { data, error } = await db.rpc(rpc, {
    p_company_id: companyId,
    p_import_id: params.importId,
    p_file_sha256: sha256,
    p_file_issues: file_issues,
    p_rows: rows,
  })

  if (error) {
    console.error(`${rpc} error:`, error.message)
    throw new Error(safeRpcError(error.message))
  }

  const result = data as {
    replayed?: boolean
    import_id?: string
    status?: string
    storage_path_to_remove?: string | null
    data?: { import_id?: string; status?: string; row_count?: number; error_count?: number; warning_count?: number }
  } | null

  // Si la idempotencia devolvió una importación existente, limpia el archivo huérfano
  if (result?.replayed && result.storage_path_to_remove) {
    try {
      await db.storage.from(IMPORT_BUCKET).remove([result.storage_path_to_remove])
    } catch {
      // limpieza best-effort
    }
  }

  const effective = result?.replayed ? { import_id: result.import_id, status: result.status } : {
    import_id: result?.data?.import_id ?? params.importId,
    status: result?.data?.status ?? 'REJECTED',
  }

  return {
    import_id: effective.import_id as string,
    status: effective.status as string,
    replayed: Boolean(result?.replayed),
  }
}

export async function processStockImport(importId: string): Promise<{
  data: { import_id: string; status: string; replayed: boolean } | null
  error: string | null
}> {
  try {
    const data = await runValidation({ importId, mimeType: null, fileSize: null, filename: '', mode: 'VALIDATE' })
    return { data, error: null }
  } catch (err) {
    console.error('processStockImport error:', err)
    return { data: null, error: err instanceof Error ? err.message : 'No se pudo procesar la importación.' }
  }
}

export async function revalidateStockImport(importId: string): Promise<{
  data: { import_id: string; status: string; replayed: boolean } | null
  error: string | null
}> {
  try {
    const data = await runValidation({ importId, mimeType: null, fileSize: null, filename: '', mode: 'REVALIDATE' })
    return { data, error: null }
  } catch (err) {
    console.error('revalidateStockImport error:', err)
    return { data: null, error: err instanceof Error ? err.message : 'No se pudo revalidar la importación.' }
  }
}

export async function replaceStockImportFile(params: {
  importId: string
  storagePath: string
  filename: string
  mimeType: string
  fileSize: number
}): Promise<{ data: { import_id: string; previous_storage_path: string | null } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('replace_stock_import_file', {
      p_company_id: companyId,
      p_import_id: params.importId,
      p_storage_path: params.storagePath,
      p_original_filename: params.filename,
      p_mime_type: params.mimeType,
      p_file_size: params.fileSize,
    })
    if (error) {
      console.error('replace_stock_import_file error:', error.message)
      return { data: null, error: safeRpcError(error.message) }
    }
    const result = data as { data?: { import_id?: string; previous_storage_path?: string | null } } | null
    return {
      data: {
        import_id: result?.data?.import_id ?? params.importId,
        previous_storage_path: result?.data?.previous_storage_path ?? null,
      },
      error: null,
    }
  } catch (err) {
    console.error('replaceStockImportFile exception:', err)
    return { data: null, error: 'No se pudo reemplazar el archivo.' }
  }
}

export async function listStockImports(params: {
  status?: string
  page?: number
  pageSize?: number
}): Promise<{ data: { imports: StockImportListItem[]; total: number } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('list_stock_imports', {
      p_company_id: companyId,
      p_status: params.status || null,
      p_limit: params.pageSize ?? 50,
      p_offset: ((params.page ?? 1) - 1) * (params.pageSize ?? 50),
    })
    if (error) {
      console.error('list_stock_imports error:', error.message)
      return { data: null, error: 'No se pudieron cargar las importaciones.' }
    }
    const result = (data ?? {}) as { imports?: StockImportListItem[]; total?: number }
    return {
      data: { imports: result.imports ?? [], total: result.total ?? 0 },
      error: null,
    }
  } catch (err) {
    console.error('listStockImports exception:', err)
    return { data: null, error: 'No se pudieron cargar las importaciones.' }
  }
}

export async function getStockImport(importId: string): Promise<{
  data: StockImportDetail | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('get_stock_import', {
      p_company_id: companyId,
      p_import_id: importId,
    })
    if (error) {
      console.error('get_stock_import error:', error.message)
      return { data: null, error: 'No se pudo cargar la importación.' }
    }
    const detail = (data as { import?: StockImportDetail } | null)?.import ?? null
    return { data: detail, error: null }
  } catch (err) {
    console.error('getStockImport exception:', err)
    return { data: null, error: 'No se pudo cargar la importación.' }
  }
}

export async function getStockImportRows(params: {
  importId: string
  filter?: 'ALL' | 'VALID' | 'WARNING' | 'ERROR'
  page?: number
  pageSize?: number
}): Promise<{ data: { rows: StockImportRowItem[]; total: number } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('get_stock_import_rows', {
      p_company_id: companyId,
      p_import_id: params.importId,
      p_filter: params.filter ?? 'ALL',
      p_limit: params.pageSize ?? 50,
      p_offset: ((params.page ?? 1) - 1) * (params.pageSize ?? 50),
    })
    if (error) {
      console.error('get_stock_import_rows error:', error.message)
      return { data: null, error: 'No se pudieron cargar las filas.' }
    }
    const result = (data ?? {}) as { rows?: StockImportRowItem[]; total?: number }
    return {
      data: { rows: result.rows ?? [], total: result.total ?? 0 },
      error: null,
    }
  } catch (err) {
    console.error('getStockImportRows exception:', err)
    return { data: null, error: 'No se pudieron cargar las filas.' }
  }
}

export async function getStockImportIssues(importId: string): Promise<{
  data: StockImportIssueItem[] | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('get_stock_import_issues', {
      p_company_id: companyId,
      p_import_id: importId,
    })
    if (error) {
      console.error('get_stock_import_issues error:', error.message)
      return { data: null, error: 'No se pudieron cargar las incidencias.' }
    }
    const issues = (data as { issues?: StockImportIssueItem[] } | null)?.issues ?? []
    return { data: issues, error: null }
  } catch (err) {
    console.error('getStockImportIssues exception:', err)
    return { data: null, error: 'No se pudieron cargar las incidencias.' }
  }
}

export async function getCampaignStockImport(importId: string): Promise<{
  data: CampaignStockImportDetail | null
  error: string | null
}> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('get_campaign_stock_import', {
      p_company_id: companyId,
      p_import_id: importId,
    })
    if (error) {
      console.error('get_campaign_stock_import error:', error.message)
      return { data: null, error: 'No se pudo cargar la importación de campaña.' }
    }
    const detail = data as CampaignStockImportDetail | null
    return { data: detail, error: null }
  } catch (err) {
    console.error('getCampaignStockImport exception:', err)
    return { data: null, error: 'No se pudo cargar la importación de campaña.' }
  }
}

export async function validateCampaignStockImport(params: {
  importId: string
  fileIssues: Record<string, unknown>[]
  rows: Record<string, unknown>[]
  idempotencyKey: string
}): Promise<{ data: { import_id: string; status: string; replayed: boolean } | null; error: string | null }> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No tienes una empresa activa seleccionada.' }
  try {
    const db = await inventariosDb()
    const { data, error } = await db.rpc('validate_campaign_stock_import', {
      p_company_id: companyId,
      p_import_id: params.importId,
      p_file_issues: params.fileIssues,
      p_rows: params.rows,
      p_idempotency_key: params.idempotencyKey,
    })
    if (error) {
      console.error('validate_campaign_stock_import error:', error.message)
      return { data: null, error: safeRpcError(error.message) }
    }
    const result = data as { data?: { import_id?: string; status?: string }; replayed?: boolean } | null
    return {
      data: {
        import_id: result?.data?.import_id ?? params.importId,
        status: result?.data?.status ?? 'REJECTED',
        replayed: Boolean(result?.replayed),
      },
      error: null,
    }
  } catch (err) {
    console.error('validateCampaignStockImport exception:', err)
    return { data: null, error: 'No se pudo validar la importación de campaña.' }
  }
}

function safeRpcError(message: string): string {
  // Los errores RPC llegan con formato "SIGNAL_NAME ... DETAIL: {...}"
  const idx = message.indexOf('DETAIL:')
  if (idx >= 0) {
    const raw = message.slice(idx + 'DETAIL:'.length).trim()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed?.message) return parsed.message
      } catch {
        // ignore
      }
    }
  }
  return message
}
