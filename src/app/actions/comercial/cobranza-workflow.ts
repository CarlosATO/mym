'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { calendarDateToUnixSeconds, createCollectionPaymentGateway, dedupeCollectionPaymentApplications, findUnpaidDocument, flattenUnpaidDocuments, totalUnpaid, type CollectionPayment, type CollectionPaymentGateway } from '@/lib/bsale/collection-payments'

const db = () => createAdminClient().schema('comercial')

export type CollectionStage = 'TO_MANAGE' | 'IN_PROGRESS' | 'PAYMENT_COMMITMENT' | 'FOLLOW_UP' | 'CLOSED'
export type CollectionInteractionType = 'NOTE' | 'CALL' | 'MESSAGE' | 'EMAIL'

export type CollectionHistoryEvent = {
  id: string
  eventType: string
  createdAt: string
  actorName: string
  fromStage: CollectionStage | null
  toStage: CollectionStage | null
  note: string | null
  commitmentDate: string | null
  commitmentAmount: number | null
  nextActionAt: string | null
  metadata: Record<string, unknown>
}

export type CollectionHistoryResult = {
  events: CollectionHistoryEvent[]
  hasMore: boolean
}

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  return { user, companyId }
}

async function canRegisterPayment() {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission_code: 'analisis_comercial.cobranza.register_payment',
  })
  return !error && data === true
}

export async function getCollectionWorkflow(clientIds: number[]) {
  const { companyId } = await context()
  if (clientIds.length === 0) return []
  const { data, error } = await db().from('collection_customer_workflow')
    .select('client_id,stage,next_action_at,commitment_at,commitment_amount,assigned_to,last_contact_at,updated_at')
    .eq('company_id', companyId).in('client_id', clientIds)
  if (error) throw new Error(error.message)
  return data ?? []
}

export type CollectionPaymentOverlay = {
  clientId: number
  documentId: number
  pendingAmount: number
  confirmedAt: string
  paymentId: number
  source: 'COLLECTION_PAYMENT'
}

export async function getCollectionPaymentOverlay(clientIds: number[], snapshotAt?: string | null): Promise<CollectionPaymentOverlay[]> {
  const { companyId } = await context()
  if (clientIds.length === 0) return []
  let attemptsQuery = db().from('collection_payment_attempts')
    .select('client_id,bsale_document_id,post_balance,confirmed_at,bsale_payment_id')
    .eq('company_id', companyId).eq('status', 'CONFIRMED').in('client_id', clientIds)
    .not('confirmed_at', 'is', null).not('bsale_payment_id', 'is', null)
    .order('confirmed_at', { ascending: false })
  if (snapshotAt) {
    attemptsQuery = attemptsQuery.gt('confirmed_at', snapshotAt)
  }
  const { data: attempts, error: attemptsError } = await attemptsQuery
  if (attemptsError) throw new Error(attemptsError.message)
  const rows: CollectionPaymentOverlay[] = (attempts ?? []).map(row => ({ clientId: Number(row.client_id), documentId: Number(row.bsale_document_id), pendingAmount: Math.max(0, Number(row.post_balance ?? 0)), confirmedAt: String(row.confirmed_at), paymentId: Number(row.bsale_payment_id), source: 'COLLECTION_PAYMENT' as const }))
  const seen = new Set<number>()
  return rows.filter(row => {
    if (seen.has(row.documentId)) return false
    seen.add(row.documentId)
    return true
  })
}

export async function getCollectionCustomerHistory(clientId: number, requestedLimit = 20): Promise<CollectionHistoryResult> {
  const { companyId } = await context()
  const limit = Math.min(Math.max(requestedLimit, 1), 100)
  const { data, error } = await db().from('collection_customer_events')
    .select('id,event_type,body,metadata,created_by,created_at')
    .eq('company_id', companyId).eq('client_id', clientId)
    .order('created_at', { ascending: false }).limit(limit + 1)
  if (error) throw new Error(error.message)
  const rows = data ?? []
  const hasMore = rows.length > limit
  const visibleRows = rows.slice(0, limit)
  const userIds = Array.from(new Set(visibleRows.map(row => row.created_by).filter(Boolean))) as string[]
  const users = userIds.length > 0
    ? await createAdminClient().schema('portal').from('users').select('id,nombre,apellido,email').in('id', userIds)
    : { data: [], error: null }
  const actorNames = new Map<string, string>((users.data ?? []).map(user => {
    const name = [user.nombre, user.apellido].filter(Boolean).join(' ').trim() || user.email || 'Usuario'
    return [user.id, name]
  }))
  const stageOf = (row: { metadata?: unknown }) => {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
    const stage = metadata.stage
    return typeof stage === 'string' && ['TO_MANAGE', 'IN_PROGRESS', 'PAYMENT_COMMITMENT', 'FOLLOW_UP', 'CLOSED'].includes(stage)
      ? stage as CollectionStage
      : null
  }
  const noteOf = (eventType: string, body: string, metadata: Record<string, unknown>) => {
    if (!body || eventType === 'PAYMENT_CLOSED' || eventType === 'REOPENED_BY_NEW_DEBT') return null
    if (eventType === 'STAGE_CHANGED' && body === `Etapa actualizada a ${String(metadata.stage ?? '')}.`) return null
    if (eventType === 'COMMITMENT' && body === 'Compromiso de pago registrado.') return null
    if (eventType === 'FOLLOW_UP' && body === 'Seguimiento programado.') return null
    return body
  }
  const events = visibleRows.map((row, index) => {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {}
    const toStage = stageOf(row)
    const previousStage = visibleRows.slice(index + 1).map(stageOf).find(Boolean) ?? null
    const commitmentAmount = Number(metadata.commitmentAmount ?? metadata.commitment_amount)
    return {
      id: String(row.id),
      eventType: String(row.event_type),
      createdAt: row.created_at,
      actorName: row.created_by ? actorNames.get(row.created_by) ?? 'Usuario' : 'Usuario',
      fromStage: toStage && String(row.event_type) === 'STAGE_CHANGED' ? previousStage : null,
      toStage,
      note: noteOf(String(row.event_type), String(row.body ?? '').trim(), metadata),
      commitmentDate: typeof (metadata.commitmentAt ?? metadata.commitment_at) === 'string' ? String(metadata.commitmentAt ?? metadata.commitment_at) : null,
      commitmentAmount: Number.isFinite(commitmentAmount) && commitmentAmount > 0 ? commitmentAmount : null,
      nextActionAt: typeof (metadata.nextActionAt ?? metadata.next_action_at) === 'string' ? String(metadata.nextActionAt ?? metadata.next_action_at) : null,
      metadata,
    }
  })
  return { events, hasMore }
}

export async function updateCollectionStage(input: {
  clientId: number
  stage: CollectionStage
  note?: string
  commitmentAt?: string
  commitmentAmount?: number
  nextActionAt?: string
}) {
  const { companyId, user } = await context()
  if (input.stage === 'CLOSED') throw new Error('CLOSED sólo puede establecerse después de reconciliar saldo Bsale cero.')
  const now = new Date().toISOString()
  const { error } = await db().from('collection_customer_workflow').upsert({
    company_id: companyId,
    client_id: input.clientId,
    stage: input.stage,
    commitment_at: input.commitmentAt ?? null,
    commitment_amount: input.commitmentAmount ?? null,
    next_action_at: input.nextActionAt ?? null,
    last_contact_at: now,
    updated_at: now,
  }, { onConflict: 'company_id,client_id' })
  if (error) throw new Error(error.message)

  const eventBody = input.note?.trim()
    || (input.stage === 'PAYMENT_COMMITMENT' ? 'Compromiso de pago registrado.' : input.stage === 'FOLLOW_UP' ? 'Seguimiento programado.' : `Etapa actualizada a ${input.stage}.`)
  const event = await db().from('collection_customer_events').insert({
      company_id: companyId,
      client_id: input.clientId,
      event_type: input.stage === 'PAYMENT_COMMITMENT' ? 'COMMITMENT' : 'STAGE_CHANGED',
      body: eventBody,
      metadata: {
        stage: input.stage,
        commitmentAt: input.commitmentAt ?? null,
        commitmentAmount: input.commitmentAmount ?? null,
        nextActionAt: input.nextActionAt ?? null,
      },
      created_by: user.id,
    })
  if (event.error) throw new Error(event.error.message)
  return { ok: true as const }
}

export async function registerCollectionInteraction(input: {
  clientId: number
  type: CollectionInteractionType
  body: string
}) {
  const { companyId, user } = await context()
  if (!Number.isInteger(input.clientId) || input.clientId <= 0) throw new Error('Cliente de cobranza inválido.')
  if (!['NOTE', 'CALL', 'MESSAGE', 'EMAIL'].includes(input.type)) throw new Error('Tipo de gestión inválido.')
  const body = input.body.trim()
  if (!body) throw new Error('La descripción de la gestión es obligatoria.')
  if (body.length > 2000) throw new Error('La descripción no puede superar los 2000 caracteres.')
  const { error } = await db().from('collection_customer_events').insert({
    company_id: companyId,
    client_id: input.clientId,
    event_type: input.type,
    body,
    metadata: {},
    created_by: user.id,
  })
  if (error) throw new Error(error.message)
  return { ok: true as const }
}

type BsaleUnpaidDocument = { id?: number; number?: number; totalAmount?: number; totalAmountOwed?: number }
type BsaleUnpaidDocuments = { overdue_documents?: BsaleUnpaidDocument[]; upcoming_documents?: BsaleUnpaidDocument[] }
type BsalePaymentType = {
  id: number
  name: string
  active?: boolean
  state?: number
  dynamicAttributes?: unknown
  dynamic_attributes?: unknown
}

type CollectionPaymentType = {
  id: number
  label: string
  name: string
  dynamicAttributes: unknown
}

function isBsalePaymentTypeActive(type: BsalePaymentType) {
  return type.active !== false && type.state !== 1
}

async function loadCollectionPaymentTypes(companyId: string) {
  const [typesResponse, configResponse] = await Promise.all([
    bsaleFetchForCompany<BsalePaymentType>({ companyId, path: '/payment_types.json' }),
    db().from('collection_payment_type_config').select('bsale_payment_type_id,label,enabled,dynamic_attributes').eq('company_id', companyId).eq('enabled', true),
  ])
  if (configResponse.error) throw new Error(configResponse.error.message)

  const configuredTypes = configResponse.data ?? []
  const availableTypes: CollectionPaymentType[] = configuredTypes.flatMap(config => {
    const liveType = (typesResponse.items ?? []).find(type => type.id === config.bsale_payment_type_id)
    if (!liveType || !isBsalePaymentTypeActive(liveType)) return []
    return [{
      id: config.bsale_payment_type_id,
      label: config.label,
      name: liveType.name,
      dynamicAttributes: liveType.dynamicAttributes ?? liveType.dynamic_attributes ?? config.dynamic_attributes ?? [],
    }]
  })
  if (availableTypes.length === 0) throw new Error('No hay formas de pago habilitadas y activas en Bsale para la empresa activa.')
  return { configuredTypes, availableTypes, liveTypes: typesResponse.items ?? [] }
}

export async function prepareCollectionPayment(input: { documentId: number; amount: number; paymentTypeId?: number }) {
  const { companyId } = await context()
  if (!(await canRegisterPayment())) throw new Error('No tienes permiso para registrar pagos de cobranza.')
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) throw new Error('Documento Bsale inválido.')
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('El monto debe ser mayor que cero.')

  const { data: document, error } = await createAdminClient().schema('integraciones')
    .from('bsale_receivable_snapshot_documents')
    .select('bsale_document_id,client_id,folio,total_amount,total_amount_owed,snapshot_at')
    .eq('company_id', companyId).eq('bsale_document_id', input.documentId)
    .order('snapshot_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(error.message)
  if (!document) throw new Error('El documento no pertenece al snapshot de CxC de la empresa activa.')

  const [unpaidResponse, paymentTypes] = await Promise.all([
    bsaleFetchResourceForCompany<BsaleUnpaidDocuments>({ companyId, path: `/clients/unpaid_documents.json`, params: { clientid: Number(document.client_id) } }),
    loadCollectionPaymentTypes(companyId),
  ])
  const liveDocuments = [...(unpaidResponse.overdue_documents ?? []), ...(unpaidResponse.upcoming_documents ?? [])]
  const liveDocument = liveDocuments.find(item => Number(item.id) === Number(input.documentId))
  if (!liveDocument || Number(liveDocument.totalAmountOwed ?? 0) <= 0) throw new Error('El documento ya no está pendiente en Bsale.')

  const selectedType = input.paymentTypeId === undefined
    ? null
    : paymentTypes.availableTypes.find(type => type.id === input.paymentTypeId) ?? null
  if (input.paymentTypeId !== undefined && !selectedType) {
    const configured = paymentTypes.configuredTypes.some(type => type.bsale_payment_type_id === input.paymentTypeId)
    throw new Error(configured ? 'La forma de pago configurada está inactiva o no existe en Bsale.' : 'La forma de pago no está habilitada para la empresa activa.')
  }

  const liveBalance = Number(liveDocument.totalAmountOwed)
  if (input.amount > liveBalance) throw new Error('El monto supera el saldo vivo consultado en Bsale.')

  return {
    ok: true as const,
    documentId: input.documentId,
    requestedAmount: input.amount,
    snapshotBalance: Number(document.total_amount_owed),
    liveBalance,
    clientId: Number(document.client_id),
    folio: document.folio,
    recordDate: new Date().toISOString().slice(0, 10),
    paymentTypes: paymentTypes.availableTypes,
    paymentType: selectedType,
    writesBsale: false,
  }
}

type CollectionAuditAction = 'INSERT' | 'STATUS_CHANGE' | 'UPDATE'

async function auditCollectionEvent(input: { userId: string; action: CollectionAuditAction; eventType: string; attemptId?: string; metadata: Record<string, unknown> }) {
  const { error } = await createAdminClient().schema('portal').from('audit_logs').insert({
    table_name: 'collection_payment_attempts',
    record_id: input.attemptId ?? null,
    action: input.action,
    performed_by: input.userId,
    schema_name: 'comercial',
    module_code: 'ANALISIS_COMERCIAL_COBRANZA',
    event_type: input.eventType,
    severity: 'INFO',
    metadata: input.metadata,
  })
  if (error) throw new Error(`No se pudo registrar auditoría de cobranza: ${error.message}`)
}

async function auditCollectionEventBestEffort(input: Parameters<typeof auditCollectionEvent>[0]) {
  try {
    await auditCollectionEvent(input)
  } catch (cause) {
    console.error('[cobranza] fallo secundario de auditoría', cause)
  }
}

function paymentId(payment: CollectionPayment | null | undefined) {
  const id = Number(payment?.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

function matchingPayments(payments: CollectionPayment[], input: { amount: number; paymentTypeId: number; recordDate: string }) {
  return payments.filter(payment => {
    const amountMatches = Math.abs(Number(payment.amount ?? 0) - input.amount) < 0.01
    const type = Number(payment.payment_type?.id ?? payment.paymentTypeId)
    const typeMatches = type === input.paymentTypeId
    const rawDate = Number(payment.recordDate)
    const date = Number.isFinite(rawDate) && rawDate > 0 ? new Date(rawDate * 1000).toISOString().slice(0, 10) : String(payment.recordDate ?? '').slice(0, 10)
    return amountMatches && typeMatches && date === input.recordDate
  }).filter(payment => paymentId(payment) !== null)
}

async function loadCollectionPaymentReconciliation(input: {
  companyId: string
  clientId: number
  documentId: number
  paymentId: number
  gateway: CollectionPaymentGateway
}) {
  const [payment, documentPayments, unpaid] = await Promise.all([
    input.gateway.getPayment(input.paymentId),
    input.gateway.getDocumentPayments(input.documentId),
    input.gateway.getUnpaidDocuments(input.clientId),
  ])
  const liveDocument = findUnpaidDocument(unpaid, input.documentId)
  const postBalance = Number(liveDocument?.totalAmountOwed ?? 0)
  const clientBalance = totalUnpaid(unpaid)
  return { payment, documentPayments, postBalance, clientBalance }
}

async function reconcileCollectionPayment(input: {
  companyId: string
  clientId: number
  documentId: number
  paymentId: number
  gateway: CollectionPaymentGateway
  recordDate?: string
}) {
  const reconciled = await loadCollectionPaymentReconciliation(input)
  await upsertDirectedPayment(input.companyId, input.clientId, input.documentId, reconciled.payment, reconciled.documentPayments, input.recordDate)
  return reconciled
}

export async function reconcileExistingCollectionPayment(input: { attemptId: string; paymentId: number }) {
  const { companyId, user } = await context()
  const { data: attempt, error } = await db().from('collection_payment_attempts')
    .select('id,client_id,bsale_document_id,amount,payment_type_id,status,bsale_payment_id,record_date')
    .eq('company_id', companyId).eq('id', input.attemptId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!attempt) throw new Error('El intento de cobranza no pertenece a la empresa activa.')
  if (!['REQUIRES_REVIEW', 'UNKNOWN', 'CONFIRMED'].includes(String(attempt.status))) throw new Error('El intento no está pendiente de reconciliación.')
  if (attempt.status === 'CONFIRMED' && Number(attempt.bsale_payment_id) !== input.paymentId) throw new Error('El intento ya está confirmado con otro payment.')
  const gateway = createCollectionPaymentGateway(companyId)
  const reconciled = await loadCollectionPaymentReconciliation({ companyId, clientId: Number(attempt.client_id), documentId: Number(attempt.bsale_document_id), paymentId: input.paymentId, gateway })
  if (paymentId(reconciled.payment) !== input.paymentId) throw new Error('El payment consultado no coincide con la respuesta de Bsale.')
  if (Math.abs(Number(reconciled.payment.amount ?? 0) - Number(attempt.amount)) >= 0.01) throw new Error('El monto del payment no coincide con el intento local.')
  const paymentTypeId = Number(reconciled.payment.payment_type?.id ?? reconciled.payment.paymentTypeId)
  if (paymentTypeId !== Number(attempt.payment_type_id)) throw new Error('La forma de pago del payment no coincide con el intento local.')
  const applications = [reconciled.payment, ...reconciled.documentPayments].flatMap(payment => dedupeCollectionPaymentApplications(payment, Number(attempt.bsale_document_id)))
  const documentApplication = applications.find(application => application.documentId === Number(attempt.bsale_document_id))
  if (!documentApplication) throw new Error('El payment no contiene una aplicación inequívoca al documento del intento.')
  await upsertDirectedPayment(companyId, Number(attempt.client_id), Number(attempt.bsale_document_id), reconciled.payment, reconciled.documentPayments, String(attempt.record_date ?? ''))
  await db().from('collection_payment_attempts').update({
    status: 'CONFIRMED',
    bsale_payment_id: input.paymentId,
    post_balance: reconciled.postBalance,
    confirmed_at: new Date().toISOString(),
    payment_response: reconciled.payment,
    updated_at: new Date().toISOString(),
  }).eq('company_id', companyId).eq('id', input.attemptId)
  await auditCollectionEventBestEffort({ userId: user.id, action: 'UPDATE', eventType: 'COLLECTION_PAYMENT_CONFIRMED', attemptId: input.attemptId, metadata: { company_id: companyId, client_id: Number(attempt.client_id), bsale_document_id: Number(attempt.bsale_document_id), amount: Number(attempt.amount), payment_type_id: paymentTypeId, bsale_payment_id: input.paymentId, post_balance: reconciled.postBalance, reconciliation: 'DIRECTED_EXISTING_PAYMENT' } })
  if (reconciled.clientBalance === 0) await closeCollectionCustomer(companyId, user.id, Number(attempt.client_id), Number(attempt.bsale_document_id), Number(attempt.amount), input.paymentId)
  return { ok: true as const, attemptId: input.attemptId, paymentId: input.paymentId, documentBalance: reconciled.postBalance, clientBalance: reconciled.clientBalance }
}

async function upsertDirectedPayment(companyId: string, clientId: number, documentId: number, payment: CollectionPayment, documentPayments: CollectionPayment[], fallbackRecordDate?: string) {
  const admin = createAdminClient().schema('integraciones')
  const id = paymentId(payment)
  if (!id) return
  const now = new Date().toISOString()
  const paymentTypeId = Number(payment.payment_type?.id ?? payment.paymentTypeId) || null
  const rawRecordDate = Number(payment.recordDate)
  const paymentDate = Number.isFinite(rawRecordDate) && rawRecordDate > 0 ? new Date(rawRecordDate * 1000).toISOString() : null
  const { data: document } = await admin.from('bsale_documents').select('document_type_id,number').eq('company_id', companyId).eq('bsale_id', documentId).maybeSingle()
  const { error } = await admin.from('bsale_payments').upsert({
    company_id: companyId,
    bsale_id: id,
    bsale_payment_id: id,
    bsale_document_id: documentId,
    amount: Number(payment.amount ?? 0),
    payment_date: paymentDate,
    record_date: paymentDate?.slice(0, 10) ?? fallbackRecordDate ?? (typeof payment.recordDate === 'string' ? payment.recordDate.slice(0, 10) : null),
    payment_type_id: paymentTypeId,
    payment_type_bsale_id: paymentTypeId,
    payment_type_name: payment.payment_type?.name ?? null,
    state: Number(payment.state) || null,
    raw_json: payment,
    synced_at: now,
    updated_at: now,
  }, { onConflict: 'company_id,bsale_payment_id' })
  if (error) throw new Error(`No se pudo sincronizar el pago Bsale: ${error.message}`)

  const applicationSources = [payment, ...documentPayments]
  const allocationsByKey = new Map<string, {
    company_id: string
    bsale_payment_id: number
    bsale_document_id: number
    document_type_id: number | null
    document_number: number | null
    client_id: number
    payment_record_date: string | null
    amount_applied: number
    raw_json: Record<string, unknown>
    synced_at: string
    updated_at: string
  }>()
  for (const source of applicationSources) {
    for (const application of dedupeCollectionPaymentApplications(source, documentId)) {
      if (application.documentId !== documentId) continue
      const key = `${id}:${application.documentId}`
      if (!allocationsByKey.has(key)) allocationsByKey.set(key, {
        company_id: companyId,
        bsale_payment_id: id,
        bsale_document_id: application.documentId,
        document_type_id: document?.document_type_id ?? null,
        document_number: document?.number ?? null,
        client_id: clientId,
        payment_record_date: null,
        amount_applied: application.amount,
        raw_json: { payment, source, application },
        synced_at: now,
        updated_at: now,
      })
    }
  }
  const allocations = [...allocationsByKey.values()]
  if (allocations.length > 0) {
    const allocationResult = await admin.from('bsale_document_payments').upsert(allocations, { onConflict: 'company_id,bsale_payment_id,bsale_document_id' })
    if (allocationResult.error) throw new Error(`No se pudo sincronizar aplicación de pago: ${allocationResult.error.message}`)
  }
}

export async function registerCollectionPayment(input: {
  documentId: number
  amount: number
  paymentTypeId?: number
  clientId?: number
  recordDate?: string
  batchId?: string
}) {
  const { companyId, user } = await context()
  if (!(await canRegisterPayment())) throw new Error('No tienes permiso para registrar pagos de cobranza.')
  if (!Number.isInteger(input.paymentTypeId) || (input.paymentTypeId ?? 0) <= 0) throw new Error('La forma de pago es obligatoria.')
  const idempotencyKey = crypto.randomUUID()
  const recordDate = input.recordDate ?? new Date().toISOString().slice(0, 10)
  const inserted = await db().from('collection_payment_attempts').insert({
    company_id: companyId,
    client_id: input.clientId ?? 0,
    bsale_document_id: input.documentId,
    idempotency_key: idempotencyKey,
    amount: input.amount,
    payment_type_id: input.paymentTypeId ?? 0,
    record_date: recordDate,
    batch_id: input.batchId ?? null,
    status: 'CREATED',
    created_by: user.id,
  }).select('id').single()
  if (inserted.error || !inserted.data) throw new Error('Ya existe un intento activo para este documento o no se pudo adquirir el lock.')
  const attemptId = inserted.data.id as string
  let postAttempted = false

  try {
    const preflight = await prepareCollectionPayment({ documentId: input.documentId, amount: input.amount, paymentTypeId: input.paymentTypeId })
    if (!preflight.paymentType) throw new Error('La forma de pago es obligatoria.')
    if (input.clientId !== undefined && input.clientId !== preflight.clientId) throw new Error('El cliente no coincide con el documento Bsale.')
    const recordDateUnix = calendarDateToUnixSeconds(recordDate)
    await db().from('collection_payment_attempts').update({
      client_id: preflight.clientId,
      payment_type_id: preflight.paymentType.id,
      preflight_balance: preflight.liveBalance,
      request_payload: { recordDate, recordDateUnix, amount: input.amount, documentId: input.documentId, paymentTypeId: preflight.paymentType.id },
      updated_at: new Date().toISOString(),
    }).eq('id', attemptId).eq('company_id', companyId)
    await auditCollectionEvent({ userId: user.id, action: 'INSERT', eventType: 'COLLECTION_PAYMENT_SUBMITTED', attemptId, metadata: { company_id: companyId, client_id: preflight.clientId, bsale_document_id: input.documentId, amount: input.amount, payment_type_id: preflight.paymentType.id, preflight_balance: preflight.liveBalance } })
    await db().from('collection_payment_attempts').update({ status: 'SUBMITTING', updated_at: new Date().toISOString() }).eq('id', attemptId)
    const gateway = createCollectionPaymentGateway(companyId)
    let response: CollectionPayment
    try {
      // Once the gateway call starts, the request may have reached Bsale even if it throws.
      postAttempted = true
      response = await gateway.createPayment({ recordDate: recordDateUnix, amount: input.amount, documentId: input.documentId, paymentTypeId: preflight.paymentType.id })
    } catch (cause) {
      await db().from('collection_payment_attempts').update({ status: 'UNKNOWN', error_message: cause instanceof Error ? cause.message.slice(0, 500) : 'Error Bsale', updated_at: new Date().toISOString() }).eq('id', attemptId)
      await auditCollectionEventBestEffort({ userId: user.id, action: 'STATUS_CHANGE', eventType: 'COLLECTION_PAYMENT_UNKNOWN', attemptId, metadata: { company_id: companyId, client_id: preflight.clientId, bsale_document_id: input.documentId, amount: input.amount } })
      throw cause
    }
    let createdPaymentId = paymentId(response)
    if (!createdPaymentId) {
      const candidates = matchingPayments(await gateway.getDocumentPayments(input.documentId), { amount: input.amount, paymentTypeId: preflight.paymentType.id, recordDate })
      if (candidates.length === 1) {
        createdPaymentId = paymentId(candidates[0])
      } else {
        throw new Error(candidates.length === 0 ? 'Bsale no devolvió payment id ni una coincidencia inequívoca; el intento requiere revisión.' : 'Se encontraron múltiples pagos coincidentes; el intento requiere revisión.')
      }
    }
    if (!createdPaymentId) throw new Error('El intento requiere revisión.')
    const reconciled = await reconcileCollectionPayment({ companyId, clientId: preflight.clientId, documentId: input.documentId, paymentId: createdPaymentId, gateway, recordDate })
    await db().from('collection_payment_attempts').update({ status: 'CONFIRMED', bsale_payment_id: createdPaymentId, post_balance: reconciled.postBalance, confirmed_at: new Date().toISOString(), payment_response: response, updated_at: new Date().toISOString() }).eq('id', attemptId)
    await auditCollectionEventBestEffort({ userId: user.id, action: 'UPDATE', eventType: 'COLLECTION_PAYMENT_CONFIRMED', attemptId, metadata: { company_id: companyId, client_id: preflight.clientId, bsale_document_id: input.documentId, amount: input.amount, payment_type_id: preflight.paymentType.id, bsale_payment_id: createdPaymentId, post_balance: reconciled.postBalance } })
    if (reconciled.clientBalance === 0) await closeCollectionCustomer(companyId, user.id, preflight.clientId, input.documentId, preflight.liveBalance, createdPaymentId)
    return { ok: true as const, attemptId, paymentId: createdPaymentId, documentBalance: reconciled.postBalance, clientBalance: reconciled.clientBalance, payment: response }
  } catch (cause) {
    if (!postAttempted) {
      await db().from('collection_payment_attempts').update({ status: 'FAILED', error_message: cause instanceof Error ? cause.message.slice(0, 500) : 'Error de registro', updated_at: new Date().toISOString() }).eq('id', attemptId).eq('status', 'CREATED')
      await auditCollectionEventBestEffort({ userId: user.id, action: 'STATUS_CHANGE', eventType: 'COLLECTION_PAYMENT_FAILED', attemptId, metadata: { company_id: companyId, bsale_document_id: input.documentId, amount: input.amount, error: cause instanceof Error ? cause.message.slice(0, 300) : 'Error de registro' } })
      throw cause
    }
    await db().from('collection_payment_attempts').update({ status: 'REQUIRES_REVIEW', error_message: cause instanceof Error ? cause.message.slice(0, 500) : 'Error posterior al POST', updated_at: new Date().toISOString() }).eq('id', attemptId).eq('status', 'SUBMITTING')
    await auditCollectionEventBestEffort({ userId: user.id, action: 'STATUS_CHANGE', eventType: 'COLLECTION_PAYMENT_REQUIRES_REVIEW', attemptId, metadata: { company_id: companyId, bsale_document_id: input.documentId, amount: input.amount, error: cause instanceof Error ? cause.message.slice(0, 300) : 'Error posterior al POST' } })
    throw new Error('El pago pudo haberse creado en Bsale y requiere revisión. No reintentes automáticamente.')
  }
}

async function closeCollectionCustomer(companyId: string, userId: string, clientId: number, documentId: number, previousBalance: number, paymentIdValue: number) {
  await db().from('collection_customer_workflow').upsert({ company_id: companyId, client_id: clientId, stage: 'CLOSED', updated_at: new Date().toISOString() }, { onConflict: 'company_id,client_id' })
  await db().from('collection_customer_events').insert({ company_id: companyId, client_id: clientId, event_type: 'PAYMENT_CLOSED', body: 'Cliente cerrado automáticamente por saldo Bsale cero.', metadata: { previous_balance: previousBalance, final_balance: 0, payment_ids: [paymentIdValue], document_id: documentId }, created_by: userId })
  await auditCollectionEventBestEffort({ userId, action: 'STATUS_CHANGE', eventType: 'COLLECTION_CUSTOMER_CLOSED', metadata: { company_id: companyId, client_id: clientId, bsale_document_id: documentId, payment_ids: [paymentIdValue], preflight_balance: previousBalance, post_balance: 0 } })
}

export async function reopenCollectionCustomersWithDebt(clientIds: number[], snapshotAt?: string | null) {
  const { companyId, user } = await context()
  if (clientIds.length === 0) return { reopened: 0 }
  const { data: closed, error } = await db().from('collection_customer_workflow').select('client_id').eq('company_id', companyId).eq('stage', 'CLOSED').in('client_id', clientIds)
  if (error) throw new Error(error.message)
  for (const row of closed ?? []) {
    const latestClosedEvent = await db().from('collection_customer_events').select('created_at').eq('company_id', companyId).eq('client_id', row.client_id).eq('event_type', 'PAYMENT_CLOSED').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (snapshotAt && latestClosedEvent.data?.created_at && snapshotAt <= latestClosedEvent.data.created_at) continue
    const { data: newDebt } = await createAdminClient().schema('integraciones').from('bsale_receivable_snapshot_documents').select('id').eq('company_id', companyId).eq('client_id', row.client_id).gt('total_amount_owed', 0).order('snapshot_at', { ascending: false }).limit(1).maybeSingle()
    if (!newDebt) continue
    await db().from('collection_customer_workflow').update({ stage: 'TO_MANAGE', updated_at: new Date().toISOString() }).eq('company_id', companyId).eq('client_id', row.client_id)
    await db().from('collection_customer_events').insert({ company_id: companyId, client_id: row.client_id, event_type: 'REOPENED_BY_NEW_DEBT', body: 'Cliente reabierto por nueva deuda pendiente.', metadata: {}, created_by: user.id })
  }
  return { reopened: closed?.length ?? 0 }
}

export async function prepareCollectionCustomerBatch(clientId: number) {
  const { companyId } = await context()
  if (!(await canRegisterPayment())) throw new Error('No tienes permiso para registrar pagos de cobranza.')
  const gateway = createCollectionPaymentGateway(companyId)
  const unpaid = await gateway.getUnpaidDocuments(clientId)
  const liveDocuments = flattenUnpaidDocuments(unpaid).filter(document => Number(document.totalAmountOwed ?? 0) > 0)
  const { data: compatible, error } = await createAdminClient().schema('integraciones').from('bsale_receivable_snapshot_documents')
    .select('bsale_document_id,folio,client_id,total_amount_owed').eq('company_id', companyId).eq('client_id', clientId).order('snapshot_at', { ascending: false })
  if (error) throw new Error(error.message)
  const compatibleIds = new Set((compatible ?? []).map(row => Number(row.bsale_document_id)))
  const documents = liveDocuments.filter(document => compatibleIds.has(Number(document.id))).map(document => ({
    documentId: Number(document.id),
    folio: document.number ?? null,
    balance: Number(document.totalAmountOwed),
  }))
  if (documents.length === 0) throw new Error('No hay documentos pendientes compatibles con Cobranza.')
  const paymentTypes = await loadCollectionPaymentTypes(companyId)
  return { clientId, documents, total: documents.reduce((sum, document) => sum + document.balance, 0), paymentTypes: paymentTypes.availableTypes }
}

export async function registerCollectionCustomerBatch(input: { clientId: number; paymentTypeId: number; recordDate?: string }) {
  const { companyId, user } = await context()
  if (!(await canRegisterPayment())) throw new Error('No tienes permiso para registrar pagos de cobranza.')
  const prepared = await prepareCollectionCustomerBatch(input.clientId)
  if (!prepared.paymentTypes.some(type => type.id === input.paymentTypeId)) throw new Error('La forma de pago no está habilitada y activa para la empresa activa.')
  const batch = await db().from('collection_payment_batches').insert({ company_id: companyId, client_id: input.clientId, payment_type_id: input.paymentTypeId, record_date: input.recordDate ?? new Date().toISOString().slice(0, 10), expected_total: prepared.total, created_by: user.id, status: 'PROCESSING' }).select('id').single()
  if (batch.error || !batch.data) throw new Error(batch.error?.message ?? 'No se pudo crear el batch.')
  const batchId = batch.data.id as string
  let confirmedTotal = 0
  let failed = 0
  let unknown = 0
  const results: Array<{
    documentId: number
    folio: number | string | null
    amount: number
    status: 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
    message?: string
  }> = []
  for (const document of prepared.documents) {
    try {
       const result = await registerCollectionPayment({ documentId: document.documentId, amount: document.balance, paymentTypeId: input.paymentTypeId, clientId: input.clientId, recordDate: input.recordDate, batchId })
      confirmedTotal += document.balance
      results.push({ ...document, amount: document.balance, status: 'CONFIRMED' })
      if (!result.ok) failed++
    } catch (cause) {
      const isUnknown = cause instanceof Error && /unknown|timeout|network|revisión/i.test(cause.message)
      if (isUnknown) unknown++
      else failed++
      results.push({ ...document, amount: document.balance, status: isUnknown ? 'UNKNOWN' : 'FAILED', message: cause instanceof Error ? cause.message : 'No se pudo registrar.' })
    }
  }
  const status = unknown > 0 ? 'UNKNOWN' : failed > 0 ? (confirmedTotal > 0 ? 'PARTIAL' : 'FAILED') : 'COMPLETED'
  await db().from('collection_payment_batches').update({ confirmed_total: confirmedTotal, status, completed_at: new Date().toISOString() }).eq('company_id', companyId).eq('id', batchId)
  await auditCollectionEventBestEffort({ userId: user.id, action: 'STATUS_CHANGE', eventType: status === 'PARTIAL' ? 'COLLECTION_PAYMENT_BATCH_PARTIAL' : 'COLLECTION_PAYMENT_BATCH_COMPLETED', metadata: { company_id: companyId, client_id: input.clientId, batch_id: batchId, expected_total: prepared.total, confirmed_total: confirmedTotal, status } })
  return { ok: true as const, batchId, status, expectedTotal: prepared.total, confirmedTotal, failed, unknown, results }
}
