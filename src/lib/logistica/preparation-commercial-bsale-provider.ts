import type { PreparationCommercialProvider, PreparationDetectionCardIdentity } from './preparation-commercial-detector'
import type { PreparationCommercialLineInput, PreparationCommercialVersion } from './preparation-commercial-version'

type BsaleRawDocument = {
  id?: number | string
  number?: number | string | null
  documentTypeId?: number | string | null
  document_type?: { id?: number | string | null } | null
  state?: number | string | null
  token?: string | null
  emissionDate?: number | string | null
  generationDate?: number | string | null
  totalAmount?: number | string | null
  netAmount?: number | string | null
  taxAmount?: number | string | null
  details?: unknown
  raw_json?: Record<string, unknown>
}

type BsaleRawDetail = {
  id?: number | string
  variantId?: number | string | null
  variant_id?: number | string | null
  variant?: { id?: number | string | null; code?: string | null; description?: string | null } | null
  variantCode?: string | null
  variant_code?: string | null
  description?: string | null
  productName?: string | null
  quantity?: number | string | null
  netUnitValue?: number | string | null
  net_unit_value?: number | string | null
  netAmount?: number | string | null
  net_amount?: number | string | null
  taxAmount?: number | string | null
  tax_amount?: number | string | null
  totalAmount?: number | string | null
  total_amount?: number | string | null
  lineNumber?: number | string | null
  line_number?: number | string | null
}

type NormalizedProductNames = Record<number, string>

type BsaleReadPage<T> = { count: number; items: T[] }

function providerError(code: 'UNAVAILABLE' | 'INCOMPLETE' | 'AMBIGUOUS' | 'NOT_FOUND', message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.name = 'PreparationCommercialProviderError'
  error.code = code
  return error
}

export type BsalePreparationCommercialProviderOptions = {
  fetchPage?: <T>(options: { companyId: string; path: string; params: Record<string, string | number>; signal: AbortSignal }) => Promise<BsaleReadPage<T>>
  resolveProductNames?: (companyId: string, variantIds: number[], signal: AbortSignal) => Promise<NormalizedProductNames>
}

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function documentToken(document: BsaleRawDocument): string | null {
  const rawToken = document.raw_json?.token
  return String(document.token ?? rawToken ?? '').trim() || null
}

function epochToIso(value: unknown): string | null {
  const numericValue = numeric(value)
  if (numericValue == null) return typeof value === 'string' && value.includes('T') ? value : null
  return new Date(numericValue * 1000).toISOString()
}

function extractDetails(value: unknown): { items: BsaleRawDetail[]; complete: boolean } {
  if (Array.isArray(value)) return { items: value as BsaleRawDetail[], complete: true }
  if (!value || typeof value !== 'object') return { items: [], complete: false }
  const page = value as { items?: unknown; count?: unknown }
  if (!Array.isArray(page.items)) return { items: [], complete: false }
  const count = numeric(page.count)
  return { items: page.items as BsaleRawDetail[], complete: count == null || page.items.length >= count }
}

async function resolveNormalizedProductNames(companyId: string, variantIds: number[], signal: AbortSignal): Promise<NormalizedProductNames> {
  if (variantIds.length === 0) return {}
  if (signal.aborted) throw providerError('UNAVAILABLE', 'Se canceló la resolución de nombres normalizados.')
  const { createAdminClient } = await import('../supabase/admin')
  const db = createAdminClient()
  const { data, error } = await db.schema('integraciones')
    .from('vw_bsale_sales_order_items_for_preparation')
    .select('variant_id, product_name')
    .eq('company_id', companyId)
    .in('variant_id', variantIds)
  if (error) throw providerError('INCOMPLETE', `No se pudo resolver el nombre normalizado de los productos: ${error.message}`)
  const names = Object.fromEntries(
    (data ?? [])
      .filter(row => Number.isFinite(Number(row.variant_id)) && typeof row.product_name === 'string' && row.product_name.trim())
      .map(row => [Number(row.variant_id), row.product_name.trim()]),
  )
  const missingVariantIds = variantIds.filter(variantId => !names[variantId])
  if (missingVariantIds.length > 0) {
    throw providerError('INCOMPLETE', `Faltan nombres normalizados para las variantes Bsale: ${missingVariantIds.join(', ')}.`)
  }
  return names
}

function normalizeBsaleVersion(document: BsaleRawDocument, details: BsaleRawDetail[], identity: PreparationDetectionCardIdentity, productNames: NormalizedProductNames = {}): PreparationCommercialVersion {
  const id = numeric(document.id)
  if (id == null) throw providerError('INCOMPLETE', 'Bsale devolvió un documento sin ID.')
  return {
    identity: { canonicalToken: identity.canonicalToken!, historicalBsaleId: identity.historicalBsaleId ?? id, currentBsaleId: id, folio: String(document.number ?? identity.folio) },
    physicalId: id,
    generationDate: epochToIso(document.generationDate),
    emissionDate: epochToIso(document.emissionDate),
    lines: details.map((detail): PreparationCommercialLineInput => ({
      detailId: numeric(detail.id),
      variantId: numeric(detail.variantId ?? detail.variant_id ?? detail.variant?.id),
      sku: detail.variantCode ?? detail.variant_code ?? detail.variant?.code ?? null,
      productName: productNames[numeric(detail.variantId ?? detail.variant_id ?? detail.variant?.id) ?? -1]
        ?? detail.productName ?? detail.description ?? detail.variant?.description ?? null,
      quantity: numeric(detail.quantity) ?? 0,
      unitNetValue: numeric(detail.netUnitValue ?? detail.net_unit_value),
      lineNetAmount: numeric(detail.netAmount ?? detail.net_amount),
      lineTaxAmount: numeric(detail.taxAmount ?? detail.tax_amount),
      lineGrossAmount: numeric(detail.totalAmount ?? detail.total_amount),
      lineNumber: numeric(detail.lineNumber ?? detail.line_number),
    })),
    netAmount: numeric(document.netAmount),
    taxAmount: numeric(document.taxAmount),
    totalAmount: numeric(document.totalAmount),
  }
}

async function defaultFetchPage<T>(options: { companyId: string; path: string; params: Record<string, string | number>; signal: AbortSignal }): Promise<BsaleReadPage<T>> {
  const { bsaleFetchForCompany } = await import('../bsale/client')
  return bsaleFetchForCompany<T>(options)
}

async function fetchAllDocumentCandidates(
  fetchPage: <T>(options: { companyId: string; path: string; params: Record<string, string | number>; signal: AbortSignal }) => Promise<BsaleReadPage<T>>,
  identity: PreparationDetectionCardIdentity,
  signal: AbortSignal,
): Promise<BsaleRawDocument[]> {
  const pageSize = 50
  const maxPages = 20
  const documents: BsaleRawDocument[] = []
  let offset = 0
  let expectedCount: number | null = null
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage<BsaleRawDocument>({ companyId: identity.companyId, path: '/documents.json', params: { documenttypeid: 23, number: identity.folio!, limit: pageSize, offset }, signal })
    expectedCount = expectedCount ?? numeric(page.count)
    if (!Array.isArray(page.items)) throw providerError('INCOMPLETE', 'La respuesta de Bsale no contiene una lista de documentos.')
    documents.push(...page.items)
    if (page.items.length < pageSize || (expectedCount != null && documents.length >= expectedCount)) return documents
    offset += pageSize
  }
  throw providerError('INCOMPLETE', 'Bsale no entregó todos los candidatos de la Nota de Venta.')
}

export function createBsalePreparationCommercialProvider(providerOptions: BsalePreparationCommercialProviderOptions = {}): PreparationCommercialProvider {
  const fetchPage = providerOptions.fetchPage ?? defaultFetchPage
  const resolveProductNames = providerOptions.resolveProductNames
    ?? (providerOptions.fetchPage ? undefined : resolveNormalizedProductNames)
  return {
    async getCurrentVersion(identity, signal) {
      const documents = (await fetchAllDocumentCandidates(fetchPage, identity, signal))
        .filter(document => Number(document.documentTypeId ?? document.document_type?.id) === 23 && String(document.number ?? '') === identity.folio && documentToken(document) === identity.canonicalToken)
      if (documents.length === 0) throw providerError('NOT_FOUND', 'No se encontró una Nota de Venta vigente para el token canónico.')
      const selected = [...documents].sort((left, right) => {
        const generationDifference = (numeric(right.generationDate) ?? 0) - (numeric(left.generationDate) ?? 0)
        return generationDifference || (numeric(right.id) ?? 0) - (numeric(left.id) ?? 0)
      })[0]
      if (Number(selected.state) !== 0) throw providerError('INCOMPLETE', 'La versión Bsale encontrada no está operativa.')
      let detailResult = extractDetails(selected.details)
      if (!detailResult.complete) {
        const detailPage = await fetchPage<BsaleRawDetail>({ companyId: identity.companyId, path: `/documents/${selected.id}/details.json`, params: { limit: 50, offset: 0 }, signal })
        detailResult = extractDetails(detailPage)
      }
      if (!detailResult.complete) throw providerError('INCOMPLETE', 'La respuesta de Bsale no contiene todos los detalles de la NV.')
      const variantIds = [...new Set(detailResult.items
        .map(detail => numeric(detail.variantId ?? detail.variant_id ?? detail.variant?.id))
        .filter((variantId): variantId is number => variantId != null))]
      const productNames = resolveProductNames
        ? await resolveProductNames(identity.companyId, variantIds, signal)
        : {}
      if (resolveProductNames) {
        const missingProductNames = variantIds.filter(variantId => !productNames[variantId])
        if (missingProductNames.length > 0) {
          throw providerError('INCOMPLETE', `Faltan nombres normalizados para las variantes Bsale: ${missingProductNames.join(', ')}.`)
        }
      }
      return normalizeBsaleVersion(selected, detailResult.items, identity, productNames)
    },
  }
}
