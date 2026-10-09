import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/app/actions/companies'
import type { FinanceReceivablesSource } from './types'

export type FinanceMonthlyAmount = {
  month: number
  amount: string | null
}

export type FinanceSalesNetResponse = {
  company_id: string
  year: number
  currency: 'CLP'
  source: string
  data_through: string | null
  has_information: boolean
  documents_count: number
  lines_count: number
  months: FinanceMonthlyAmount[]
  total_ytd: string
}

export type SalesFamily = {
  family_key: string
  family_name: string
  provider_key?: string | null
  provider_name?: string | null
  detail_name?: string
  months: Record<string, string>
  ytd: string
  line_count: number
}

export type SalesFamilyGroup = {
  group_key: string
  group_name: string
  months: Record<string, string>
  ytd: string
  line_count: number
  children: Array<SalesFamily & { detail_name: string }>
}

export type SalesFamilyMatrixResponse = {
  company_id: string
  year: number
  through_date: string | null
  families: SalesFamily[]
  groups: SalesFamilyGroup[]
  individuals: SalesFamily[]
  totals: {
    months: Record<string, string>
    ytd: string
  }
  unclassified: {
    line_count: number
    amount_ytd: string
  }
}

export type FinanceCogsMonthly = {
  month: number
  gross_cogs: string | null
  credit_note_reversal: string | null
  net_cogs: string | null
  observed_document_count: number | null
  zero_evidence_document_count: number | null
  resolved_document_count: number | null
  missing_document_count: number | null
  coverage_status: 'COMPLETE' | 'INCOMPLETE' | null
}

export type FinanceCogsYtd = {
  gross_cogs: string | null
  credit_note_reversal: string | null
  net_cogs: string | null
  observed_document_count: number | null
  zero_evidence_document_count: number | null
  resolved_document_count: number | null
  missing_document_count: number | null
  coverage_status: 'COMPLETE' | 'INCOMPLETE' | null
}

export type FinanceCogsResponse = {
  company_id: string
  year: number
  currency: 'CLP'
  source: string
  data_through: string | null
  has_information: boolean
  months: FinanceCogsMonthly[]
  ytd: FinanceCogsYtd
}

export type FinancePersonnelMonthly = {
  month: number
  status: 'AVAILABLE' | 'MISSING'
  formalEarnings: string | null
  employerContributions: string | null
  formalLaborCost: string | null
  recurringLaborCost: string | null
  indemnities: string | null
  workerCount: number | null
  offBook: string
  salariesOther: string
  totalPersonnel: string | null
}

export type FinancePersonnelTotal = {
  formalEarnings: string | null
  employerContributions: string | null
  formalLaborCost: string | null
  recurringLaborCost: string | null
  indemnities: string | null
  offBook: string
  salariesOther: string
  totalPersonnel: string | null
}

export type FinancePersonnelCoverage = {
  availableMonths: number[]
  missingMonths: number[]
  latestAvailableMonth: number | null
  coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'MISSING'
}

export type FinancePersonnelResponse = {
  companyId: string
  year: number
  currency: 'CLP'
  source: string
  months: FinancePersonnelMonthly[]
  coverage: FinancePersonnelCoverage
  ytd: FinancePersonnelCoverage & {
    status: 'COMPLETE' | 'INCOMPLETE' | 'MISSING'
    availableTotal: FinancePersonnelTotal
  }
}

export type FinanceExpensesMonthly = {
  month: number
  status: 'AVAILABLE' | 'MISSING'
  softwareSubscriptions: string | null
  officeConsumption: string | null
  vehicleOperating: string | null
  notaryServices: string | null
  bankFees: string | null
  insurance: string | null
  telecom: string | null
  externalServices: string | null
  otherExpenses: string | null
  operatingIdentifiedTotal: string | null
  financialInterest: string | null
  nonOperatingIdentifiedTotal: string | null
  otherIncome: string | null
}

export type FinanceExpensesTotals = {
  softwareSubscriptions: string | null
  officeConsumption: string | null
  vehicleOperating: string | null
  notaryServices: string | null
  bankFees: string | null
  insurance: string | null
  telecom: string | null
  externalServices: string | null
  otherExpenses: string | null
  operatingIdentifiedTotal: string | null
  financialInterest: string | null
  nonOperatingIdentifiedTotal: string | null
  otherIncome: string | null
}

export type FinanceExpensesCoverage = {
  availableMonths: number[]
  missingMonths: number[]
  latestAvailableMonth: number | null
  coverageStatus: 'COMPLETE' | 'INCOMPLETE' | 'MISSING'
}

export type FinanceExpensesResponse = {
  companyId: string
  year: number
  currency: 'CLP'
  source: string
  dataThrough: string | null
  months: FinanceExpensesMonthly[]
  coverage: FinanceExpensesCoverage
  ytd: FinanceExpensesCoverage & FinanceExpensesTotals & {
    status: 'COMPLETE' | 'INCOMPLETE' | 'MISSING'
  }
  pendingReviewCount: number
  pendingHistoricalAmount: string | null
  historicalCoverageNote: string
}

export type FinanceReceivablesResponse = {
  company_id: string
  year: number
  currency: 'CLP'
  source: string
  data_through: string | null
  effective_date: string | null
  has_information: boolean
  months: Array<{ month: number; receivable_amount: string | null; overdue_amount: string | null }>
  actual: {
    receivable_amount: string
    overdue_amount: string
    pending_documents: number
    source?: string
    snapshot_run_id?: string
    snapshot_at?: string
    snapshot_date?: string
    receivables_source?: FinanceReceivablesSource
    snapshot_status?: string
    clients_total?: number
    clients_success?: number
    clients_unqueryable?: number
    clients_error?: number
    coverage_percent?: number
    is_provisional?: boolean
  }
}

export type FinanceApiResult =
  | { ok: true; data: FinanceSalesNetResponse }
  | { ok: false; status: number; message: string }

export type FinanceCogsApiResult =
  | { ok: true; data: FinanceCogsResponse }
  | { ok: false; status: number; message: string }

export type FinancePersonnelApiResult =
  | { ok: true; data: FinancePersonnelResponse }
  | { ok: false; status: number; message: string }

export type FinanceExpensesApiResult =
  | { ok: true; data: FinanceExpensesResponse }
  | { ok: false; status: number; message: string }

export type FinanceReceivablesApiResult =
  | { ok: true; data: FinanceReceivablesResponse }
  | { ok: false; status: number; message: string }

export type FinanceReceivablesEvent = {
  type: 'PAYMENT' | 'CREDIT_NOTE'
  date: string | null
  amount: string
  payment_type: string | null
  operation: string | null
  reference: string | null
}

export type FinanceReceivablesAnalysis = {
  company_id: string
  year: number
  period: number
  period_start: string
  close_date: string
  currency: 'CLP'
  source: string
  snapshot_run_id?: string
  snapshot_at?: string
  snapshot_date?: string
  receivables_source?: FinanceReceivablesSource
  snapshot_status?: string
  clients_total?: number
  clients_success?: number
  clients_unqueryable?: number
  clients_error?: number
  coverage_percent?: number
  is_provisional?: boolean
  summary: {
    receivable_amount: string
    overdue_amount: string
    closing_receivable_amount: string
    closing_overdue_amount: string
    pending_documents: number
    clients: number
  }
  daily: Array<{ date: string; receivable_amount: string; overdue_amount: string; pending_documents: number }>
  documents: Array<{
    document_id: number
    emission_date: string
    folio: number | null
    document_type_name: string | null
    total_amount: string
    net_amount: string | null
    tax_amount: string | null
    expiration_date: string | null
    pending_amount: string
    client_id: number
    client_code: string | null
    client_name: string | null
    url_pdf: string | null
    overdue: boolean
    source_status?: string | null
    events: FinanceReceivablesEvent[]
  }>
}

export type FinanceReceivablesAnalysisApiResult =
  | { ok: true; data: FinanceReceivablesAnalysis }
  | { ok: false; status: number; message: string }

export type FinanceSalesNetDetailItem = {
  document_id: number
  date?: string
  emission_date: string
  document_type_id: number
  document_type: string
  document_type_name?: string
  folio: number
  net_amount?: string
  sign_for_sales?: 1 | -1
  contribution?: string
  signed_net_amount?: string
  line_count?: number
  office_id?: number | null
  office_name?: string | null
}

export type FinanceSalesNetDetailResponse = {
  company_id: string
  year: number
  scope: 'MONTH' | 'YTD'
  month: number | null
  data_through: string | null
  currency: 'CLP'
  family_key?: string
  family_name?: string
  source?: string
  documents_count: number
  document_count?: number
  total_net: string
  total?: string
  items: FinanceSalesNetDetailItem[]
}

export type FinanceSalesNetDetailApiResult =
  | { ok: true; data: FinanceSalesNetDetailResponse }
  | { ok: false; status: number; message: string }

export type FinanceSalesDocumentLine = {
  detail_id: number | null
  line_number: number | null
  variant_id: number | null
  product_id: number | null
  sku: string | null
  barcode: string | null
  product_name: string | null
  variant_name: string | null
  quantity: string | null
  signed_quantity: string | null
  unit_price: string
  net_amount: string
  signed_net_amount: string
  discount: string
  tax_amount: string
  signed_tax_amount: string
  total_amount: string
  signed_total_amount: string
  family_key: string | null
  family_name: string | null
  provider_key: string | null
  provider_name: string | null
  matches_selection: boolean
}

export type FinanceSalesDocumentLinesResponse = {
  document: {
    document_id: number
    folio: number | null
    date: string | null
    document_type_id: number | null
    document_type: string
    office_id: number | null
    office_name: string | null
    client_id: number | null
    client_name: string | null
    client_code: string | null
    net_amount: string
    tax_amount: string
    total_amount: string
    exempt_amount: string
    sign_for_sales: 1 | -1 | 0
  }
  selection: {
    provider_key: string | null
    family_key: string | null
  }
  lines: FinanceSalesDocumentLine[]
}

export type FinanceSalesDocumentLinesApiResult =
  | { ok: true; data: FinanceSalesDocumentLinesResponse }
  | { ok: false; status: number; message: string }

export type FinanceSalesFamilyApiResult =
  | { ok: true; data: SalesFamilyMatrixResponse }
  | { ok: false; status: number; message: string }

async function getFinanceApiResponse(path: string): Promise<Response> {
  const baseUrl = process.env.FINANCE_API_BASE_URL?.trim()
  if (!baseUrl) throw new Error('FINANCE_API_BASE_URL no está configurada.')

  const supabase = await createClient()
  const { data: sessionData } = await supabase.auth.getSession()
  const accessToken = sessionData.session?.access_token
  const companyId = await getActiveCompanyId()

  if (!accessToken || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')

  return fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Company-Id': companyId,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
}

async function readFinanceApiError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: string }
    if (body.detail) return body.detail
  } catch {
    // Keep the fallback when the API does not return JSON.
  }
  return fallback
}

function financeApiFailure(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.includes('no está configurada')) {
    return { ok: false as const, status: 503, message: error.message }
  }
  if (error instanceof Error && error.message.includes('sesión o la empresa')) {
    return { ok: false as const, status: 401, message: error.message }
  }
  return { ok: false as const, status: 503, message: fallback }
}

export async function getFinanceSalesNet(year: number): Promise<FinanceApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/sales-net?year=${year}`)

    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar las ventas netas.') }
    }

    return { ok: true, data: await response.json() as FinanceSalesNetResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceSalesNetByFamily(year: number): Promise<FinanceSalesFamilyApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/sales-net/by-family?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar las familias de ventas.') }
    }
    const data = await response.json() as SalesFamilyMatrixResponse
    return { ok: true, data }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceCogs(year: number): Promise<FinanceCogsApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/cogs?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudo cargar el costo de ventas.') }
    }
    return { ok: true, data: await response.json() as FinanceCogsResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinancePersonnel(year: number): Promise<FinancePersonnelApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/personnel?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar los gastos de personal.') }
    }
    return { ok: true, data: await response.json() as FinancePersonnelResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceExpenses(year: number): Promise<FinanceExpensesApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/expenses?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar los gastos identificados.') }
    }
    return { ok: true, data: await response.json() as FinanceExpensesResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceReceivables(year: number): Promise<FinanceReceivablesApiResult> {
  try {
    const response = await getFinanceApiResponse(`/financial/income-statement/receivables?year=${year}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudo cargar la posición de cobranza.') }
    }
    return { ok: true, data: await response.json() as FinanceReceivablesResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceReceivablesAnalysis(year: number, period: number): Promise<FinanceReceivablesAnalysisApiResult> {
  try {
    const query = new URLSearchParams({ year: String(year), period: String(period) })
    const response = await getFinanceApiResponse(`/financial/income-statement/receivables/analysis?${query.toString()}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudo cargar el análisis de cobranza.') }
    }
    return { ok: true, data: await response.json() as FinanceReceivablesAnalysis }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceSalesNetDetail(
  year: number,
  month?: number,
  familyKey?: string,
  page = 1,
  pageSize = 100,
): Promise<FinanceSalesNetDetailApiResult> {
  try {
    const query = new URLSearchParams({ year: String(year) })
    if (month !== undefined) query.set('month', String(month))
    if (familyKey !== undefined) query.set('family_key', familyKey)
    if (familyKey !== undefined) {
      query.set('page', String(page))
      query.set('page_size', String(pageSize))
    }
    const response = await getFinanceApiResponse(`/financial/income-statement/sales-net/detail?${query.toString()}`)
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudo cargar el detalle de ventas netas.') }
    }
    return { ok: true, data: await response.json() as FinanceSalesNetDetailResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}

export async function getFinanceSalesDocumentLines(
  year: number,
  documentId: number,
  providerKey?: string,
  familyKey?: string,
): Promise<FinanceSalesDocumentLinesApiResult> {
  try {
    const query = new URLSearchParams({ year: String(year) })
    if (providerKey !== undefined) query.set('provider_key', providerKey)
    if (familyKey !== undefined) query.set('family_key', familyKey)
    const response = await getFinanceApiResponse(
      `/financial/income-statement/sales-net/document/${documentId}/lines?${query.toString()}`,
    )
    if (!response.ok) {
      return { ok: false, status: response.status, message: await readFinanceApiError(response, 'No se pudieron cargar las líneas del documento.') }
    }
    return { ok: true, data: await response.json() as FinanceSalesDocumentLinesResponse }
  } catch (error) {
    return financeApiFailure(error, 'Finance API no está disponible.')
  }
}
