import type { SupabaseClient } from '@supabase/supabase-js'

export const BSALE_UNPAID_DOCUMENTS_SOURCE = 'BSALE_UNPAID_DOCUMENTS' as const

type SnapshotStatus = 'OVERDUE' | 'UPCOMING'
type ClientResult = 'SUCCESS' | 'UNPAID_DOCUMENTS_CLIENT_INVALID' | 'HTTP_ERROR'

export interface UnpaidDocument {
  id?: number | string | null
  number?: number | string | null
  totalAmount?: number | string | null
  totalAmountOwed?: number | string | null
  expirationDate?: number | string | null
  [key: string]: unknown
}

export interface UnpaidDocumentsPayload {
  overdue_documents?: UnpaidDocument[]
  upcoming_documents?: UnpaidDocument[]
  [key: string]: unknown
}

interface LocalClient {
  bsale_client_id: number
  raw_payload?: Record<string, unknown> | null
}

interface LocalDocument {
  bsale_id: number
  number?: number | null
  emission_date?: string | null
  total_amount?: number | string | null
  raw_json?: Record<string, unknown> | null
}

export interface SnapshotDocumentRow {
  run_id: string
  company_id: string
  snapshot_at: string
  snapshot_date: string
  bsale_document_id: number
  folio: number | null
  client_id: number
  emission_date: string | null
  expiration_date: string | null
  total_amount: number | string | null
  total_amount_owed: number
  status: SnapshotStatus
  source: typeof BSALE_UNPAID_DOCUMENTS_SOURCE
  raw_json: UnpaidDocument
}

export interface SnapshotClientRow {
  run_id: string
  company_id: string
  client_id: number
  client_state: number | null
  commercially_blocked: boolean | null
  result: ClientResult
  http_status: number | null
  error_code: string | null
  error_message: string | null
  documents_returned: number
  raw_response: UnpaidDocumentsPayload | null
}

export interface SnapshotRunResult {
  runId: string
  client: SnapshotClientRow
  documents: SnapshotDocumentRow[]
  totalAmountOwed: number
  status: 'COMPLETED' | 'PARTIAL'
}

export interface SnapshotBatchResult {
  runId: string
  clients: SnapshotClientRow[]
  documents: SnapshotDocumentRow[]
  totalAmountOwed: number
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL'
  remainingClientIds: number[]
  skippedClientIds: number[]
}

export function selectPendingClientIds(clientIds: number[], processedClientIds: number[], limit: number): number[] {
  const processed = new Set(processedClientIds)
  return [...new Set(clientIds)]
    .filter(clientId => Number.isFinite(clientId) && !processed.has(clientId))
    .sort((left, right) => left - right)
    .slice(0, Math.min(Math.max(limit, 0), 20))
}

export function snapshotCoveragePercent(processedClients: number, clientsTotal: number): number {
  if (clientsTotal <= 0) return 100
  return Math.round((processedClients / clientsTotal) * 10000) / 100
}

export function snapshotRunStatus(clientsTotal: number, processedClients: number, clientsError: number) {
  if (processedClients < clientsTotal) return 'RUNNING' as const
  return clientsError > 0 ? 'PARTIAL' as const : 'COMPLETED' as const
}

export async function collectPagedRows<T>(
  fetchPage: (offset: number, pageSize: number) => Promise<T[]>,
  pageSize = 1000,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize debe ser un entero positivo.')
  const rows: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, pageSize)
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export type SnapshotFetchJson = (path: string) => Promise<UnpaidDocumentsPayload>

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function epochDate(value: unknown): string | null {
  const epoch = numberOrNull(value)
  return epoch === null ? null : new Date(epoch * 1000).toISOString().slice(0, 10)
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

export function localSnapshotDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(now)
}

export function resolveClientState(client: LocalClient) {
  return {
    clientState: numberOrNull(client.raw_payload?.state),
    commerciallyBlocked: booleanOrNull(client.raw_payload?.commerciallyBlocked),
  }
}

export function mapUnpaidDocuments(
  payload: UnpaidDocumentsPayload,
  runId: string,
  companyId: string,
  clientId: number,
  snapshotAt: string,
  snapshotDate: string,
  localDocuments: LocalDocument[],
): SnapshotDocumentRow[] {
  const localById = new Map(localDocuments.map(document => [Number(document.bsale_id), document]))
  const rows: SnapshotDocumentRow[] = []
  for (const [status, documents] of [
    ['OVERDUE', payload.overdue_documents || []],
    ['UPCOMING', payload.upcoming_documents || []],
  ] as const) {
    for (const document of documents) {
      const bsaleDocumentId = numberOrNull(document.id)
      const owed = numberOrNull(document.totalAmountOwed)
      if (bsaleDocumentId === null || owed === null) {
        throw new Error(`Documento unpaid invalido para cliente ${clientId}`)
      }
      const local = localById.get(bsaleDocumentId)
      const rawLocal = local?.raw_json || {}
      rows.push({
        run_id: runId,
        company_id: companyId,
        snapshot_at: snapshotAt,
        snapshot_date: snapshotDate,
        bsale_document_id: bsaleDocumentId,
        folio: numberOrNull(document.number ?? local?.number),
        client_id: clientId,
        emission_date: local?.emission_date || null,
        expiration_date: epochDate(document.expirationDate ?? rawLocal.expirationDate),
        total_amount: local?.total_amount ?? document.totalAmount ?? null,
        total_amount_owed: owed,
        status,
        source: BSALE_UNPAID_DOCUMENTS_SOURCE,
        raw_json: document,
      })
    }
  }
  return rows
}

export function classifySnapshotError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const statusMatch = message.match(/Bsale HTTP (\d+)/)
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null
  const invalidClient = httpStatus === 400 && /invalid client code or id/i.test(message)
  return {
    httpStatus,
    result: invalidClient ? 'UNPAID_DOCUMENTS_CLIENT_INVALID' as const : 'HTTP_ERROR' as const,
    errorCode: invalidClient ? 'UNPAID_DOCUMENTS_CLIENT_INVALID' : statusMatch ? `BSALE_HTTP_${statusMatch[1]}` : 'SNAPSHOT_CLIENT_ERROR',
    errorMessage: message.slice(0, 500),
  }
}

interface SnapshotContext {
  db: SupabaseClient<any, any, any>
  companyId: string
  fetchJson: SnapshotFetchJson
  runId: string
  snapshotAt: string
  snapshotDate: string
}

async function createRun(
  db: SupabaseClient<any, any, any>,
  companyId: string,
  clientCount: number,
  now: Date,
) {
  const { data: run, error: runError } = await db.schema('integraciones')
    .from('bsale_receivable_snapshot_runs')
    .insert({
      company_id: companyId,
      snapshot_at: now.toISOString(),
      snapshot_date: localSnapshotDate(now),
      source: BSALE_UNPAID_DOCUMENTS_SOURCE,
      status: 'RUNNING',
      clients_total: clientCount,
    })
    .select('id')
    .single()
  if (runError) throw runError
  return { runId: String(run.id), snapshotAt: now.toISOString(), snapshotDate: localSnapshotDate(now) }
}

async function processClient(context: SnapshotContext, clientId: number): Promise<SnapshotRunResult> {
  const { db, companyId, fetchJson, runId, snapshotAt, snapshotDate } = context

  const { data: client, error: clientError } = await db.schema('integraciones')
    .from('bsale_clients')
    .select('bsale_client_id, raw_payload')
    .eq('company_id', companyId)
    .eq('bsale_client_id', clientId)
    .maybeSingle()
  if (clientError) throw clientError

  const { clientState, commerciallyBlocked } = resolveClientState(client || {
    bsale_client_id: clientId,
    raw_payload: null,
  })

  try {
    const payload = await fetchJson(`/clients/unpaid_documents.json?clientid=${clientId}`)
    const documentIds = [
      ...(payload.overdue_documents || []),
      ...(payload.upcoming_documents || []),
    ].map(document => numberOrNull(document.id)).filter((id): id is number => id !== null)
    let localDocuments: LocalDocument[] = []
    if (documentIds.length) {
      const localResult = await db.schema('integraciones').from('bsale_documents')
        .select('bsale_id, number, emission_date, total_amount, raw_json')
        .eq('company_id', companyId)
        .in('bsale_id', documentIds)
      if (localResult.error) throw localResult.error
      localDocuments = localResult.data || []
    }
    const documents = mapUnpaidDocuments(payload, runId, companyId, clientId, snapshotAt, snapshotDate, localDocuments)
    if (documents.length) {
      const documentResult = await db.schema('integraciones').from('bsale_receivable_snapshot_documents')
        .insert(documents)
      if (documentResult.error) throw documentResult.error
    }
    const totalAmountOwed = documents.reduce((sum, document) => sum + document.total_amount_owed, 0)
    const clientRow: SnapshotClientRow = {
      run_id: runId,
      company_id: companyId,
      client_id: clientId,
      client_state: clientState,
      commercially_blocked: commerciallyBlocked,
      result: 'SUCCESS',
      http_status: 200,
      error_code: null,
      error_message: null,
      documents_returned: documents.length,
      raw_response: payload,
    }
    await persistClientResult(db, clientRow)
    return { runId, client: clientRow, documents, totalAmountOwed, status: 'COMPLETED' }
  } catch (error) {
    const details = classifySnapshotError(error)
    const clientRow: SnapshotClientRow = {
      run_id: runId,
      company_id: companyId,
      client_id: clientId,
      client_state: clientState,
      commercially_blocked: commerciallyBlocked,
      result: details.result,
      http_status: details.httpStatus,
      error_code: details.errorCode,
      error_message: details.errorMessage,
      documents_returned: 0,
      raw_response: null,
    }
    await persistClientResult(db, clientRow)
    return {
      runId,
      client: clientRow,
      documents: [],
      totalAmountOwed: 0,
      status: details.result === 'UNPAID_DOCUMENTS_CLIENT_INVALID' ? 'COMPLETED' : 'PARTIAL',
    }
  }
}

export async function snapshotReceivablesForClient({
  db,
  companyId,
  clientId,
  fetchJson,
  now = new Date(),
}: {
  db: SupabaseClient<any, any, any>
  companyId: string
  clientId: number
  fetchJson: SnapshotFetchJson
  now?: Date
}): Promise<SnapshotRunResult> {
  const run = await createRun(db, companyId, 1, now)
  const result = await processClient({ db, companyId, fetchJson, ...run }, clientId)
  await finishRun(db, run.runId, {
    status: result.status,
    clientsSuccess: result.client.result === 'SUCCESS' ? 1 : 0,
    clientsUnqueryable: result.client.result === 'UNPAID_DOCUMENTS_CLIENT_INVALID' ? 1 : 0,
    clientsError: result.client.result === 'HTTP_ERROR' ? 1 : 0,
    documentsTotal: result.documents.length,
    totalAmountOwed: result.totalAmountOwed,
    coveragePercent: result.client.result === 'SUCCESS' ? 100 : 0,
  })
  return result
}

export async function snapshotReceivablesForClients({
  db,
  companyId,
  clientIds,
  fetchJson,
  now = new Date(),
}: {
  db: SupabaseClient<any, any, any>
  companyId: string
  clientIds: number[]
  fetchJson: SnapshotFetchJson
  now?: Date
}): Promise<SnapshotBatchResult> {
  const uniqueClientIds = [...new Set(clientIds)]
  const run = await createRun(db, companyId, uniqueClientIds.length, now)
  const context = { db, companyId, fetchJson, ...run }
  const results: SnapshotRunResult[] = []
  for (const clientId of uniqueClientIds) {
    results.push(await processClient(context, clientId))
  }
  const clients = results.map(result => result.client)
  const documents = results.flatMap(result => result.documents)
  const clientsSuccess = clients.filter(client => client.result === 'SUCCESS').length
  const clientsUnqueryable = clients.filter(client => client.result === 'UNPAID_DOCUMENTS_CLIENT_INVALID').length
  const clientsError = clients.filter(client => client.result === 'HTTP_ERROR').length
  await finishRun(db, run.runId, {
    status: clientsError > 0 ? 'PARTIAL' : 'COMPLETED',
    clientsSuccess,
    clientsUnqueryable,
    clientsError,
    documentsTotal: documents.length,
    totalAmountOwed: documents.reduce((sum, document) => sum + document.total_amount_owed, 0),
    coveragePercent: clientsSuccess / (uniqueClientIds.length - clientsUnqueryable) * 100,
  })
  return {
    runId: run.runId,
    clients,
    documents,
    totalAmountOwed: documents.reduce((sum, document) => sum + document.total_amount_owed, 0),
    status: clientsError > 0 ? 'PARTIAL' : 'COMPLETED',
    remainingClientIds: [],
    skippedClientIds: [],
  }
}

export async function snapshotReceivablesBatch({
  db,
  companyId,
  clientIds,
  runId,
  limit,
  fetchJson,
  now = new Date(),
}: {
  db: SupabaseClient<any, any, any>
  companyId: string
  clientIds: number[]
  runId?: string
  limit: number
  fetchJson: SnapshotFetchJson
  now?: Date
}): Promise<SnapshotBatchResult> {
  const uniqueClientIds = [...new Set(clientIds)].filter(Number.isFinite).sort((left, right) => left - right)
  if (!uniqueClientIds.length) throw new Error('El universo CxC no contiene clientes candidatos.')

  let run: {
    runId: string
    snapshotAt: string
    snapshotDate: string
    clientsTotal: number
    clientsSuccess: number
    clientsUnqueryable: number
    clientsError: number
    documentsTotal: number
    totalAmountOwed: number
  }
  if (runId) {
    const { data, error } = await db.schema('integraciones')
      .from('bsale_receivable_snapshot_runs')
      .select('id, company_id, snapshot_at, snapshot_date, status, clients_total, clients_success, clients_unqueryable, clients_error, documents_total, total_amount_owed')
      .eq('id', runId)
      .single()
    if (error) throw error
    if (data.company_id !== companyId) throw new Error('El run_id pertenece a otra compañía.')
    if (data.status !== 'RUNNING') throw new Error(`El run_id no está RUNNING: ${data.status}`)
    if (Number(data.clients_total) !== uniqueClientIds.length) {
      throw new Error('El universo actual no coincide con clients_total del run existente.')
    }
    run = {
      runId: String(data.id),
      snapshotAt: String(data.snapshot_at),
      snapshotDate: String(data.snapshot_date),
      clientsTotal: Number(data.clients_total),
      clientsSuccess: Number(data.clients_success || 0),
      clientsUnqueryable: Number(data.clients_unqueryable || 0),
      clientsError: Number(data.clients_error || 0),
      documentsTotal: Number(data.documents_total || 0),
      totalAmountOwed: Number(data.total_amount_owed || 0),
    }
  } else {
    const created = await createRun(db, companyId, uniqueClientIds.length, now)
    run = {
      ...created,
      clientsTotal: uniqueClientIds.length,
      clientsSuccess: 0,
      clientsUnqueryable: 0,
      clientsError: 0,
      documentsTotal: 0,
      totalAmountOwed: 0,
    }
  }

  const { data: processedRows, error: processedError } = await db.schema('integraciones')
    .from('bsale_receivable_snapshot_clients')
    .select('client_id')
    .eq('run_id', run.runId)
  if (processedError) throw processedError
  const processedClientIds = (processedRows || []).map(row => Number(row.client_id))
  const batchClientIds = selectPendingClientIds(uniqueClientIds, processedClientIds, limit)
  const skippedClientIds = uniqueClientIds.filter(clientId => processedClientIds.includes(clientId))
  const context = { db, companyId, fetchJson, runId: run.runId, snapshotAt: run.snapshotAt, snapshotDate: run.snapshotDate }
  const results: SnapshotRunResult[] = []
  for (const clientId of batchClientIds) results.push(await processClient(context, clientId))

  const clients = results.map(result => result.client)
  const documents = results.flatMap(result => result.documents)
  const clientsSuccess = clients.filter(client => client.result === 'SUCCESS').length
  const clientsUnqueryable = clients.filter(client => client.result === 'UNPAID_DOCUMENTS_CLIENT_INVALID').length
  const clientsError = clients.filter(client => client.result === 'HTTP_ERROR').length
  const processedClients = processedClientIds.length + clients.length
  const status = snapshotRunStatus(run.clientsTotal, processedClients, run.clientsError + clientsError)
  await finishRun(db, run.runId, {
    status,
    clientsSuccess: run.clientsSuccess + clientsSuccess,
    clientsUnqueryable: run.clientsUnqueryable + clientsUnqueryable,
    clientsError: run.clientsError + clientsError,
    documentsTotal: run.documentsTotal + documents.length,
    totalAmountOwed: run.totalAmountOwed + documents.reduce((sum, document) => sum + document.total_amount_owed, 0),
    coveragePercent: snapshotCoveragePercent(processedClients, run.clientsTotal),
    completedAt: status === 'RUNNING' ? null : new Date().toISOString(),
  })

  const processedAfterBatch = new Set([...processedClientIds, ...batchClientIds])
  return {
    runId: run.runId,
    clients,
    documents,
    totalAmountOwed: documents.reduce((sum, document) => sum + document.total_amount_owed, 0),
    status,
    remainingClientIds: uniqueClientIds.filter(clientId => !processedAfterBatch.has(clientId)),
    skippedClientIds,
  }
}

async function persistClientResult(db: SupabaseClient<any, any, any>, row: SnapshotClientRow) {
  const result = await db.schema('integraciones').from('bsale_receivable_snapshot_clients').insert(row)
  if (result.error) throw result.error
}

async function finishRun(
  db: SupabaseClient<any, any, any>,
  runId: string,
  values: {
    status: 'RUNNING' | 'COMPLETED' | 'PARTIAL'
    clientsSuccess?: number
    clientsUnqueryable?: number
    clientsError?: number
    documentsTotal?: number
    totalAmountOwed?: number
    coveragePercent?: number
    completedAt?: string | null
  },
) {
  const result = await db.schema('integraciones').from('bsale_receivable_snapshot_runs')
    .update({
      status: values.status,
      clients_success: values.clientsSuccess ?? 0,
      clients_unqueryable: values.clientsUnqueryable ?? 0,
      clients_error: values.clientsError ?? 0,
      documents_total: values.documentsTotal ?? 0,
      total_amount_owed: values.totalAmountOwed ?? 0,
      coverage_percent: values.coveragePercent ?? null,
      completed_at: values.completedAt === undefined ? new Date().toISOString() : values.completedAt,
    })
    .eq('id', runId)
  if (result.error) throw result.error
}
