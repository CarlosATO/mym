import type { BsaleResponse } from '@/lib/bsale/client'
import {
  getBsaleConfigForCompany,
  getBsaleHeadersForCompany,
  KNOWN_COMPANY_IDS,
} from '@/lib/bsale/company-config'

export const CAYLO_COMPANY_ID = KNOWN_COMPANY_IDS.CAYLO
export const BSALE_THIRD_PARTY_DOCUMENTS_PATH = '/third_party_documents.json'
export const BSALE_THIRD_PARTY_DOCUMENTS_CUTOFF_DATE = '2026-01-01'
export const BSALE_THIRD_PARTY_DOCUMENTS_PAGE_LIMIT = 50
export const BSALE_THIRD_PARTY_DOCUMENTS_UPSERT_BATCH_SIZE = 100

export const ALLOWED_BSALE_THIRD_PARTY_CODES_SII = ['33', '34', '61', '56'] as const
export type AllowedBsaleThirdPartyCodeSii =
  (typeof ALLOWED_BSALE_THIRD_PARTY_CODES_SII)[number]

const ALLOWED_CODES_SII_SET = new Set<string>(ALLOWED_BSALE_THIRD_PARTY_CODES_SII)

export interface BsaleThirdPartyDocumentRaw {
  href?: string | null
  id?: number | string | null
  codeSii?: string | number | null
  emissionDate?: number | string | null
  siiReceptionDate?: number | string | null
  type?: string | null
  month?: number | string | null
  year?: number | string | null
  number?: number | string | null
  clientCode?: string | null
  clientActivity?: string | null
  exemptAmount?: number | string | null
  netAmount?: number | string | null
  ivaRate?: number | string | null
  ivaAmount?: number | string | null
  ivaOutOfTime?: number | string | null
  ivaNotRecoverable?: number | string | null
  ivaAmountWithheld?: number | string | null
  fixedAsset?: number | string | null
  commissionTotalNet?: number | string | null
  commissionTotalExempt?: number | string | null
  commissionTotalIva?: number | string | null
  specificTaxCode?: string | number | null
  specificTaxAmount?: string | number | null
  specificTaxRate?: string | number | null
  additionalTaxAmount?: number | string | null
  totalAmount?: number | string | null
  reportedSii?: number | string | null
  thirdSii?: number | string | null
  canceled?: number | string | null
  addBook?: number | string | null
  docsCount?: number | string | null
  include?: number | string | null
  siiInProgress?: boolean | number | string | null
  siiStatus?: string[] | null
  liquidationCode?: string | null
  urlPdf?: string | null
  urlXml?: string | null
  [key: string]: unknown
}

export interface NormalizedBsaleThirdPartyDocumentRecord {
  company_id: string
  bsale_document_id: number
  bsale_href: string | null
  code_sii: AllowedBsaleThirdPartyCodeSii
  document_number: number
  document_folio: string
  client_code: string
  issuer_rut_normalized: string
  client_activity: string
  emission_timestamp: number
  emission_date: string
  sii_reception_timestamp: number | null
  sii_reception_date: string | null
  book_type: string
  tax_month: number
  tax_year: number
  exempt_amount: number
  net_amount: number
  iva_rate: number
  iva_amount: number
  iva_out_of_time_amount: number
  iva_not_recoverable_amount: number
  iva_amount_withheld: number
  fixed_asset_amount: number
  commission_total_net_amount: number
  commission_total_exempt_amount: number
  commission_total_iva_amount: number
  specific_tax_code: string | null
  specific_tax_rate_raw: string | null
  specific_tax_rate: number | null
  specific_tax_amount_raw: string | null
  specific_tax_amount: number | null
  additional_tax_amount: number | null
  total_amount: number
  reported_sii: number
  third_sii: number
  canceled: number
  add_book: number
  docs_count: number
  include_flag: number
  sii_in_progress: boolean
  sii_status: string[] | null
  liquidation_code: string | null
  url_pdf: string | null
  url_xml: string | null
  raw_json: Record<string, unknown>
}

export type NormalizeBsaleThirdPartyDocumentOutcome =
  | {
      status: 'ELIGIBLE'
      record: NormalizedBsaleThirdPartyDocumentRecord
    }
  | {
      status: 'SKIPPED_BEFORE_CUTOFF'
      bsaleDocumentId: number
      codeSii: string
      emissionDate: string
      taxYear: number
      taxMonth: number
    }
  | {
      status: 'SKIPPED_UNSUPPORTED_CODE_SII'
      bsaleDocumentId: number
      codeSii: string
      emissionDate: string | null
    }
  | {
      status: 'INVALID'
      bsaleDocumentId: number | null
      reason: string
    }

export interface BsaleThirdPartySyncErrorEntry {
  phase: 'FETCH_PAGE' | 'PAGINATION_INTEGRITY' | 'NORMALIZE' | 'UPSERT_BATCH'
  year?: number
  offset?: number
  bsaleDocumentId?: number | null
  message: string
}

export interface BsaleThirdPartyUpsertBatchResult {
  processed_count: number
  inserted_count: number
  updated_count: number
  synced_at?: string
}

export interface BsaleThirdPartyDocumentsSyncSummary {
  companyId: string
  cutoffEmissionDate: string
  yearsQueried: number[]
  dryRun: boolean
  status: 'SUCCESS' | 'PARTIAL_ERROR' | 'INCOMPLETE_RESPONSE' | 'FAILED'
  pagesFetched: number
  totalReportedByBsale: number
  totalFetchedRaw: number
  uniqueDocumentsFetched: number
  duplicateIdsSkipped: number
  skippedBeforeCutoffCount: number
  skippedUnsupportedCodeSiiCount: number
  invalidCount: number
  eligibleCount: number
  eligibleInvoicesCount: number
  eligibleNotesCount: number
  byCodeSii: Record<AllowedBsaleThirdPartyCodeSii, number>
  withSiiStatusNullCount: number
  withUrlPdfCount: number
  withoutUrlPdfCount: number
  withUrlXmlCount: number
  withoutUrlXmlCount: number
  withSpecificTaxCount: number
  upsertedProcessedCount: number
  upsertedInsertedCount: number
  upsertedUpdatedCount: number
  incompleteResponseDetected: boolean
  errors: BsaleThirdPartySyncErrorEntry[]
  records: NormalizedBsaleThirdPartyDocumentRecord[]
}

export type FetchBsaleThirdPartyPageFn = (params: {
  companyId: string
  year: number
  limit: number
  offset: number
  signal?: AbortSignal
}) => Promise<BsaleResponse<BsaleThirdPartyDocumentRaw>>

export type UpsertBsaleThirdPartyBatchFn = (params: {
  companyId: string
  documents: NormalizedBsaleThirdPartyDocumentRecord[]
  syncedAt: string
}) => Promise<BsaleThirdPartyUpsertBatchResult>

export interface SyncBsaleThirdPartyDocumentsOptions {
  companyId?: string
  years?: number[]
  cutoffEmissionDate?: string
  pageLimit?: number
  upsertBatchSize?: number
  dryRun?: boolean
  syncedAt?: string
  signal?: AbortSignal
  fetchPage?: FetchBsaleThirdPartyPageFn
  upsertBatch?: UpsertBsaleThirdPartyBatchFn
}

/**
 * Normaliza un RUT chileno al formato canónico sin puntos ni guion (ej. "77.763.917-k" -> "77763917K").
 */
export function normalizeSupplierRut(rawRut: string | null | undefined): string {
  const cleaned = String(rawRut ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-\s]/g, '')
  if (!/^[0-9]{1,8}[0-9K]$/.test(cleaned)) {
    throw new Error(`RUT de proveedor inválido: "${String(rawRut ?? '')}"`)
  }
  return cleaned
}

/**
 * Normaliza el folio tributario eliminando ceros a la izquierda redundantes.
 */
export function normalizeDocumentFolio(rawNumber: number | string | null | undefined): {
  documentNumber: number
  documentFolio: string
} {
  const str = String(rawNumber ?? '').trim()
  if (!/^[0-9]+$/.test(str)) {
    throw new Error(`Folio de documento inválido: "${String(rawNumber ?? '')}"`)
  }
  const parsed = Number(str)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Folio de documento fuera de rango entero: "${str}"`)
  }
  const folio = str.replace(/^0+([0-9])/, '$1')
  return {
    documentNumber: parsed,
    documentFolio: folio,
  }
}

/**
 * Convierte un timestamp Unix (en segundos) de Bsale a fecha civil UTC YYYY-MM-DD.
 * Bsale entrega emissionDate a las 00:00:00 UTC del día civil de emisión.
 */
export function unixSecondsToUtcIsoDate(
  rawSeconds: number | string | null | undefined
): { timestamp: number; isoDate: string } {
  const seconds = typeof rawSeconds === 'number' ? rawSeconds : Number(String(rawSeconds ?? '').trim())
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`Timestamp de fecha inválido: "${String(rawSeconds ?? '')}"`)
  }
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Timestamp fuera de rango: "${String(rawSeconds ?? '')}"`)
  }
  return {
    timestamp: seconds,
    isoDate: date.toISOString().slice(0, 10),
  }
}

/**
 * Convierte un timestamp Unix opcional (en segundos) a ISO 8601 UTC completo.
 */
export function optionalUnixSecondsToIsoTimestamp(
  rawSeconds: number | string | null | undefined
): { timestamp: number | null; isoTimestamp: string | null } {
  if (rawSeconds === null || rawSeconds === undefined || String(rawSeconds).trim() === '') {
    return { timestamp: null, isoTimestamp: null }
  }
  const seconds = typeof rawSeconds === 'number' ? rawSeconds : Number(String(rawSeconds).trim())
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    return { timestamp: null, isoTimestamp: null }
  }
  return {
    timestamp: seconds,
    isoTimestamp: new Date(seconds * 1000).toISOString(),
  }
}

/**
 * Bsale serializa los impuestos específicos como strings separados/terminados por guion
 * (ej. "76147.0-", "12.0-", "28-", o múltiples tasas/importes concatenados como "1000.0-2500.0-") o "".
 *
 * - Para importes (`mode = 'sum'`), suma todos los tramos de impuesto específico del documento.
 * - Para tasas (`mode = 'single_or_null'`), devuelve la tasa numérica si hay un único valor (o todos coinciden),
 *   y `null` cuando el documento combina múltiples tasas distintas, conservando siempre el texto original en `raw`.
 */
export function parseBsaleSpecificTaxNumber(
  rawValue: string | number | null | undefined,
  mode: 'sum' | 'single_or_null' = 'sum'
): { raw: string | null; numeric: number | null } {
  if (rawValue === null || rawValue === undefined) {
    return { raw: null, numeric: null }
  }
  const rawTrimmed = String(rawValue).trim()
  if (!rawTrimmed) {
    return { raw: null, numeric: null }
  }
  const tokens = rawTrimmed
    .split('-')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  if (tokens.length === 0) {
    return { raw: rawTrimmed, numeric: null }
  }

  const parsedTokens: number[] = []
  for (const token of tokens) {
    const parsed = Number(token)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Valor de impuesto específico inválido: "${rawTrimmed}"`)
    }
    parsedTokens.push(parsed)
  }

  if (mode === 'single_or_null') {
    const first = parsedTokens[0]
    const allSame = parsedTokens.every((v) => Math.abs(v - first) < 1e-9)
    return {
      raw: rawTrimmed,
      numeric: allSame ? Math.round(first * 10000) / 10000 : null,
    }
  }

  const total = parsedTokens.reduce((acc, v) => acc + v, 0)
  return {
    raw: rawTrimmed,
    numeric: Math.round(total * 10000) / 10000,
  }
}

function parseNonNegativeNumber(
  rawValue: number | string | null | undefined,
  fieldName: string,
  defaultValue = 0
): number {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    return defaultValue
  }
  const parsed = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim())
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Campo numérico inválido (${fieldName}): "${String(rawValue)}"`)
  }
  return Math.round(parsed * 100) / 100
}

function parseSignedNumber(
  rawValue: number | string | null | undefined,
  fieldName: string,
  defaultValue = 0
): number {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    return defaultValue
  }
  const parsed = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim())
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo numérico inválido (${fieldName}): "${String(rawValue)}"`)
  }
  return Math.round(parsed * 100) / 100
}

function parseOptionalNumber(
  rawValue: number | string | null | undefined,
  fieldName: string
): number | null {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    return null
  }
  const parsed = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim())
  if (!Number.isFinite(parsed)) {
    throw new Error(`Campo numérico opcional inválido (${fieldName}): "${String(rawValue)}"`)
  }
  return Math.round(parsed * 100) / 100
}

function parseIntegerFlag(
  rawValue: number | string | null | undefined,
  fieldName: string,
  defaultValue = 0
): number {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    return defaultValue
  }
  const parsed = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim())
  if (!Number.isInteger(parsed)) {
    throw new Error(`Campo entero inválido (${fieldName}): "${String(rawValue)}"`)
  }
  return parsed
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Evalúa y normaliza un documento recibido desde GET /v1/third_party_documents.json.
 *
 * Reglas críticas:
 * - Exclusivo para Caylo (d1000000-0000-0000-0000-000000000001).
 * - Filtra por codeSii en ('33', '34', '61', '56').
 * - Filtra por fecha de emisión real (emission_date >= '2026-01-01'), sin confundirla con
 *   el período tributario (month / year).
 * - Conserva intactos los estados originales de Bsale (incluido siiStatus: null), sin
 *   interpretar automáticamente el documento como aceptado, pagado o de Servicios.
 */
export function normalizeBsaleThirdPartyDocument(
  raw: BsaleThirdPartyDocumentRaw,
  options?: {
    companyId?: string
    cutoffEmissionDate?: string
  }
): NormalizeBsaleThirdPartyDocumentOutcome {
  const companyId = options?.companyId ?? CAYLO_COMPANY_ID
  const cutoffEmissionDate =
    options?.cutoffEmissionDate ?? BSALE_THIRD_PARTY_DOCUMENTS_CUTOFF_DATE

  if (companyId !== CAYLO_COMPANY_ID) {
    throw new Error(
      `Sincronización de third_party_documents permitida exclusivamente para Caylo (${CAYLO_COMPANY_ID})`
    )
  }

  if (!raw || typeof raw !== 'object') {
    return {
      status: 'INVALID',
      bsaleDocumentId: null,
      reason: 'El elemento recibido desde Bsale no es un objeto JSON válido',
    }
  }

  const rawId = raw.id
  const bsaleDocumentId =
    typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim())
  if (!Number.isSafeInteger(bsaleDocumentId) || bsaleDocumentId <= 0) {
    return {
      status: 'INVALID',
      bsaleDocumentId: null,
      reason: `Identificador Bsale inválido: "${String(rawId ?? '')}"`,
    }
  }

  const codeSii = String(raw.codeSii ?? '').trim()
  if (!codeSii) {
    return {
      status: 'INVALID',
      bsaleDocumentId,
      reason: 'El documento no contiene codeSii',
    }
  }

  let emissionInfo: { timestamp: number; isoDate: string }
  try {
    emissionInfo = unixSecondsToUtcIsoDate(raw.emissionDate)
  } catch (err) {
    return {
      status: 'INVALID',
      bsaleDocumentId,
      reason: err instanceof Error ? err.message : 'Fecha de emisión inválida',
    }
  }

  if (!ALLOWED_CODES_SII_SET.has(codeSii)) {
    return {
      status: 'SKIPPED_UNSUPPORTED_CODE_SII',
      bsaleDocumentId,
      codeSii,
      emissionDate: emissionInfo.isoDate,
    }
  }

  let taxMonth: number
  let taxYear: number
  try {
    taxMonth = parseIntegerFlag(raw.month, 'month')
    taxYear = parseIntegerFlag(raw.year, 'year')
    if (taxMonth < 1 || taxMonth > 12 || taxYear < 2000) {
      throw new Error(`Período tributario inválido: ${taxMonth}/${taxYear}`)
    }
  } catch (err) {
    return {
      status: 'INVALID',
      bsaleDocumentId,
      reason: err instanceof Error ? err.message : 'Período tributario inválido',
    }
  }

  // No confundir fecha de emisión con período tributario (ej. emitidos en dic-2025 en libro ene-2026)
  if (emissionInfo.isoDate < cutoffEmissionDate) {
    return {
      status: 'SKIPPED_BEFORE_CUTOFF',
      bsaleDocumentId,
      codeSii,
      emissionDate: emissionInfo.isoDate,
      taxYear,
      taxMonth,
    }
  }

  try {
    const { documentNumber, documentFolio } = normalizeDocumentFolio(raw.number)
    const clientCode = normalizeOptionalString(raw.clientCode)
    if (!clientCode) {
      throw new Error('clientCode (RUT emisor) ausente')
    }
    const issuerRutNormalized = normalizeSupplierRut(clientCode)
    const clientActivity = normalizeOptionalString(raw.clientActivity)
    if (!clientActivity) {
      throw new Error('clientActivity (nombre proveedor) ausente')
    }

    const receptionInfo = optionalUnixSecondsToIsoTimestamp(raw.siiReceptionDate)
    const bookType = normalizeOptionalString(raw.type) ?? 'buy'

    const specificTaxRate = parseBsaleSpecificTaxNumber(
      raw.specificTaxRate,
      'single_or_null'
    )
    const specificTaxAmount = parseBsaleSpecificTaxNumber(
      raw.specificTaxAmount,
      'sum'
    )

    let siiStatus: string[] | null = null
    if (raw.siiStatus === null || raw.siiStatus === undefined) {
      siiStatus = null
    } else if (Array.isArray(raw.siiStatus)) {
      siiStatus = raw.siiStatus.map((entry) => String(entry))
    } else {
      throw new Error(`Formato inesperado en siiStatus: ${typeof raw.siiStatus}`)
    }

    const siiInProgress =
      typeof raw.siiInProgress === 'boolean'
        ? raw.siiInProgress
        : String(raw.siiInProgress ?? '').toLowerCase() === 'true' ||
          raw.siiInProgress === 1

    const record: NormalizedBsaleThirdPartyDocumentRecord = {
      company_id: companyId,
      bsale_document_id: bsaleDocumentId,
      bsale_href: normalizeOptionalString(raw.href),
      code_sii: codeSii as AllowedBsaleThirdPartyCodeSii,
      document_number: documentNumber,
      document_folio: documentFolio,
      client_code: clientCode,
      issuer_rut_normalized: issuerRutNormalized,
      client_activity: clientActivity,
      emission_timestamp: emissionInfo.timestamp,
      emission_date: emissionInfo.isoDate,
      sii_reception_timestamp: receptionInfo.timestamp,
      sii_reception_date: receptionInfo.isoTimestamp,
      book_type: bookType,
      tax_month: taxMonth,
      tax_year: taxYear,
      exempt_amount: parseNonNegativeNumber(raw.exemptAmount, 'exemptAmount'),
      net_amount: parseNonNegativeNumber(raw.netAmount, 'netAmount'),
      iva_rate: parseNonNegativeNumber(raw.ivaRate, 'ivaRate'),
      iva_amount: parseNonNegativeNumber(raw.ivaAmount, 'ivaAmount'),
      iva_out_of_time_amount: parseNonNegativeNumber(raw.ivaOutOfTime, 'ivaOutOfTime'),
      iva_not_recoverable_amount: parseNonNegativeNumber(
        raw.ivaNotRecoverable,
        'ivaNotRecoverable'
      ),
      iva_amount_withheld: parseNonNegativeNumber(
        raw.ivaAmountWithheld,
        'ivaAmountWithheld'
      ),
      fixed_asset_amount: parseNonNegativeNumber(raw.fixedAsset, 'fixedAsset'),
      commission_total_net_amount: parseSignedNumber(
        raw.commissionTotalNet,
        'commissionTotalNet'
      ),
      commission_total_exempt_amount: parseSignedNumber(
        raw.commissionTotalExempt,
        'commissionTotalExempt'
      ),
      commission_total_iva_amount: parseSignedNumber(
        raw.commissionTotalIva,
        'commissionTotalIva'
      ),
      specific_tax_code: normalizeOptionalString(raw.specificTaxCode),
      specific_tax_rate_raw: specificTaxRate.raw,
      specific_tax_rate: specificTaxRate.numeric,
      specific_tax_amount_raw: specificTaxAmount.raw,
      specific_tax_amount: specificTaxAmount.numeric,
      additional_tax_amount: parseOptionalNumber(
        raw.additionalTaxAmount,
        'additionalTaxAmount'
      ),
      total_amount: parseNonNegativeNumber(raw.totalAmount, 'totalAmount'),
      reported_sii: parseIntegerFlag(raw.reportedSii, 'reportedSii'),
      third_sii: parseIntegerFlag(raw.thirdSii, 'thirdSii'),
      canceled: parseIntegerFlag(raw.canceled, 'canceled'),
      add_book: parseIntegerFlag(raw.addBook, 'addBook'),
      docs_count: parseIntegerFlag(raw.docsCount, 'docsCount'),
      include_flag: parseIntegerFlag(raw.include, 'include'),
      sii_in_progress: siiInProgress,
      sii_status: siiStatus,
      liquidation_code: normalizeOptionalString(raw.liquidationCode),
      url_pdf: normalizeOptionalString(raw.urlPdf),
      url_xml: normalizeOptionalString(raw.urlXml),
      raw_json: { ...(raw as Record<string, unknown>) },
    }

    return {
      status: 'ELIGIBLE',
      record,
    }
  } catch (err) {
    return {
      status: 'INVALID',
      bsaleDocumentId,
      reason: err instanceof Error ? err.message : 'Error de validación del documento',
    }
  }
}

const defaultFetchBsaleThirdPartyPage: FetchBsaleThirdPartyPageFn = async ({
  companyId,
  year,
  limit,
  offset,
  signal,
}) => {
  const { baseUrl } = getBsaleConfigForCompany(companyId)
  const headers = getBsaleHeadersForCompany(companyId)
  const url = new URL(`${baseUrl}${BSALE_THIRD_PARTY_DOCUMENTS_PATH}`)
  url.searchParams.set('year', String(year))
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
    signal,
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Bsale API error ${response.status} (${response.statusText})${body ? `: ${body.slice(0, 200)}` : ''}`
    )
  }

  return (await response.json()) as BsaleResponse<BsaleThirdPartyDocumentRaw>
}

/**
 * Servicio manual, paginado e idempotente de sincronización de third_party_documents desde Bsale para Caylo.
 *
 * - Pagina por año tributario (>= 2026) y filtra estrictamente por fecha de emisión >= 2026-01-01.
 * - Evita duplicados por bsale_document_id dentro de la corrida y mediante UPSERT atómico en base de datos.
 * - Detecta respuestas incompletas o truncadas (inconsistencia de count, página vacía prematura o conteo menor al esperado).
 * - Registra errores sin eliminar documentos existentes.
 */
export async function syncBsaleThirdPartyDocumentsForCaylo(
  options?: SyncBsaleThirdPartyDocumentsOptions
): Promise<BsaleThirdPartyDocumentsSyncSummary> {
  const companyId = options?.companyId ?? CAYLO_COMPANY_ID
  if (companyId !== CAYLO_COMPANY_ID) {
    throw new Error(
      `La sincronización de third_party_documents está restringida exclusivamente a Caylo (${CAYLO_COMPANY_ID})`
    )
  }

  const cutoffEmissionDate =
    options?.cutoffEmissionDate ?? BSALE_THIRD_PARTY_DOCUMENTS_CUTOFF_DATE
  const years =
    options?.years && options.years.length > 0
      ? Array.from(new Set(options.years)).sort((a, b) => a - b)
      : [2026]

  for (const year of years) {
    if (!Number.isInteger(year) || year < 2026) {
      throw new Error(
        `Año tributario inválido para sincronización (${year}): solo se permiten años >= 2026`
      )
    }
  }

  const pageLimit = options?.pageLimit ?? BSALE_THIRD_PARTY_DOCUMENTS_PAGE_LIMIT
  if (!Number.isInteger(pageLimit) || pageLimit <= 0 || pageLimit > 50) {
    throw new Error(`pageLimit inválido (${pageLimit}): debe estar entre 1 y 50`)
  }

  const upsertBatchSize =
    options?.upsertBatchSize ?? BSALE_THIRD_PARTY_DOCUMENTS_UPSERT_BATCH_SIZE
  if (!Number.isInteger(upsertBatchSize) || upsertBatchSize <= 0) {
    throw new Error(`upsertBatchSize inválido (${upsertBatchSize})`)
  }

  const dryRun = options?.dryRun ?? false
  const syncedAt = options?.syncedAt ?? new Date().toISOString()
  const fetchPage = options?.fetchPage ?? defaultFetchBsaleThirdPartyPage
  const upsertBatch = options?.upsertBatch

  if (!dryRun && !upsertBatch) {
    throw new Error(
      'Se requiere upsertBatch cuando dryRun es false para persistir el espejo de forma idempotente'
    )
  }

  const seenBsaleIds = new Set<number>()
  const eligibleRecords: NormalizedBsaleThirdPartyDocumentRecord[] = []
  const errors: BsaleThirdPartySyncErrorEntry[] = []
  const byCodeSii: Record<AllowedBsaleThirdPartyCodeSii, number> = {
    '33': 0,
    '34': 0,
    '61': 0,
    '56': 0,
  }

  let pagesFetched = 0
  let totalReportedByBsale = 0
  let totalFetchedRaw = 0
  let duplicateIdsSkipped = 0
  let skippedBeforeCutoffCount = 0
  let skippedUnsupportedCodeSiiCount = 0
  let invalidCount = 0
  let withSiiStatusNullCount = 0
  let withUrlPdfCount = 0
  let withoutUrlPdfCount = 0
  let withUrlXmlCount = 0
  let withoutUrlXmlCount = 0
  let withSpecificTaxCount = 0
  let incompleteResponseDetected = false

  for (const year of years) {
    let offset = 0
    let expectedYearCount: number | null = null
    let fetchedForYear = 0

    while (expectedYearCount === null || offset < expectedYearCount) {
      let pageResponse: BsaleResponse<BsaleThirdPartyDocumentRaw>
      try {
        pageResponse = await fetchPage({
          companyId,
          year,
          limit: pageLimit,
          offset,
          signal: options?.signal,
        })
      } catch (err) {
        incompleteResponseDetected = true
        errors.push({
          phase: 'FETCH_PAGE',
          year,
          offset,
          message:
            err instanceof Error
              ? err.message
              : `Error al consultar página de Bsale (year=${year}, offset=${offset})`,
        })
        break
      }

      pagesFetched++

      if (
        !pageResponse ||
        typeof pageResponse.count !== 'number' ||
        !Number.isInteger(pageResponse.count) ||
        pageResponse.count < 0 ||
        !Array.isArray(pageResponse.items)
      ) {
        incompleteResponseDetected = true
        errors.push({
          phase: 'PAGINATION_INTEGRITY',
          year,
          offset,
          message: `Respuesta malformada de Bsale en year=${year}, offset=${offset}: falta count o items`,
        })
        break
      }

      if (expectedYearCount === null) {
        expectedYearCount = pageResponse.count
        totalReportedByBsale += expectedYearCount
      } else if (pageResponse.count !== expectedYearCount) {
        incompleteResponseDetected = true
        errors.push({
          phase: 'PAGINATION_INTEGRITY',
          year,
          offset,
          message: `El total reportado por Bsale cambió durante la paginación de year=${year}: esperado ${expectedYearCount}, recibido ${pageResponse.count}`,
        })
        break
      }

      const items = pageResponse.items
      totalFetchedRaw += items.length
      fetchedForYear += items.length

      if (expectedYearCount > 0 && items.length === 0) {
        incompleteResponseDetected = true
        errors.push({
          phase: 'PAGINATION_INTEGRITY',
          year,
          offset,
          message: `Página vacía prematura en year=${year}, offset=${offset}: recibidos ${fetchedForYear} de ${expectedYearCount}`,
        })
        break
      }

      for (const rawItem of items) {
        const rawId =
          rawItem && typeof rawItem === 'object'
            ? typeof rawItem.id === 'number'
              ? rawItem.id
              : Number(String(rawItem.id ?? '').trim())
            : NaN

        if (Number.isSafeInteger(rawId) && rawId > 0) {
          if (seenBsaleIds.has(rawId)) {
            duplicateIdsSkipped++
            continue
          }
          seenBsaleIds.add(rawId)
        }

        const outcome = normalizeBsaleThirdPartyDocument(rawItem, {
          companyId,
          cutoffEmissionDate,
        })

        if (outcome.status === 'SKIPPED_BEFORE_CUTOFF') {
          skippedBeforeCutoffCount++
          continue
        }

        if (outcome.status === 'SKIPPED_UNSUPPORTED_CODE_SII') {
          skippedUnsupportedCodeSiiCount++
          continue
        }

        if (outcome.status === 'INVALID') {
          invalidCount++
          errors.push({
            phase: 'NORMALIZE',
            year,
            offset,
            bsaleDocumentId: outcome.bsaleDocumentId,
            message: outcome.reason,
          })
          continue
        }

        const record = outcome.record
        eligibleRecords.push(record)
        byCodeSii[record.code_sii]++

        if (record.sii_status === null) {
          withSiiStatusNullCount++
        }
        if (record.url_pdf) {
          withUrlPdfCount++
        } else {
          withoutUrlPdfCount++
        }
        if (record.url_xml) {
          withUrlXmlCount++
        } else {
          withoutUrlXmlCount++
        }
        if (record.specific_tax_amount !== null && record.specific_tax_amount > 0) {
          withSpecificTaxCount++
        }
      }

      if (items.length < pageLimit) {
        if (fetchedForYear < expectedYearCount) {
          incompleteResponseDetected = true
          errors.push({
            phase: 'PAGINATION_INTEGRITY',
            year,
            offset,
            message: `Respuesta incompleta de Bsale en year=${year}: recibidos ${fetchedForYear} de ${expectedYearCount}`,
          })
        }
        break
      }

      offset += pageLimit
    }

    if (
      !incompleteResponseDetected &&
      expectedYearCount !== null &&
      fetchedForYear < expectedYearCount
    ) {
      incompleteResponseDetected = true
      errors.push({
        phase: 'PAGINATION_INTEGRITY',
        year,
        offset,
        message: `Respuesta incompleta de Bsale al finalizar year=${year}: recibidos ${fetchedForYear} de ${expectedYearCount}`,
      })
    }
  }

  let upsertedProcessedCount = 0
  let upsertedInsertedCount = 0
  let upsertedUpdatedCount = 0

  if (!dryRun && upsertBatch && eligibleRecords.length > 0) {
    for (let i = 0; i < eligibleRecords.length; i += upsertBatchSize) {
      const batch = eligibleRecords.slice(i, i + upsertBatchSize)
      try {
        const batchResult = await upsertBatch({
          companyId,
          documents: batch,
          syncedAt,
        })
        upsertedProcessedCount += batchResult.processed_count
        upsertedInsertedCount += batchResult.inserted_count
        upsertedUpdatedCount += batchResult.updated_count
      } catch (err) {
        errors.push({
          phase: 'UPSERT_BATCH',
          offset: i,
          message:
            err instanceof Error
              ? err.message
              : `Error al hacer UPSERT del lote [${i}..${i + batch.length - 1}]`,
        })
      }
    }
  }

  const eligibleInvoicesCount = byCodeSii['33'] + byCodeSii['34']
  const eligibleNotesCount = byCodeSii['61'] + byCodeSii['56']

  let status: BsaleThirdPartyDocumentsSyncSummary['status'] = 'SUCCESS'
  if (incompleteResponseDetected) {
    status = 'INCOMPLETE_RESPONSE'
  } else if (errors.length > 0) {
    status =
      !dryRun && upsertedProcessedCount === 0 && eligibleRecords.length > 0
        ? 'FAILED'
        : 'PARTIAL_ERROR'
  }

  return {
    companyId,
    cutoffEmissionDate,
    yearsQueried: years,
    dryRun,
    status,
    pagesFetched,
    totalReportedByBsale,
    totalFetchedRaw,
    uniqueDocumentsFetched: seenBsaleIds.size,
    duplicateIdsSkipped,
    skippedBeforeCutoffCount,
    skippedUnsupportedCodeSiiCount,
    invalidCount,
    eligibleCount: eligibleRecords.length,
    eligibleInvoicesCount,
    eligibleNotesCount,
    byCodeSii,
    withSiiStatusNullCount,
    withUrlPdfCount,
    withoutUrlPdfCount,
    withUrlXmlCount,
    withoutUrlXmlCount,
    withSpecificTaxCount,
    upsertedProcessedCount,
    upsertedInsertedCount,
    upsertedUpdatedCount,
    incompleteResponseDetected,
    errors,
    records: eligibleRecords,
  }
}

/**
 * Helper exclusivamente de servidor para invocar la RPC atómica
 * `integraciones.upsert_bsale_third_party_documents_sync`.
 *
 * Requiere un cliente Supabase de backend con `service_role` (nunca `anon` ni `authenticated`),
 * ya que la escritura del espejo tributario Bsale está revocada para usuarios del ERP.
 */
export function createSupabaseBsaleThirdPartyUpsertBatch(serviceRoleSupabaseClient: {
  schema: (schemaName: string) => {
    rpc: (
      fnName: string,
      args: Record<string, unknown>
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
  }
}): UpsertBsaleThirdPartyBatchFn {
  if (!serviceRoleSupabaseClient || typeof serviceRoleSupabaseClient.schema !== 'function') {
    throw new Error(
      'Se requiere un cliente Supabase de servidor (service_role) válido para persistir el espejo Bsale'
    )
  }

  return async ({ companyId, documents, syncedAt }) => {
    const { data, error } = await serviceRoleSupabaseClient
      .schema('integraciones')
      .rpc('upsert_bsale_third_party_documents_sync', {
        p_company_id: companyId,
        p_documents: documents,
        p_synced_at: syncedAt,
      })

    if (error) {
      throw new Error(
        `Error en RPC upsert_bsale_third_party_documents_sync: ${error.message}`
      )
    }

    const payload = (data ?? {}) as Record<string, unknown>
    return {
      processed_count: Number(payload.processed_count ?? 0),
      inserted_count: Number(payload.inserted_count ?? 0),
      updated_count: Number(payload.updated_count ?? 0),
      synced_at: typeof payload.synced_at === 'string' ? payload.synced_at : syncedAt,
    }
  }
}
