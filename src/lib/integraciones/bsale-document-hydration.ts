import { createClient, type SupabaseClient } from '@supabase/supabase-js'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { getBsaleConfigForCompany } from '../bsale/company-config.ts'
import { normalizeBsaleRelatedDetailId } from './bsale-invoice-sales-order-link'

export interface BsaleDocumentPayload {
  id: number
  number?: number | string | null
  documentTypeId?: number | string | null
  document_type?: { id?: number | string | null } | null
  emissionDate?: number | null
  generationDate?: number | null
  totalAmount?: number | string | null
  netAmount?: number | string | null
  taxAmount?: number | string | null
  exemptAmount?: number | string | null
  client?: { id?: number | string | null } | null
  clientId?: number | string | null
  office?: { id?: number | string | null } | null
  officeId?: number | string | null
  state?: number | string | null
  trackingNumber?: string | null
  urlPdf?: string | null
  [key: string]: unknown
}

interface BsaleDocumentDetailPayload {
  id?: number | string | null
  lineNumber?: number | null
  relatedDetailId?: number | string | null
  quantity?: number | string | null
  netUnitValue?: number | string | null
  netUnitValueRaw?: number | string | null
  totalUnitValue?: number | string | null
  netAmount?: number | string | null
  taxAmount?: number | string | null
  totalAmount?: number | string | null
  netDiscount?: number | string | null
  variant?: { id?: number | string | null; code?: string | null; description?: string | null } | null
  [key: string]: unknown
}

export type BsaleJsonFetcher = <T>(baseUrl: string, headers: Record<string, string>, path: string) => Promise<T>

export interface BsaleDocumentHydrationResult {
  document: BsaleDocumentPayload
  details: BsaleDocumentDetailPayload[]
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function epochToIso(value: unknown): string | null {
  const parsed = numberOrNull(value)
  return parsed === null ? null : new Date(parsed * 1000).toISOString()
}

function normalizeSku(value: string) {
  return value.trim().toUpperCase()
}

export function mapBsaleDocument(companyId: string, runId: string | null, document: BsaleDocumentPayload) {
  return {
    company_id: companyId,
    bsale_id: document.id,
    number: numberOrNull(document.number),
    emission_date: epochToIso(document.emissionDate)?.slice(0, 10) || null,
    generation_date: epochToIso(document.generationDate),
    total_amount: document.totalAmount ?? null,
    net_amount: document.netAmount ?? null,
    tax_amount: document.taxAmount ?? null,
    exempt_amount: document.exemptAmount ?? null,
    document_type_id: numberOrNull(document.documentTypeId ?? document.document_type?.id),
    client_id: numberOrNull(document.client?.id ?? document.clientId),
    office_id: numberOrNull(document.office?.id ?? document.officeId),
    state: numberOrNull(document.state),
    tracking_number: document.trackingNumber || null,
    url_pdf: document.urlPdf || null,
    raw_json: document,
    bsale_sync_run_id: runId,
    synced_at: new Date().toISOString(),
  }
}

export function mapBsaleDocumentDetails(companyId: string, runId: string | null, documentId: number, details: BsaleDocumentDetailPayload[]) {
  return details.map((detail, index) => ({
    company_id: companyId,
    bsale_id: numberOrNull(detail.id),
    bsale_document_id: documentId,
    related_detail_bsale_id: normalizeBsaleRelatedDetailId(detail.relatedDetailId),
    line_number: detail.lineNumber ?? index,
    quantity: detail.quantity ?? 0,
    net_unit_value: detail.netUnitValue ?? detail.netUnitValueRaw ?? 0,
    total_unit_value: detail.totalUnitValue ?? 0,
    net_amount: detail.netAmount ?? 0,
    tax_amount: detail.taxAmount ?? 0,
    total_amount: detail.totalAmount ?? 0,
    net_discount: detail.netDiscount ?? 0,
    variant_id: numberOrNull(detail.variant?.id),
    variant_code: detail.variant?.code ? normalizeSku(detail.variant.code) : null,
    variant_description: detail.variant?.description || null,
    raw_json: detail,
    bsale_sync_run_id: runId,
    synced_at: new Date().toISOString(),
  }))
}

// Supabase clients are created with the runtime schema; the shared helper accepts any generated schema shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function upsertBsaleDocument(client: SupabaseClient<any, any, any>, companyId: string, runId: string | null, document: BsaleDocumentPayload) {
  const { error } = await client.schema('integraciones').from('bsale_documents').upsert(
    mapBsaleDocument(companyId, runId, document),
    { onConflict: 'company_id,bsale_id', ignoreDuplicates: false },
  )
  if (error) throw new Error(`Error upserting bsale_documents: ${error.message}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function upsertBsaleDocumentDetails(client: SupabaseClient<any, any, any>, companyId: string, runId: string | null, documentId: number, details: BsaleDocumentDetailPayload[]) {
  const records = mapBsaleDocumentDetails(companyId, runId, documentId, details)
  if (!records.length) return
  const { error } = await client.schema('integraciones').from('bsale_document_details').upsert(records, {
    onConflict: 'company_id,bsale_id',
    ignoreDuplicates: false,
  })
  if (error) throw new Error(`Error upserting bsale_document_details: ${error.message}`)
}

async function defaultFetchBsaleJson<T>(baseUrl: string, headers: Record<string, string>, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Bsale API error ${response.status} at ${path}`)
  return response.json() as Promise<T>
}

export async function hydrateBsaleDocumentsById(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any, any, any>,
  companyId: string,
  documentIds: number[],
  runId: string | null = null,
  fetchJson: BsaleJsonFetcher = defaultFetchBsaleJson,
): Promise<BsaleDocumentHydrationResult[]> {
  const uniqueIds = [...new Set(documentIds)]
  const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
  const headers = { access_token: accessToken, 'Content-Type': 'application/json', Accept: 'application/json' }
  const results: BsaleDocumentHydrationResult[] = []

  for (const documentId of uniqueIds) {
    const document = await fetchJson<BsaleDocumentPayload>(baseUrl, headers, `/documents/${documentId}.json`)
    if (Number(document.id) !== documentId) throw new Error(`Bsale document identity mismatch for ${documentId}`)
    const details: BsaleDocumentDetailPayload[] = []
    for (let offset = 0; ; offset += 50) {
      const detailsPayload = await fetchJson<{ items?: BsaleDocumentDetailPayload[] }>(baseUrl, headers, `/documents/${documentId}/details.json?limit=50&offset=${offset}`)
      const page = detailsPayload.items || []
      details.push(...page)
      if (page.length < 50) break
    }
    await upsertBsaleDocument(client, companyId, runId, document)
    await upsertBsaleDocumentDetails(client, companyId, runId, documentId, details)
    results.push({ document, details })
  }

  return results
}

export function createIntegracionesClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
