'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveCompanyId } from '@/app/actions/companies'
import { getWarehousePreparationSyncHealth, type WarehousePreparationSyncHealth } from '@/app/actions/integraciones/sync'
import { decidePreparationSync } from '@/modules/logistica/preparacion-pedidos/preparation-sync-policy'
import type { InvoicePaymentTypeOption, InvoiceSaleConditionOption } from '@/modules/logistica/preparacion-pedidos/invoice-commercial'
import { chileToday } from '@/lib/integraciones/invoice-emission-contract'
import { extractBsaleRelationIdFromHref } from '@/lib/integraciones/bsale-client-commercial-normalization'
import { getSafeHttpsHostname, validateBsalePdfResponseUrl, validateBsalePdfUrl, validateBsaleRedirectUrl } from '@/lib/integraciones/invoice-print-assistant'

function logPreparationDiagnostics(label: string, detail: Record<string, unknown>) {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(`[preparacion-open][server] ${label}`, detail)
  }
}

async function requireLogisticaView() {
  const supabase = await createClient()
  const { data: allowed, error } = await supabase.rpc('has_permission', {
    p_permission_code: 'module.logistica.view',
  })

  return {
    supabase,
    error: error || allowed !== true ? 'No autorizado para consultar Preparación de Pedidos.' : null,
  }
}

async function requireLogisticaManage() {
  const supabase = await createClient()
  const { data: allowed, error } = await supabase.rpc('has_permission', {
    p_permission_code: 'logistica.preparation.manage',
  })

  return {
    supabase,
    error: error || allowed !== true ? 'No tienes permiso para gestionar la preparación de pedidos.' : null,
  }
}

export type SalesOrderClientData = {
  rut: string | null
  phone: string | null
  email: string | null
}

const NON_INVOICE_PAYMENT_TYPES = new Set(['NOTA CREDITO DEVOLUCION', 'ABONO DE CLIENTE'])

const commercialCatalogCache = new Map<string, { expiresAt: number; data: { paymentTypes: InvoicePaymentTypeOption[]; saleConditions: InvoiceSaleConditionOption[] } }>()

function readRawUnixDate(value: unknown): string | null {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

async function getInvoiceCommercialCatalog(companyId: string, supabase: Awaited<ReturnType<typeof createClient>>) {
  const cached = commercialCatalogCache.get(companyId)
  if (cached && cached.expiresAt > Date.now()) return cached.data

  const [{ data: paymentTypes, error: paymentTypesError }, { data: saleConditions, error: saleConditionsError }] = await Promise.all([
    supabase.schema('integraciones').from('bsale_payment_types').select('bsale_id, name').eq('company_id', companyId).eq('is_active', true).order('name'),
    supabase.schema('integraciones').from('bsale_sale_conditions').select('bsale_id, name, state, raw_json').eq('company_id', companyId).eq('state', 0).order('name'),
  ])

  if (paymentTypesError) throw paymentTypesError
  if (saleConditionsError) throw saleConditionsError

  const invoicePaymentTypes: InvoicePaymentTypeOption[] = (paymentTypes ?? [])
    .filter(type => !NON_INVOICE_PAYMENT_TYPES.has(String(type.name).trim().toUpperCase()))
    .map(type => ({ bsale_id: Number(type.bsale_id), name: type.name }))
    .filter(type => Number.isSafeInteger(type.bsale_id))
  const invoiceSaleConditions: InvoiceSaleConditionOption[] = (saleConditions ?? []).map(condition => {
    const raw = condition.raw_json && typeof condition.raw_json === 'object' ? condition.raw_json as Record<string, unknown> : {}
    return {
      bsale_id: Number(condition.bsale_id),
      name: condition.name,
      time_condition: typeof raw.timeCondition === 'number' ? raw.timeCondition : null,
      time_unity: typeof raw.timeUnity === 'number' ? raw.timeUnity : null,
    }
  }).filter(condition => Number.isSafeInteger(condition.bsale_id))

  const data = { paymentTypes: invoicePaymentTypes, saleConditions: invoiceSaleConditions }
  commercialCatalogCache.set(companyId, { expiresAt: Date.now() + 5 * 60_000, data })
  return data
}

export type SalesOrderPreparationCardInfo = {
  card_id: string
  company_id: string
  status: string
  priority: number
  assigned_user_id: string | null
  assigned_user_name?: string | null
  locked_by_user_id: string | null
  locked_by_user_name?: string | null
  locked_at: string | null
  route_date: string | null
  normalized_city: string | null
  nv_bsale_id: number
  nv_folio: string
  nv_emission_date: string
  nv_generation_date: string
  client_name: string
  city_raw: string | null
  municipality_raw: string | null
  address_raw: string | null
  seller_bsale_id: number | null
  seller_name: string | null
  total_quantity: number
  total_amount: number | null
  net_amount: number | null
  tax_amount: number | null
  gross_amount: number | null
  invoice_folio: string | null
  read_model_invoice_bsale_id?: number | null
  read_model_invoice_folio?: string | null
  read_model_invoice_total_amount?: number | null
  is_invoiced: boolean
  created_at: string
  updated_at: string
}

export type SalesOrderPreparationItem = {
  detail_id: number
  company_id: string
  nv_bsale_id: number
  nv_folio: number
  variant_id: number | null
  sku: string | null
  product_name: string
  quantity: number
  unit_value: number | null
  total_amount: number | null
  unit_net_value: number | null
  line_net_amount: number | null
  line_tax_amount: number | null
  line_gross_amount: number | null
}

export type SalesOrderPreparationLine = {
  id: string
  company_id: string
  card_id: string
  bsale_nv_id: number
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  requested_quantity: number
  prepared_quantity: number | null
  line_status: 'PENDING' | 'CONFIRMED' | 'INCIDENT'
  excluded_from_dispatch: boolean
  confirmed_by: string | null
  confirmed_at: string | null
  source_snapshot: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type SalesOrderRouteReadiness = {
  card_id: string
  company_id: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  has_open_commercial_incidents: boolean
  open_commercial_incident_count: number
  route_readiness: 'INCIDENTS' | 'READY_TO_INVOICE' | 'BLOCKED'
  bsale_nv_state: number | null
  bsale_nv_found: boolean
}

export type SalesOrderPreparationCommercialIncident = {
  id: string
  card_id: string
  bsale_nv_id: number
  nv_folio: string | null
  sku: string | null
  product_name: string
  required_bsale_action: 'SET_QUANTITY' | 'REMOVE_LINE'
  bsale_observed_quantity: number | null
  expected_bsale_quantity: number
  observation: string | null
  reason_code: string | null
  created_at: string
}

export async function getSalesOrderRouteReadiness(companyId: string): Promise<{
  data: SalesOrderRouteReadiness[]
  error: string | null
}> {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: [], error: permissionError }

  const activeCompanyId = await getActiveCompanyId()
  if (!activeCompanyId || activeCompanyId !== companyId) {
    return { data: [], error: 'Empresa activa inválida.' }
  }

  const { data, error } = await supabase
    .schema('logistica')
    .rpc('get_sales_order_route_readiness_v1', { p_company_id: companyId })

  if (error) {
    console.error('[getSalesOrderRouteReadiness] error:', error)
    return { data: [], error: error.message }
  }

  return { data: (data ?? []) as SalesOrderRouteReadiness[], error: null }
}

export async function getSalesOrderPreparationCommercialIncidents(params: {
  companyId: string
  cardId: string
}): Promise<{
  data: SalesOrderPreparationCommercialIncident[]
  error: string | null
}> {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: [], error: permissionError }

  const activeCompanyId = await getActiveCompanyId()
  if (!activeCompanyId || activeCompanyId !== params.companyId) {
    return { data: [], error: 'Empresa activa inválida.' }
  }

  const { data, error } = await supabase
    .schema('logistica')
    .from('sales_order_preparation_incidents')
    .select('id, card_id, bsale_nv_id, nv_folio, sku, product_name, required_bsale_action, bsale_observed_quantity, expected_bsale_quantity, observation, reason_code, created_at')
    .eq('company_id', params.companyId)
    .eq('card_id', params.cardId)
    .eq('status', 'OPEN')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[getSalesOrderPreparationCommercialIncidents] error:', error)
    return { data: [], error: error.message }
  }

  return { data: (data ?? []) as SalesOrderPreparationCommercialIncident[], error: null }
}

export type PreviewCandidatesResult = {
  total_candidates: number
  already_materialized: number
  pending_to_create: number
}

export type PreviewNextRouteCandidate = {
  bsale_nv_id: number
  nv_folio: string
  client_name: string
  route_location_normalized: string
  route_city_id?: string
  seller_name: string
  nv_emission_date: string
  nv_generation_date: string
  nv_generation_date_chile: string
  net_amount: number
  gross_amount: number
  route_date: string
  cutoff_at: string
  cutoff_at_chile: string
  inclusion_status: string
  reason?: string
  observation?: string
  authorized_by_name?: string
  authorized_at?: string
  card_id?: string
  card_status?: string
  card_route_date?: string
  original_route_date?: string
}

export type PreviewNextRouteResult = {
  has_route: boolean
  route_date?: string
  route_weekday?: number
  cutoff_at?: string
  cutoff_at_chile?: string
  calendar_id?: string
  calendar_name?: string
  cities?: string[]
  counts?: {
    in_cutoff: number
    out_cutoff: number
    exceptions: number
    existing_cards: number
    previous_pending: number
  }
  candidates?: PreviewNextRouteCandidate[]
  out_of_cutoff?: PreviewNextRouteCandidate[]
  authorized_exceptions?: PreviewNextRouteCandidate[]
  existing_cards?: PreviewNextRouteCandidate[]
  previous_pending?: PreviewNextRouteCandidate[]
}

export type SyncNextRouteResult = {
  dry_run: boolean
  has_route: boolean
  route_date?: string
  cities?: string[]
  would_insert_cards?: number
  would_reprogram_cards?: number
  would_materialize_exceptions?: number
  insert_candidates?: any[]
  reprogram_candidates?: any[]
  exception_candidates?: any[]
  message?: string
}

export type SalesOrderPreparationTrace = {
  materialized: number
  existing: number
  outOfCutoff: number
  routeDate: string | null
  cities: string[]
  completedAt: string | null
}

export async function getSalesOrderPreparationBoard(companyId: string) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: [], error: permissionError }

  // Preparation is an operational queue; visibility does not depend on routes.
  const query = supabase
    .schema('logistica')
    .from('vw_sales_order_preparation_board')
    .select('*')
    .eq('company_id', companyId)

  const { data, error } = await query
    .order('priority', { ascending: false })
    .order('nv_emission_date', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationBoard error:', error)
    return { data: [], error: error.message }
  }

  const rows = (data ?? []) as SalesOrderPreparationCardInfo[]
  const userIds = [...new Set(rows.flatMap(row => [row.assigned_user_id, row.locked_by_user_id]).filter((id): id is string => Boolean(id)))]
  const nameById = new Map<string, string>()

  if (userIds.length > 0) {
    const { data: users, error: usersError } = await createAdminClient()
      .from('users')
      .select('id, nombre, apellido')
      .in('id', userIds)

    if (usersError) {
      console.error('getSalesOrderPreparationBoard users error:', usersError)
    } else {
      for (const user of users ?? []) {
        const name = `${user.nombre ?? ''} ${user.apellido ?? ''}`.trim()
        if (name) nameById.set(String(user.id), name)
      }
    }
  }

  return {
    data: rows.map(row => ({
      ...row,
      assigned_user_name: row.assigned_user_id ? nameById.get(row.assigned_user_id) ?? null : null,
      locked_by_user_name: row.locked_by_user_id ? nameById.get(row.locked_by_user_id) ?? null : null,
    })),
    error: null,
  }
}

export async function getSalesOrderPreparationItems(companyId: string, bsaleNvId: number) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: [], error: permissionError }

  const { data, error } = await supabase
    .schema('integraciones')
    .from('vw_bsale_sales_order_items_for_preparation')
    .select('*')
    .eq('company_id', companyId)
    .eq('nv_bsale_id', bsaleNvId)
    .order('product_name', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationItems error:', error)
    return { data: [], error: error.message }
  }

  return { data: data as SalesOrderPreparationItem[], error: null }
}

/** Read-only snapshot for the invoice review UI. It deliberately has no Bsale mutation path. */
export async function getInvoiceReviewSnapshot(companyId: string, cardId: string) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: null, error: permissionError }

  const board = await getSalesOrderPreparationBoard(companyId)
  const card = board.data.find(row => row.card_id === cardId)
  if (!card) return { data: null, error: 'No se encontró la Nota de Venta vigente.' }

  const items = await getSalesOrderPreparationItems(companyId, card.nv_bsale_id)
  if (items.error) return { data: null, error: items.error }

  const readiness = (await getSalesOrderRouteReadiness(companyId)).data
    .find(row => row.card_id === cardId)?.route_readiness

  const { data: document } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('emission_date, net_amount, tax_amount, total_amount, client_id, raw_json')
    .eq('company_id', companyId)
    .eq('bsale_id', card.nv_bsale_id)
    .maybeSingle()
  const { data: client } = await supabase
    .schema('integraciones')
    .from('bsale_clients')
    .select('bsale_client_id, business_name, code, activity, address, commune, city, region, email, phone, payment_type_id, payment_type_name, sale_condition_id, sale_condition_name, has_credit, price_list_id, price_list_name, credit_limit, raw_payload')
    .eq('company_id', companyId)
    .eq('bsale_client_id', document?.client_id ?? -1)
    .maybeSingle()

  const catalog = await getInvoiceCommercialCatalog(companyId, supabase)
  const documentRaw = document?.raw_json && typeof document.raw_json === 'object' ? document.raw_json as Record<string, unknown> : {}
  const clientRaw = client?.raw_payload && typeof client.raw_payload === 'object' ? client.raw_payload as Record<string, unknown> : {}
  const effectiveSaleConditionId = extractBsaleRelationIdFromHref(documentRaw.sale_condition ?? documentRaw.saleCondition, 'sale_conditions')
  const defaultSaleConditionId = client?.sale_condition_id == null ? extractBsaleRelationIdFromHref(clientRaw.sale_condition, 'sale_conditions') : Number(client.sale_condition_id)
  const saleCondition = catalog.saleConditions.find(option => option.bsale_id === (effectiveSaleConditionId ?? defaultSaleConditionId)) ?? null
  const paymentType = catalog.paymentTypes.find(option => option.bsale_id === Number(client?.payment_type_id)) ?? null

  return {
    data: {
      card_id: card.card_id,
      historical_bsale_nv_id: card.nv_bsale_id,
      current_bsale_nv_id: card.nv_bsale_id,
      folio: card.nv_folio,
      client_name: client?.business_name ?? card.client_name,
      emission_date: document?.emission_date ?? card.nv_emission_date,
      office_name: null,
      sale_condition_name: saleCondition?.name ?? null,
      client_id: client?.bsale_client_id ?? null,
      default_payment_type_id: client?.payment_type_id == null ? null : Number(client.payment_type_id),
      default_payment_type_name: client?.payment_type_name ?? paymentType?.name ?? null,
      default_sale_condition_id: defaultSaleConditionId,
      default_sale_condition_name: client?.sale_condition_name ?? (defaultSaleConditionId == null ? null : catalog.saleConditions.find(option => option.bsale_id === defaultSaleConditionId)?.name ?? null),
      effective_sale_condition_id: effectiveSaleConditionId,
      effective_sale_condition_label: saleCondition?.name ?? null,
      effective_sale_condition_source: effectiveSaleConditionId != null ? 'BSALE_DOCUMENT' : defaultSaleConditionId != null ? 'BSALE_CLIENT_FALLBACK' : null,
      effective_time_condition: saleCondition?.time_condition ?? null,
      effective_time_unity: saleCondition?.time_unity ?? null,
      invoice_emission_date: chileToday(),
      payment_type_options: catalog.paymentTypes,
      sale_condition_options: catalog.saleConditions,
      credit_enabled: client?.has_credit ?? null,
      credit_limit: client?.credit_limit == null ? null : Number(client.credit_limit),
      price_list_id: client?.price_list_id == null ? null : Number(client.price_list_id),
      expiration_date: readRawUnixDate(documentRaw.expirationDate),
      nv_expiration_date: readRawUnixDate(documentRaw.expirationDate),
      seller_name: card.seller_name,
      price_list_name: client?.price_list_name ?? null,
      client_rut: client?.code ?? null,
      client_activity: client?.activity ?? null,
      client_address: client?.address ?? card.address_raw,
      client_commune: client?.commune ?? card.municipality_raw,
      client_city: client?.city ?? card.city_raw,
      client_region: client?.region ?? null,
      client_email: client?.email ?? null,
      client_phone: client?.phone ?? null,
      total_amount: document?.total_amount ?? card.total_amount,
      net_amount: document?.net_amount ?? card.net_amount,
      tax_amount: document?.tax_amount ?? card.tax_amount,
      readiness: readiness === 'READY_TO_INVOICE' ? 'READY_TO_INVOICE' : 'NOT_READY_CONTRACT',
      lines: items.data.map(item => ({
        detail_id: item.detail_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_value: item.unit_value,
        total_amount: item.total_amount,
      })),
    },
    error: null,
  }
}

export type InvoiceReviewPreviewRequest = {
  card_id: string
  current_bsale_nv_id: number
  folio: string
  seller_name: string | null
}

export type InvoiceDocumentPreviewRequest = {
  card_id: string
  current_bsale_nv_id: number
  sales_order_folio: string
  client_name: string
}

export type InvoiceDocumentPreviewReadModel = {
  invoice_bsale_id: number
  invoice_folio: string
  payment_method_name: string | null
  invoice_date: string | null
  client_name: string
  client_rut: string | null
  net_amount: number | null
  tax_amount: number | null
  total_amount: number | null
  document_status: 'CONFIRMED' | 'CANCELLED' | 'UNKNOWN'
  status: 'CONFIRMED' | 'CANCELLED'
  sales_order_folio: string
  official_url: string | null
  pdf_url: string | null
  xml_url: string | null
  related_detail_count: number
  related_detail_ids: number[]
}

export type DevelopmentInvoicePrintDocument = {
  invoice_bsale_id: number
  invoice_folio: string
  pdf_url: string | null
  official_url: string | null
  status: 'CONFIRMED' | 'CANCELLED' | 'UNKNOWN'
}

export type DevelopmentInvoicePrintPdf = DevelopmentInvoicePrintDocument & {
  pdf_base64: string
  byte_length: number
}

/** Development-only read path for manually testing the print assistant. It never creates an attempt. */
export async function getDevelopmentInvoicePrintDocument(invoiceFolio: string): Promise<{ data: DevelopmentInvoicePrintDocument | null; error: string | null }> {
  if (process.env.NODE_ENV !== 'development') return { data: null, error: 'Esta lectura sólo está disponible en desarrollo local.' }

  const normalizedFolio = invoiceFolio.trim()
  if (!/^\d+$/.test(normalizedFolio)) return { data: null, error: 'Ingresa un folio de factura válido.' }

  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: null, error: permissionError }
  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: null, error: 'No se pudo determinar la empresa activa.' }

  const { data: document, error } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('bsale_id, number, state, document_type_id, url_pdf, raw_json')
    .eq('company_id', companyId)
    .eq('document_type_id', 5)
    .eq('number', normalizedFolio)
    .maybeSingle()
  if (error) return { data: null, error: error.message }
  if (!document) return { data: null, error: `No se encontró la factura N.º ${normalizedFolio}.` }

  const raw = document.raw_json && typeof document.raw_json === 'object'
    ? document.raw_json as Record<string, unknown>
    : {}
  const readUrl = (...keys: string[]) => keys
    .map(key => raw[key])
    .find(value => typeof value === 'string' && value.trim()) as string | undefined
  const status = Number(document.state) === 0 ? 'CONFIRMED' : Number(document.state) === 1 ? 'CANCELLED' : 'UNKNOWN'
  return {
    data: {
      invoice_bsale_id: Number(document.bsale_id),
      invoice_folio: String(document.number ?? normalizedFolio),
      pdf_url: readUrl('urlPdf', 'urlPdfOriginal') ?? document.url_pdf ?? null,
      official_url: readUrl('urlPublicView', 'urlPublicViewOriginal') ?? null,
      status,
    },
    error: null,
  }
}

/** Development-only authenticated PDF read. It never accepts arbitrary URLs or writes data. */
export async function getDevelopmentInvoicePrintPdf(invoiceFolio: string): Promise<{ data: DevelopmentInvoicePrintPdf | null; error: string | null }> {
  if (process.env.NODE_ENV !== 'development') return { data: null, error: 'Esta lectura sólo está disponible en desarrollo local.' }

  const documentResult = await getDevelopmentInvoicePrintDocument(invoiceFolio)
  if (documentResult.error || !documentResult.data) return { data: null, error: documentResult.error ?? 'No se encontró el documento.' }
  if (documentResult.data.status !== 'CONFIRMED') return { data: null, error: 'El documento no está confirmado.' }
  const pdfUrl = validateBsalePdfUrl(documentResult.data.pdf_url)
  if (!pdfUrl) return { data: null, error: 'El documento no contiene una URL PDF HTTPS oficial de Bsale.' }

  const maxRedirects = 3
  let currentUrl = pdfUrl
  let response: Response | null = null
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    response = await fetch(currentUrl, { redirect: 'manual', cache: 'no-store' })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    let redirectUrl: string | null = null
    try {
      redirectUrl = location ? new URL(location, currentUrl).href : null
    } catch {
      redirectUrl = null
    }
    const validatedRedirect = redirectUrl ? validateBsaleRedirectUrl(redirectUrl) : null
    if (!validatedRedirect) {
      const hostname = redirectUrl ? new URL(redirectUrl).hostname.toLowerCase() : 'ausente'
      if (process.env.NODE_ENV === 'development') console.debug('[invoice-print][redirect-rejected]', { status: response.status, hostname })
      return { data: null, error: `Bsale redirigió a un destino no autorizado (HTTP ${response.status}, host ${hostname}).` }
    }
    if (process.env.NODE_ENV === 'development') console.debug('[invoice-print][redirect]', { status: response.status, hostname: getSafeHttpsHostname(validatedRedirect) })
    if (redirectCount === maxRedirects) {
      return { data: null, error: `Bsale superó el máximo de redirecciones permitidas (último host ${getSafeHttpsHostname(validatedRedirect) ?? 'no autorizado'}).` }
    }
    currentUrl = validatedRedirect
  }
  if (!response) return { data: null, error: 'No se recibió respuesta al descargar el PDF.' }
  if (!response.ok) return { data: null, error: `Bsale respondió HTTP ${response.status}.` }
  if (response.status !== 200) return { data: null, error: `Bsale respondió HTTP ${response.status} en el destino final.` }
  if (!validateBsalePdfResponseUrl(pdfUrl, response.url)) return { data: null, error: `Bsale respondió desde un destino no autorizado (HTTP ${response.status}, host ${getSafeHttpsHostname(response.url) ?? 'no autorizado'}).` }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  const maxBytes = 12 * 1024 * 1024
  if (declaredLength > maxBytes) return { data: null, error: 'El PDF supera el tamaño máximo permitido para esta prueba.' }
  if (contentType && !contentType.includes('application/pdf')) return { data: null, error: 'Bsale no devolvió un PDF.' }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return { data: null, error: 'El PDF está vacío o supera el tamaño máximo permitido.' }
  const signature = new TextDecoder().decode(bytes.slice(0, 5))
  if (signature !== '%PDF-') return { data: null, error: 'La respuesta no tiene firma PDF válida.' }
  return {
    data: { ...documentResult.data, pdf_base64: Buffer.from(bytes).toString('base64'), byte_length: bytes.byteLength },
    error: null,
  }
}

function readRawDocumentUrl(rawJson: unknown, ...keys: string[]): string | null {
  if (!rawJson || typeof rawJson !== 'object') return null
  const raw = rawJson as Record<string, unknown>
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Batch read of linked invoice metadata. It never downloads or refreshes Bsale files. */
export async function getInvoiceDocumentPreviews(
  companyId: string,
  requests: InvoiceDocumentPreviewRequest[],
) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: {}, error: permissionError }

  const unique = [...new Map(
    requests
      .filter(request => Number.isSafeInteger(request.current_bsale_nv_id))
      .map(request => [`${request.card_id}:${request.current_bsale_nv_id}`, request]),
  ).values()]
  if (unique.length === 0) return { data: {}, error: null }

  const nvIds = unique.map(request => request.current_bsale_nv_id)
  const { data: links, error: linksError } = await supabase
    .schema('integraciones')
    .from('bsale_invoice_sales_order_links')
    .select('invoice_bsale_id, invoice_detail_bsale_id, sales_order_bsale_id, sales_order_detail_bsale_id')
    .eq('company_id', companyId)
    .in('sales_order_bsale_id', nvIds)
  if (linksError) return { data: {}, error: linksError.message }

  const invoiceIds = [...new Set((links ?? []).map(link => Number(link.invoice_bsale_id)).filter(Number.isSafeInteger))]
  if (invoiceIds.length === 0) {
    return { data: Object.fromEntries(unique.map(request => [`${request.card_id}:${request.current_bsale_nv_id}`, []])), error: null }
  }

  const [{ data: documents, error: documentsError }, { data: details, error: detailsError }] = await Promise.all([
    supabase
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id, number, emission_date, net_amount, tax_amount, total_amount, document_type_id, state, client_id, url_pdf, raw_json')
      .eq('company_id', companyId)
      .eq('document_type_id', 5)
      .in('bsale_id', invoiceIds),
    supabase
      .schema('integraciones')
      .from('bsale_document_details')
      .select('bsale_id, bsale_document_id, quantity')
      .eq('company_id', companyId)
      .in('bsale_document_id', invoiceIds),
  ])
  if (documentsError) return { data: {}, error: documentsError.message }
  if (detailsError) return { data: {}, error: detailsError.message }

  const clientIds = [...new Set((documents ?? []).map(document => Number(document.client_id)).filter(Number.isSafeInteger))]
  const { data: clients, error: clientsError } = clientIds.length > 0
    ? await supabase
      .schema('integraciones')
      .from('bsale_clients')
        .select('bsale_client_id, business_name, code, payment_type_name')
      .eq('company_id', companyId)
      .in('bsale_client_id', clientIds)
    : { data: [], error: null }
  if (clientsError) return { data: {}, error: clientsError.message }

  const documentById = new Map((documents ?? []).map(document => [Number(document.bsale_id), document]))
  const clientById = new Map((clients ?? []).map(client => [Number(client.bsale_client_id), client]))
  const detailIdsByInvoice = new Map<number, Set<number>>()
  for (const detail of details ?? []) {
    const invoiceId = Number(detail.bsale_document_id)
    const list = detailIdsByInvoice.get(invoiceId) ?? new Set<number>()
    list.add(Number(detail.bsale_id))
    detailIdsByInvoice.set(invoiceId, list)
  }

  const data: Record<string, InvoiceDocumentPreviewReadModel[]> = {}
  for (const request of unique) {
    const requestLinks = (links ?? []).filter(link => Number(link.sales_order_bsale_id) === request.current_bsale_nv_id)
    const invoiceIdsForRequest = [...new Set(requestLinks.map(link => Number(link.invoice_bsale_id)))]
    data[`${request.card_id}:${request.current_bsale_nv_id}`] = invoiceIdsForRequest
      .map(invoiceId => {
        const document = documentById.get(invoiceId)
        if (!document) return null
        const rawJson = document.raw_json
        const cancellationStatus = readRawDocumentUrl(rawJson, 'cancellationStatus')
        const documentStatus = cancellationStatus || Number(document.state) === 1
          ? 'CANCELLED'
          : Number(document.state) === 0 ? 'CONFIRMED' : 'UNKNOWN'
        const client = document.client_id == null ? null : clientById.get(Number(document.client_id))
        const relatedDetailIds = requestLinks
          .filter(link => Number(link.invoice_bsale_id) === invoiceId)
          .map(link => Number(link.sales_order_detail_bsale_id))
        const invoiceDetailIds = detailIdsByInvoice.get(invoiceId) ?? new Set<number>()
        const pdfUrl = readRawDocumentUrl(rawJson, 'urlPdf', 'urlPdfOriginal') ?? document.url_pdf ?? null
        const officialUrl = readRawDocumentUrl(rawJson, 'urlPublicView', 'urlPublicViewOriginal') ?? pdfUrl
        return {
          invoice_bsale_id: invoiceId,
          invoice_folio: String(document.number ?? invoiceId),
          payment_method_name: client?.payment_type_name ?? null,
          invoice_date: document.emission_date ?? null,
          client_name: client?.business_name ?? request.client_name,
          client_rut: client?.code ?? null,
          net_amount: document.net_amount == null ? null : Number(document.net_amount),
          tax_amount: document.tax_amount == null ? null : Number(document.tax_amount),
          total_amount: document.total_amount == null ? null : Number(document.total_amount),
           status: documentStatus === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED',
           document_status: documentStatus,
          sales_order_folio: request.sales_order_folio,
          official_url: officialUrl,
          pdf_url: pdfUrl,
          xml_url: readRawDocumentUrl(rawJson, 'urlXml'),
          related_detail_count: [...invoiceDetailIds].filter(detailId => requestLinks.some(link => Number(link.invoice_detail_bsale_id) === detailId)).length,
          related_detail_ids: relatedDetailIds,
        } satisfies InvoiceDocumentPreviewReadModel
      })
      .filter((document): document is InvoiceDocumentPreviewReadModel => document !== null)
  }

  logPreparationDiagnostics('invoiceDocumentBatch', {
    requested: requests.length,
    unique: unique.length,
    links: links?.length ?? 0,
    invoices: invoiceIds.length,
    documents: documents?.length ?? 0,
  })
  return { data, error: null }
}

/** Batch presentation read for READY cards. Emission validation remains a separate fresh server contract. */
export async function getInvoiceReviewPreviews(
  companyId: string,
  requests: InvoiceReviewPreviewRequest[],
) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: {}, error: permissionError }

  const unique = [...new Map(
    requests
      .filter(request => Number.isSafeInteger(request.current_bsale_nv_id))
      .map(request => [`${request.card_id}:${request.current_bsale_nv_id}`, request]),
  ).values()]
  if (unique.length === 0) return { data: {}, error: null }

  const nvIds = unique.map(request => request.current_bsale_nv_id)
  const { data: documents, error: documentsError } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('bsale_id, emission_date, net_amount, tax_amount, total_amount, client_id, raw_json')
    .eq('company_id', companyId)
    .in('bsale_id', nvIds)
  if (documentsError) return { data: {}, error: documentsError.message }

  const clientIds = [...new Set((documents ?? []).map(document => Number(document.client_id)).filter(Number.isSafeInteger))]
  const { data: clients, error: clientsError } = clientIds.length > 0
    ? await supabase
      .schema('integraciones')
      .from('bsale_clients')
      .select('bsale_client_id, business_name, code, activity, address, commune, city, region, email, phone, payment_type_id, payment_type_name, sale_condition_id, sale_condition_name, has_credit, price_list_id, price_list_name, credit_limit, raw_payload')
      .eq('company_id', companyId)
      .in('bsale_client_id', clientIds)
    : { data: [], error: null }
  if (clientsError) return { data: {}, error: clientsError.message }

  const { data: items, error: itemsError } = await supabase
    .schema('integraciones')
    .from('vw_bsale_sales_order_items_for_preparation')
    .select('*')
    .eq('company_id', companyId)
    .in('nv_bsale_id', nvIds)
    .order('product_name', { ascending: true })
  if (itemsError) return { data: {}, error: itemsError.message }

  const catalog = await getInvoiceCommercialCatalog(companyId, supabase)

  const documentByNv = new Map((documents ?? []).map(document => [Number(document.bsale_id), document]))
  const clientById = new Map((clients ?? []).map(client => [Number(client.bsale_client_id), client]))
  const itemsByNv = new Map<number, SalesOrderPreparationItem[]>()
  for (const item of (items ?? []) as SalesOrderPreparationItem[]) {
    const current = itemsByNv.get(item.nv_bsale_id) ?? []
    current.push(item)
    itemsByNv.set(item.nv_bsale_id, current)
  }

  const data: Record<string, unknown> = {}
  for (const request of unique) {
    const document = documentByNv.get(request.current_bsale_nv_id)
    const client = document?.client_id == null ? null : clientById.get(Number(document.client_id))
    const documentRaw = document?.raw_json && typeof document.raw_json === 'object' ? document.raw_json as Record<string, unknown> : {}
    const clientRaw = client?.raw_payload && typeof client.raw_payload === 'object' ? client.raw_payload as Record<string, unknown> : {}
    const effectiveSaleConditionId = extractBsaleRelationIdFromHref(documentRaw.sale_condition ?? documentRaw.saleCondition, 'sale_conditions')
    const defaultSaleConditionId = client?.sale_condition_id == null ? extractBsaleRelationIdFromHref(clientRaw.sale_condition, 'sale_conditions') : Number(client.sale_condition_id)
    const effectiveConditionId = effectiveSaleConditionId ?? defaultSaleConditionId
    const defaultPaymentTypeId = client?.payment_type_id == null ? null : Number(client.payment_type_id)
    const defaultPaymentType = catalog.paymentTypes.find(option => option.bsale_id === defaultPaymentTypeId) ?? null
    const effectiveCondition = catalog.saleConditions.find(option => option.bsale_id === effectiveConditionId) ?? null
    data[`${request.card_id}:${request.current_bsale_nv_id}`] = {
      card_id: request.card_id,
      historical_bsale_nv_id: request.current_bsale_nv_id,
      current_bsale_nv_id: request.current_bsale_nv_id,
      folio: request.folio,
      client_name: client?.business_name ?? 'Cliente no disponible',
      emission_date: document?.emission_date ?? null,
      office_name: null,
      sale_condition_name: effectiveCondition?.name ?? null,
      client_id: client?.bsale_client_id ?? null,
      default_payment_type_id: client?.payment_type_id == null ? null : Number(client.payment_type_id),
      default_payment_type_name: client?.payment_type_name ?? defaultPaymentType?.name ?? null,
      default_sale_condition_id: defaultSaleConditionId,
      default_sale_condition_name: client?.sale_condition_name ?? (defaultSaleConditionId == null ? null : catalog.saleConditions.find(option => option.bsale_id === defaultSaleConditionId)?.name ?? null),
      effective_sale_condition_id: effectiveSaleConditionId,
      effective_sale_condition_label: effectiveCondition?.name ?? null,
      effective_sale_condition_source: effectiveSaleConditionId != null ? 'BSALE_DOCUMENT' : defaultSaleConditionId != null ? 'BSALE_CLIENT_FALLBACK' : null,
      effective_time_condition: effectiveCondition?.time_condition ?? null,
      effective_time_unity: effectiveCondition?.time_unity ?? null,
      invoice_emission_date: chileToday(),
      payment_type_options: catalog.paymentTypes,
      sale_condition_options: catalog.saleConditions,
      credit_enabled: client?.has_credit ?? null,
      credit_limit: client?.credit_limit == null ? null : Number(client.credit_limit),
      price_list_id: client?.price_list_id == null ? null : Number(client.price_list_id),
      expiration_date: readRawUnixDate(documentRaw.expirationDate),
      nv_expiration_date: readRawUnixDate(documentRaw.expirationDate),
      seller_name: request.seller_name,
      price_list_name: client?.price_list_name ?? null,
      client_rut: client?.code ?? null,
      client_activity: client?.activity ?? null,
      client_address: client?.address ?? null,
      client_commune: client?.commune ?? null,
      client_city: client?.city ?? null,
      client_region: client?.region ?? null,
      client_email: client?.email ?? null,
      client_phone: client?.phone ?? null,
      total_amount: document?.total_amount ?? null,
      net_amount: document?.net_amount ?? null,
      tax_amount: document?.tax_amount ?? null,
      readiness: 'READY_TO_INVOICE',
      lines: (itemsByNv.get(request.current_bsale_nv_id) ?? []).map(item => ({
        detail_id: item.detail_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_value: item.unit_value,
        total_amount: item.total_amount,
      })),
    }
  }

  logPreparationDiagnostics('invoicePreviewBatch', {
    requested: requests.length,
    unique: unique.length,
    documents: documents?.length ?? 0,
    clients: clients?.length ?? 0,
    items: items?.length ?? 0,
  })
  return { data, error: null }
}

export async function getSalesOrderPreparationLines(
  companyId: string,
  cardId: string,
): Promise<{ data: SalesOrderPreparationLine[]; error: string | null }> {
  const startedAt = performance.now()
  const { supabase, error: permissionError } = await requireLogisticaView()
  const preflightMs = performance.now() - startedAt
  if (permissionError) return { data: [], error: permissionError }

  // Lectura directa: el snapshot ya se materializa en la transición a preparación.
  // Evita pagar materialize() en cada apertura. El RPC queda sólo como fallback legado.
  const readStartedAt = performance.now()
  const { data, error } = await supabase
    .schema('logistica')
    .from('sales_order_preparation_lines')
    .select('*')
    .eq('company_id', companyId)
    .eq('card_id', cardId)
    .is('retired_at', null)
    .order('bsale_detail_id', { ascending: true })
  const readMs = performance.now() - readStartedAt

  if (error) {
    console.error('getSalesOrderPreparationLines error:', error)
    return { data: [], error: error.message }
  }

  if ((data ?? []).length > 0) {
    logPreparationDiagnostics('lines', {
      cardId,
      source: 'table',
      preflightMs: Math.round(preflightMs),
      readMs: Math.round(readMs),
      rows: data?.length ?? 0,
    })
    return { data: (data ?? []) as SalesOrderPreparationLine[], error: null }
  }

  const rpcStartedAt = performance.now()
  const { data: materialized, error: rpcError } = await supabase.schema('logistica').rpc('get_sales_order_preparation_lines', {
    p_company_id: companyId,
    p_card_id: cardId,
  })
  logPreparationDiagnostics('lines', {
    cardId,
    source: 'rpc-fallback',
    preflightMs: Math.round(preflightMs),
    readMs: Math.round(readMs),
    rpcMs: Math.round(performance.now() - rpcStartedAt),
    rows: materialized?.length ?? 0,
  })
  if (rpcError) {
    console.error('getSalesOrderPreparationLines error:', rpcError)
    return { data: [], error: rpcError.message }
  }
  return { data: (materialized ?? []) as SalesOrderPreparationLine[], error: null }
}

export async function confirmSalesOrderPreparationLine(params: {
  companyId: string
  lineId: string
  preparedQuantity: number
  reasonCode?: string | null
  observation?: string | null
  excluded?: boolean
}): Promise<{ data: SalesOrderPreparationLine | null; error: string | null }> {
  // The manage permission is the only required preflight; the view check was a redundant round-trip.
  const { supabase, error: permissionError } = await requireLogisticaManage()
  if (permissionError) return { data: null, error: permissionError }

  // Una cantidad preparada igual a 0 siempre es exclusión operacional de la línea,
  // venga del input numérico o del botón Excluir.
  const excluded = params.excluded === true || params.preparedQuantity === 0

  const { data, error } = await supabase.schema('logistica').rpc('confirm_sales_order_preparation_line', {
    p_company_id: params.companyId,
    p_line_id: params.lineId,
    p_prepared_quantity: params.preparedQuantity,
    p_reason_code: params.reasonCode?.trim() || null,
    p_observation: params.observation?.trim() || null,
    p_excluded: excluded,
  })
  if (error) {
    console.error('confirmSalesOrderPreparationLine error:', error)
    return { data: null, error: error.message }
  }
  return { data: data as SalesOrderPreparationLine, error: null }
}

export type SalesOrderPreparationLock = {
  card_id: string
  assigned_user_id: string | null
  assigned_user_name: string | null
  locked_by_user_id: string | null
  locked_by_user_name: string | null
  locked_at: string | null
  event?: string
}

export async function takeSalesOrderPreparationCard(params: {
  cardId: string
  reason?: string | null
}): Promise<{ data: SalesOrderPreparationLock | null; error: string | null }> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { data: null, error: 'No autorizado' }

    const companyId = await getActiveCompanyId(user)
    if (!companyId) return { data: null, error: 'No se pudo determinar la empresa activa' }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('take_sales_order_preparation_card', {
        p_company_id: companyId,
        p_card_id: params.cardId,
        p_reason: params.reason?.trim() || null,
      })

    if (error) {
      console.error('[takeSalesOrderPreparationCard] RPC error', {
        cardId: params.cardId,
        message: error.message,
        code: error.code,
      })
      return { data: null, error: error.message }
    }

    return { data: data as SalesOrderPreparationLock, error: null }
  } catch (err: unknown) {
    console.error('[takeSalesOrderPreparationCard] Exception:', err)
    return { data: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export type SalesOrderPreparationPrintData = {
  itemsByNv: Record<string, SalesOrderPreparationItem[]>
  clientByNv: Record<string, SalesOrderClientData>
}

export async function getSalesOrderPreparationPrintData(
  companyId: string,
  bsaleNvIds: number[],
): Promise<{ data: SalesOrderPreparationPrintData | null; error: string | null }> {
  const startedAt = performance.now()
  const { supabase, error: permissionError } = await requireLogisticaView()
  const preflightMs = performance.now() - startedAt
  if (permissionError) return { data: null, error: permissionError }

  const nvIds = [...new Set(bsaleNvIds.filter(id => Number.isFinite(id)))]
  const empty: SalesOrderPreparationPrintData = { itemsByNv: {}, clientByNv: {} }
  if (nvIds.length === 0) return { data: empty, error: null }

  const [itemsResult, documentsResult] = await Promise.allSettled([
    supabase
      .schema('integraciones')
      .from('vw_bsale_sales_order_items_for_preparation')
      .select('*')
      .eq('company_id', companyId)
      .in('nv_bsale_id', nvIds)
      .order('product_name', { ascending: true }),
    supabase
      .schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id, client_id')
      .eq('company_id', companyId)
      .in('bsale_id', nvIds),
  ])

  if (itemsResult.status === 'rejected') throw itemsResult.reason
  const { data: items, error: itemsError } = itemsResult.value

  if (itemsError) {
    console.error('getSalesOrderPreparationPrintData items error:', itemsError)
    return { data: null, error: itemsError.message }
  }

  if (documentsResult.status === 'rejected') throw documentsResult.reason
  const { data: documents } = documentsResult.value

  const itemsByNv: Record<string, SalesOrderPreparationItem[]> = {}
  for (const id of nvIds) itemsByNv[String(id)] = []
  for (const item of (items ?? []) as SalesOrderPreparationItem[]) {
    const key = String(item.nv_bsale_id)
    if (!itemsByNv[key]) itemsByNv[key] = []
    itemsByNv[key].push(item)
  }

  const clientIdByNv = new Map<number, number>()
  for (const document of documents ?? []) {
    if (document.client_id != null) {
      clientIdByNv.set(Number(document.bsale_id), Number(document.client_id))
    }
  }

  const clientIds = [...new Set([...clientIdByNv.values()])]
  const clientsById = new Map<number, SalesOrderClientData>()

  if (clientIds.length > 0) {
    const { data: clients } = await supabase
      .schema('integraciones')
      .from('bsale_clients')
      .select('bsale_client_id, code, phone, email')
      .eq('company_id', companyId)
      .in('bsale_client_id', clientIds)

    for (const client of clients ?? []) {
      clientsById.set(Number(client.bsale_client_id), {
        rut: client.code ?? null,
        phone: client.phone ?? null,
        email: client.email ?? null,
      })
    }
  }

  const clientByNv: Record<string, SalesOrderClientData> = {}
  for (const nvId of nvIds) {
    const clientId = clientIdByNv.get(nvId)
    const client = clientId != null ? clientsById.get(clientId) : null
    if (client) clientByNv[String(nvId)] = client
  }

  logPreparationDiagnostics('printData', {
    nvs: nvIds.length,
    preflightMs: Math.round(preflightMs),
    totalMs: Math.round(performance.now() - startedAt),
  })

  return { data: { itemsByNv, clientByNv }, error: null }
}

export async function previewSalesOrderPreparationCandidates(companyId: string, fromDate: string, toDate: string) {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: null, error: permissionError }

  const { data, error } = await supabase
    .rpc('preview_sales_order_preparation_candidates', {
      p_company_id: companyId,
      p_from_date: fromDate,
      p_to_date: toDate
    })

  if (error) {
    console.error('previewSalesOrderPreparationCandidates error:', error)
    return { data: null, error: error.message }
  }

  const result: PreviewCandidatesResult = {
    total_candidates: data?.[0]?.total_candidates ?? 0,
    already_materialized: data?.[0]?.already_materialized ?? 0,
    pending_to_create: data?.[0]?.pending_to_create ?? 0
  }

  return { data: result, error: null }
}

export async function previewNextRouteCandidates() {
  try {
    const { supabase, error: permissionError } = await requireLogisticaView()
    if (permissionError) return { data: null, error: permissionError }

    const admin = await createAdminClient()
    
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('Unauthorized user')
    }

    const companyId = await getActiveCompanyId()

    console.log('[previewNextRouteCandidates] Starting preview', { userId: user.id, companyId })

    const { data, error } = await (admin as any)
      .schema('logistica')
      .rpc('preview_next_route_candidates', {
        p_company_id: companyId,
      })

    if (error) {
      console.error('[previewNextRouteCandidates] RPC error', {
        companyId,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      })
      return { 
        data: null, 
        error: error.message,
        details: error.details ?? null,
        hint: error.hint ?? null,
        code: error.code ?? null
      }
    }

    console.log(`[previewNextRouteCandidates] Success. has_route:`, data?.has_route)
    return { data: data as PreviewNextRouteResult, error: null }
  } catch (err: any) {
    console.error('[previewNextRouteCandidates] Exception:', err)
    return { 
      data: null, 
      error: err?.message || 'Unknown error in previewNextRouteCandidates',
      details: null,
      hint: null,
      code: null
    }
  }
}

export async function getSalesOrderPreparationTrace(): Promise<{ data: SalesOrderPreparationTrace | null; error: string | null }> {
  try {
    const { error: permissionError } = await requireLogisticaView()
    if (permissionError) return { data: null, error: permissionError }

    const admin = await createAdminClient()
    const companyId = await getActiveCompanyId()
    const { data, error } = await (admin as any)
      .schema('logistica')
      .rpc('preview_next_route_candidates', { p_company_id: companyId })

    if (error) return { data: null, error: error.message }
    if (!data?.has_route) return { data: null, error: null }

    const { data: latestEvent, error: eventError } = await admin
      .schema('logistica')
      .from('sales_order_preparation_route_events')
      .select('performed_at')
      .eq('company_id', companyId)
      .in('event_type', ['MATERIALIZED', 'MATERIALIZED_EXCEPTION'])
      .order('performed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (eventError) return { data: null, error: eventError.message }
    const { count: materialized } = latestEvent?.performed_at
      ? await admin
        .schema('logistica')
        .from('sales_order_preparation_route_events')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('event_type', ['MATERIALIZED', 'MATERIALIZED_EXCEPTION'])
        .eq('performed_at', latestEvent.performed_at)
      : { count: 0 }

    return {
      data: {
        materialized: materialized || 0,
        existing: Number(data.counts?.existing_cards || 0),
        outOfCutoff: Number(data.counts?.out_cutoff || 0),
        routeDate: data.route_date || null,
        cities: data.cities || [],
        completedAt: latestEvent?.performed_at || null,
      },
      error: null,
    }
  } catch (err: any) {
    return { data: null, error: err?.message || 'Error leyendo rastro de preparación' }
  }
}

export async function syncNextRoutePreparationCards(options?: { dryRun?: boolean; confirmation?: string }): Promise<SyncNextRouteResult | null> {
  const isDryRun = options?.dryRun ?? true
  const confirmation = options?.confirmation ?? null

  if (!isDryRun) {
    throw new Error('Real materialization is not authorized from UI yet.')
  }

  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return null

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    throw new Error('No user found')
  }

  const companyId = await getActiveCompanyId()

  const { data, error } = await supabase.rpc('sync_next_route_preparation_cards', {
    p_company_id: companyId,
    p_user_id: user.id,
    p_dry_run: isDryRun,
    p_confirmation: confirmation
  })

  if (error) {
    console.error('Error in sync_next_route_preparation_cards:', error)
    if (!isDryRun) {
      throw new Error(error.message)
    }
    return null
  }

  return data as SyncNextRouteResult
}

export async function getSalesOrderClientData(companyId: string, bsaleNvId: number): Promise<{ data: SalesOrderClientData | null, error: string | null }> {
  const { supabase, error: permissionError } = await requireLogisticaView()
  if (permissionError) return { data: null, error: permissionError }

  // First get the client_id from the NV document
  const { data: doc, error: docError } = await supabase
    .schema('integraciones')
    .from('bsale_documents')
    .select('client_id')
    .eq('company_id', companyId)
    .eq('bsale_id', bsaleNvId)
    .single()

  if (docError || !doc || !doc.client_id) {
    return { data: null, error: docError?.message || 'Document or client not found' }
  }

  // Then fetch the client data
  const { data: client, error: clientError } = await supabase
    .schema('integraciones')
    .from('bsale_clients')
    .select('code, phone, email')
    .eq('company_id', companyId)
    .eq('bsale_client_id', doc.client_id)
    .single()

  if (clientError || !client) {
    return { data: null, error: clientError?.message || 'Client details not found' }
  }

  return { 
    data: { 
      rut: client.code, 
      phone: client.phone, 
      email: client.email 
    }, 
    error: null 
  }
}

// ---------------------------------------------------------------------------
// Exclusiones administrativas de NV (Preparación/Bodega).
// La autorización real (auth.uid, empresa, rol SUPER_USUARIO/GERENCIA, tipo/estado
// de NV, tarjeta elegible, duplicados) vive dentro de los RPC producto.
// Estas acciones sólo conservan la sesión autenticada del usuario y delegan.
// ---------------------------------------------------------------------------

export type SalesOrderPreparationExclusion = {
  id: string
  company_id: string
  bsale_nv_id: number
  nv_folio: string
  reason: string
  observation: string | null
  excluded_by: string
  excluded_by_name: string | null
  excluded_at: string
  active: boolean
  revoked_by: string | null
  revoked_by_name: string | null
  revoked_at: string | null
  revoked_reason: string | null
}

export type ExclusionActionResult = {
  ok: boolean
  status: string | null
  error: string | null
}

export async function getSalesOrderPreparationExclusions(): Promise<{ data: SalesOrderPreparationExclusion[]; error: string | null }> {
  try {
    const { supabase, error: permissionError } = await requireLogisticaView()
    if (permissionError) return { data: [], error: permissionError }

    const companyId = await getActiveCompanyId()
    if (!companyId) return { data: [], error: 'No se pudo determinar la empresa activa' }

    // RLS authenticated: core.has_company_access(auth.uid(), company_id).
    const { data, error } = await supabase
      .schema('logistica')
      .from('sales_order_preparation_exclusions')
      .select('*')
      .eq('company_id', companyId)
      .order('excluded_at', { ascending: false })

    if (error) {
      console.error('[getSalesOrderPreparationExclusions] Error:', error)
      return { data: [], error: error.message }
    }

    return { data: (data ?? []) as SalesOrderPreparationExclusion[], error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderPreparationExclusions] Exception:', err)
    return { data: [], error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function excludeSalesOrderPreparationNv(params: {
  bsaleNvId: number | string
  reason: string
  observation?: string | null
}): Promise<ExclusionActionResult> {
  try {
    // Sesión real del usuario: auth.uid() lo deriva el RPC desde este JWT.
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { ok: false, status: null, error: 'No autorizado' }

    const nvId = Number(params.bsaleNvId)
    if (!Number.isFinite(nvId)) return { ok: false, status: null, error: 'Nota de Venta inválida' }

    const reason = params.reason?.trim()
    if (!reason) return { ok: false, status: null, error: 'El motivo es obligatorio' }

    // company activa resuelta en el servidor; nunca desde el frontend.
    const companyId = await getActiveCompanyId(user)
    if (!companyId) return { ok: false, status: null, error: 'No se pudo determinar la empresa activa' }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('exclude_sales_order_preparation_nv', {
        p_company_id: companyId,
        p_bsale_nv_id: nvId,
        p_reason: reason,
        p_observation: params.observation?.trim() || null,
      })

    if (error) {
      console.error('[excludeSalesOrderPreparationNv] RPC error', {
        nvId,
        message: error.message,
        code: error.code,
      })
      return { ok: false, status: null, error: error.message }
    }

    const status = (data as { status?: string } | null)?.status ?? null
    return { ok: status === 'excluded', status, error: null }
  } catch (err: unknown) {
    console.error('[excludeSalesOrderPreparationNv] Exception:', err)
    return { ok: false, status: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function revokeSalesOrderPreparationExclusion(params: {
  bsaleNvId: number | string
  revokedReason: string
}): Promise<ExclusionActionResult> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { ok: false, status: null, error: 'No autorizado' }

    const nvId = Number(params.bsaleNvId)
    if (!Number.isFinite(nvId)) return { ok: false, status: null, error: 'Nota de Venta inválida' }

    const revokedReason = params.revokedReason?.trim()
    if (!revokedReason) return { ok: false, status: null, error: 'El motivo de revocación es obligatorio' }

    const companyId = await getActiveCompanyId(user)
    if (!companyId) return { ok: false, status: null, error: 'No se pudo determinar la empresa activa' }

    const { data, error } = await supabase
      .schema('logistica')
      .rpc('revoke_sales_order_preparation_exclusion', {
        p_company_id: companyId,
        p_bsale_nv_id: nvId,
        p_revoked_reason: revokedReason,
      })

    if (error) {
      console.error('[revokeSalesOrderPreparationExclusion] RPC error', {
        nvId,
        message: error.message,
        code: error.code,
      })
      return { ok: false, status: null, error: error.message }
    }

    const status = (data as { status?: string } | null)?.status ?? null
    return { ok: status === 'revoked', status, error: null }
  } catch (err: unknown) {
    console.error('[revokeSalesOrderPreparationExclusion] Exception:', err)
    return { ok: false, status: null, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export type SalesOrderPreparationMovement = {
  id: string
  company_id: string
  card_id: string
  from_status: string | null
  to_status: string
  moved_by: string | null
  movement_source: string
  pin_validated: boolean
  observation: string | null
  metadata: {
    moved_by_name?: string
  }
  created_at: string
}

export async function moveSalesOrderPreparationCard(params: {
  cardId: string
  toStatus: string
  observation?: string
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    // -----------------------------------------------------------------------
    // 1. Validar usuario autenticado (JWT vía cliente normal)
    // -----------------------------------------------------------------------
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { ok: false, error: 'No autorizado' }
    }

    // -----------------------------------------------------------------------
    // 2. Validar permiso funcional con el cliente autenticado.
    //    has_permission incluye el bypass canónico de system.admin.
    // -----------------------------------------------------------------------
    const { data: allowed, error: permissionError } = await supabase.rpc('has_permission', {
      p_permission_code: 'logistica.preparation.manage',
    })
    if (permissionError || allowed !== true) {
      return { ok: false, error: 'No tienes permiso para gestionar la preparación de pedidos.' }
    }

    // -----------------------------------------------------------------------
    // 3. Obtener nombre real: nombre + apellido, con email como fallback
    //    El cliente admin se usa solo después de validar autorización.
    // -----------------------------------------------------------------------
    const admin = createAdminClient()

    const { data: profile, error: profileError } = await admin
      .from('users')
      .select('nombre, apellido, email, role_id, roles:role_id(name)')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return { ok: false, error: 'No se pudo verificar el perfil del usuario' }
    }

    // Columnas reales en portal.users: nombre, apellido, email
    const nombre   = (profile.nombre   as string | null) ?? ''
    const apellido = (profile.apellido as string | null) ?? ''
    const userName = `${nombre} ${apellido}`.trim() || (profile.email as string | null) || user.id

    // -----------------------------------------------------------------------
    // 4. Obtener companyId en el servidor (nunca desde el frontend)
    // -----------------------------------------------------------------------
    const companyId = await getActiveCompanyId()

    // -----------------------------------------------------------------------
    // 5. Invocar la RPC con service_role
    //    La RPC solo acepta GRANT EXECUTE TO service_role (post-000006)
    //    Se usa schema('logistica') explícito
    // -----------------------------------------------------------------------
    const { data, error } = await admin
      .schema('logistica')
      .rpc('move_sales_order_preparation_card', {
        p_company_id:  companyId,
        p_card_id:     params.cardId,
        p_to_status:   params.toStatus,
        p_observation: params.observation?.trim() || null,
        p_user_id:     user.id,
        p_user_name:   userName,
      })

    if (error) {
      console.error('[moveSalesOrderPreparationCard] RPC error', {
        cardId: params.cardId,
        toStatus: params.toStatus,
        message: error.message,
        details: error.details,
        hint: error.hint,
      })
      return { ok: false, error: error.message }
    }

    return { ok: true, data }
  } catch (err: any) {
    console.error('[moveSalesOrderPreparationCard] Exception:', err)
    return { ok: false, error: err?.message || 'Error desconocido' }
  }
}

export async function getSalesOrderPreparationMovements(
  cardId: string
): Promise<{ data: SalesOrderPreparationMovement[]; error: string | null }> {
  try {
    const { error: permissionError } = await requireLogisticaView()
    if (permissionError) return { data: [], error: permissionError }

    // -----------------------------------------------------------------------
    // 1. Validar usuario autenticado (JWT)
    // -----------------------------------------------------------------------
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return { data: [], error: 'No autorizado' }
    }

    // -----------------------------------------------------------------------
    // 2. Obtener companyId en el servidor
    // -----------------------------------------------------------------------
    const companyId = await getActiveCompanyId()

    // -----------------------------------------------------------------------
    // 3. Leer movimientos con service_role + filtro estricto por company_id
    //    Garantiza aislamiento multi-tenant aunque la tabla no tenga RLS activo
    // -----------------------------------------------------------------------
    const admin = createAdminClient()

    const { data, error } = await admin
      .schema('logistica')
      .from('sales_order_preparation_movements')
      .select('*')
      .eq('company_id', companyId)
      .eq('card_id', cardId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[getSalesOrderPreparationMovements] Error:', error)
      return { data: [], error: error.message }
    }

    return { data: (data ?? []) as SalesOrderPreparationMovement[], error: null }
  } catch (err: any) {
    console.error('[getSalesOrderPreparationMovements] Exception:', err)
    return { data: [], error: err?.message || 'Error desconocido' }
  }
}

export async function authorizeSalesOrderRouteException(params: {
  bsaleNvId: string | number
  routeDate: string
  reason: string
  observation: string
}) {
  if (!params.reason?.trim()) return { ok: false, error: 'El motivo es obligatorio' }
  if (!params.observation?.trim()) return { ok: false, error: 'La observación es obligatoria' }
  if (!params.routeDate) return { ok: false, error: 'La fecha de ruta es obligatoria' }
  if (!params.bsaleNvId || isNaN(Number(params.bsaleNvId))) return { ok: false, error: 'NV ID inválido' }

  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { ok: false, error: 'No autorizado o sesión expirada' }
  }

  const { data: allowed, error: permissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'logistica.preparation.authorize_exception',
  })
  if (permissionError || allowed !== true) {
    return { ok: false, error: 'No tienes permiso para autorizar excepciones de preparación.' }
  }

  const companyId = await getActiveCompanyId()
  const adminClient = createAdminClient()
  
  const { data: profile, error: profileError } = await adminClient
    .schema('portal')
    .from('users')
    .select('nombre, apellido, email, role_id, roles:role_id(name)')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return { ok: false, error: 'No se pudo validar el perfil del usuario' }
  }

  const authorizedByName =
    `${profile.nombre ?? ''} ${profile.apellido ?? ''}`.trim()
    || profile.email
    || user.email
    || user.id

  const { data, error } = await adminClient
    .schema('logistica')
    .rpc('authorize_sales_order_route_exception', {
      p_company_id: companyId,
      p_bsale_nv_id: Number(params.bsaleNvId),
      p_route_date: params.routeDate,
      p_reason: params.reason.trim(),
      p_observation: params.observation.trim(),
      p_authorized_by: user.id,
      p_authorized_by_name: authorizedByName,
    })

  if (error) {
    console.error('authorize_sales_order_route_exception error:', error)
    return { ok: false, error: error.message }
  }

  return data as any
}

export type OperationalBsaleSyncCounts = {
  discovery: number
  refresh: number
  details: number
  detail_errors: number
  reference_errors: number
  missing_details: number
  new_cards: number
  closed_invoiced: number
  skipped_invoiced: number
}

export type OperationalBsaleSyncResult = {
  ok: boolean
  data?: OperationalBsaleSyncCounts
  error?: string
  status?: string
  skipped?: 'fresh' | 'running' | 'throttled'
  health?: WarehousePreparationSyncHealth
}

export async function syncOperationalBsaleSalesOrders(): Promise<OperationalBsaleSyncResult> {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return { ok: false, error: 'No autorizado' }
    }

    const { data: allowed, error: permissionError } = await supabase.rpc('has_permission', {
      p_permission_code: 'logistica.preparation.manage',
    })

    if (permissionError || allowed !== true) {
      return { ok: false, error: 'No tienes permiso para gestionar la preparación de pedidos.' }
    }

    const companyId = await getActiveCompanyId()
    if (!companyId) return { ok: false, error: 'No se pudo determinar la empresa activa' }
    const { runManualWarehouseBsaleRefresh } = await import('@/app/actions/integraciones/bsale-sync')

    const result = await runManualWarehouseBsaleRefresh(companyId)
    if (!result.success) {
      return {
        ok: false,
        status: result.status,
        data: result.counts,
        error: result.status === 'SKIPPED_LOCKED'
          ? 'Ya existe una sincronización en curso.'
          : result.error,
      }
    }
    return { ok: true, data: result.counts }
  } catch (err: unknown) {
    console.error('[syncOperationalBsaleSalesOrders] Exception:', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function syncOperationalBsaleSalesOrdersIfStale(): Promise<OperationalBsaleSyncResult> {
  try {
    const health = await getWarehousePreparationSyncHealth()
    const latestRunAgeMinutes = health.latestRun?.started_at
      ? Math.floor((Date.now() - new Date(health.latestRun.started_at).getTime()) / 60000)
      : null
    const decision = decidePreparationSync({
      lastSuccessAgeMinutes: health.lastSuccessAgeMinutes,
      latestRunStatus: health.latestRun?.status ?? null,
      latestRunAgeMinutes,
    })

    if (decision.action === 'skip') {
      return { ok: true, skipped: decision.reason, health }
    }

    const result = await syncOperationalBsaleSalesOrders()
    const nextHealth = await getWarehousePreparationSyncHealth()

    if (!result.ok && result.status === 'SKIPPED_LOCKED') {
      return { ok: true, skipped: 'running', status: result.status, health: nextHealth }
    }

    return { ...result, health: nextHealth }
  } catch (err: unknown) {
    console.error('[syncOperationalBsaleSalesOrdersIfStale] Exception:', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}
