import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from './client'
import { bsaleWriteForCompany } from './write-client'

export type CollectionPaymentPayload = {
  recordDate: number
  amount: number
  documentId: number
  paymentTypeId: number
}

export type CollectionUnpaidDocument = {
  id?: number | string | null
  number?: number | string | null
  totalAmount?: number | string | null
  totalAmountOwed?: number | string | null
  [key: string]: unknown
}

export type CollectionPayment = {
  id?: number | string | null
  amount?: number | string | null
  recordDate?: number | string | null
  paymentTypeId?: number | string | null
  payment_type?: { id?: number | string | null; name?: string | null } | null
  document?: { id?: number | string | null; amount?: number | string | null } | null
  documents?: Array<{ id?: number | string | null; amount?: number | string | null }>
  [key: string]: unknown
}

export type CollectionPaymentGateway = {
  createPayment(payload: CollectionPaymentPayload): Promise<CollectionPayment>
  getPayment(paymentId: number): Promise<CollectionPayment>
  getDocumentPayments(documentId: number): Promise<CollectionPayment[]>
  getUnpaidDocuments(clientId: number): Promise<{ overdue_documents?: CollectionUnpaidDocument[]; upcoming_documents?: CollectionUnpaidDocument[] }>
}

export type CollectionPaymentApplication = {
  documentId: number
  amount: number
  source: 'documents' | 'document' | 'fallback'
}

export function calendarDateToUnixSeconds(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('La fecha de pago debe tener formato YYYY-MM-DD.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day) / 1000
  const date = new Date(timestamp * 1000)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('La fecha de pago no es válida.')
  return timestamp
}

export function dedupeCollectionPaymentApplications(payment: CollectionPayment, fallbackDocumentId: number): CollectionPaymentApplication[] {
  const candidates: Array<{ id: number; amount: number; source: CollectionPaymentApplication['source'] }> = []
  for (const document of payment.documents ?? []) {
    const id = Number(document.id)
    if (Number.isInteger(id) && id > 0) candidates.push({ id, amount: Number(document.amount ?? payment.amount ?? 0), source: 'documents' })
  }
  if (payment.document) {
    const id = Number(payment.document.id)
    if (Number.isInteger(id) && id > 0) candidates.push({ id, amount: Number(payment.document.amount ?? payment.amount ?? 0), source: 'document' })
  }
  if (candidates.length === 0) candidates.push({ id: fallbackDocumentId, amount: Number(payment.amount ?? 0), source: 'fallback' })
  const unique = new Map<number, CollectionPaymentApplication>()
  for (const candidate of candidates) {
    if (!unique.has(candidate.id)) unique.set(candidate.id, { documentId: candidate.id, amount: candidate.amount, source: candidate.source })
  }
  return [...unique.values()]
}

function items<T>(response: { items?: T[] } | T[]): T[] {
  return Array.isArray(response) ? response : response.items ?? []
}

export function createCollectionPaymentGateway(companyId: string): CollectionPaymentGateway {
  return {
    createPayment: payload => bsaleWriteForCompany<CollectionPayment>({ companyId, path: '/payments.json', body: payload as unknown as Record<string, unknown> }),
    getPayment: paymentId => bsaleFetchResourceForCompany<CollectionPayment>({ companyId, path: `/payments/${paymentId}.json` }),
    getDocumentPayments: async documentId => items(await bsaleFetchForCompany<CollectionPayment>({ companyId, path: '/payments.json', params: { documentid: documentId } })),
    getUnpaidDocuments: clientId => bsaleFetchResourceForCompany({ companyId, path: '/clients/unpaid_documents.json', params: { clientid: clientId } }),
  }
}

export function flattenUnpaidDocuments(payload: { overdue_documents?: CollectionUnpaidDocument[]; upcoming_documents?: CollectionUnpaidDocument[] }) {
  return [...(payload.overdue_documents ?? []), ...(payload.upcoming_documents ?? [])]
}

export function findUnpaidDocument(payload: { overdue_documents?: CollectionUnpaidDocument[]; upcoming_documents?: CollectionUnpaidDocument[] }, documentId: number) {
  return flattenUnpaidDocuments(payload).find(document => Number(document.id) === documentId && Number(document.totalAmountOwed ?? 0) > 0) ?? null
}

export function totalUnpaid(payload: { overdue_documents?: CollectionUnpaidDocument[]; upcoming_documents?: CollectionUnpaidDocument[] }) {
  return flattenUnpaidDocuments(payload).reduce((total, document) => total + Math.max(0, Number(document.totalAmountOwed ?? 0)), 0)
}
