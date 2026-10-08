import type { FinanceReceivablesAnalysis } from '@/lib/control-financiero/finance-api'

export type CobranzaDocument = FinanceReceivablesAnalysis['documents'][number]

export type CobranzaClient = {
  key: string
  clientId: number
  name: string
  code: string | null
  totalAmount: number
  overdueAmount: number
  pendingDocuments: number
  oldestExpirationDate: string | null
  oldestDaysOverdue: number
  documents: CobranzaDocument[]
  priority: 'Alta' | 'Media' | 'Normal'
}

export type CobranzaInvoice = CobranzaDocument & {
  key: string
  clientName: string
  clientCode: string | null
  daysOverdue: number
  priority: CobranzaClient['priority']
}

export type CobranzaPaymentOverlay = {
  documentId: number
  pendingAmount: number
}

export type CobranzaKpis = {
  totalAmount: number
  overdueAmount: number
  clientsWithBalance: number
  clientsWithOverdueDebt: number
}

const amount = (value: string) => Number(value || 0)

export function daysOverdue(expirationDate: string | null, cutoffDate: string): number {
  if (!expirationDate) return 0
  const expiration = new Date(`${expirationDate}T00:00:00Z`).getTime()
  const cutoff = new Date(`${cutoffDate}T00:00:00Z`).getTime()
  return Math.max(0, Math.floor((cutoff - expiration) / 86_400_000))
}

export function cobranzaPriority(overdueAmount: number, oldestDaysOverdue: number): CobranzaClient['priority'] {
  if (overdueAmount >= 1_000_000 || oldestDaysOverdue >= 30) return 'Alta'
  if (overdueAmount >= 250_000 || oldestDaysOverdue >= 15) return 'Media'
  return 'Normal'
}

export function buildCobranzaClients(
  documents: CobranzaDocument[],
  cutoffDate: string,
): CobranzaClient[] {
  const byClient = new Map<string, CobranzaClient>()

  for (const document of documents) {
    const key = String(document.client_id)
    const current = byClient.get(key)
    const documentDaysOverdue = document.overdue ? daysOverdue(document.expiration_date, cutoffDate) : 0
    const pendingAmount = amount(document.pending_amount)
    const overdueAmount = document.overdue ? pendingAmount : 0
    const expiration = document.expiration_date
    if (!current) {
      byClient.set(key, {
        key,
        clientId: document.client_id,
        name: document.client_name ?? document.client_code ?? 'Cliente sin nombre',
        code: document.client_code,
        totalAmount: pendingAmount,
        overdueAmount,
        pendingDocuments: 1,
        oldestExpirationDate: expiration,
        oldestDaysOverdue: documentDaysOverdue,
        documents: [document],
        priority: cobranzaPriority(overdueAmount, documentDaysOverdue),
      })
      continue
    }

    current.totalAmount += pendingAmount
    current.overdueAmount += overdueAmount
    current.pendingDocuments += 1
    current.documents.push(document)
    if (expiration && (!current.oldestExpirationDate || expiration < current.oldestExpirationDate)) {
      current.oldestExpirationDate = expiration
    }
    current.oldestDaysOverdue = Math.max(current.oldestDaysOverdue, documentDaysOverdue)
    current.priority = cobranzaPriority(current.overdueAmount, current.oldestDaysOverdue)
  }

  return [...byClient.values()].sort((left, right) =>
    right.overdueAmount - left.overdueAmount
    || right.oldestDaysOverdue - left.oldestDaysOverdue
    || right.totalAmount - left.totalAmount
    || left.name.localeCompare(right.name, 'es'),
  )
}

export function applyCobranzaPaymentOverlay(documents: CobranzaDocument[], overlay: CobranzaPaymentOverlay[]): CobranzaDocument[] {
  const balances = new Map(overlay.map(item => [item.documentId, Math.max(0, item.pendingAmount)]))
  return documents.flatMap(document => {
    const pendingAmount = balances.get(document.document_id)
    if (pendingAmount === undefined) return [document]
    if (pendingAmount <= 0) return []
    return [{ ...document, pending_amount: String(pendingAmount) }]
  })
}

export function buildCobranzaInvoices(clients: CobranzaClient[], cutoffDate: string): CobranzaInvoice[] {
  return clients.flatMap(client => client.documents.map(document => ({
    ...document,
    key: `${client.clientId}-${document.document_id}`,
    clientName: client.name,
    clientCode: client.code,
    daysOverdue: document.overdue ? daysOverdue(document.expiration_date, cutoffDate) : 0,
    priority: client.priority,
  })))
}

export function calculateCobranzaClientKpis(clients: CobranzaClient[]): CobranzaKpis {
  return clients.reduce((kpis, client) => ({
    totalAmount: kpis.totalAmount + client.totalAmount,
    overdueAmount: kpis.overdueAmount + client.overdueAmount,
    clientsWithBalance: kpis.clientsWithBalance + 1,
    clientsWithOverdueDebt: kpis.clientsWithOverdueDebt + (client.overdueAmount > 0 ? 1 : 0),
  }), { totalAmount: 0, overdueAmount: 0, clientsWithBalance: 0, clientsWithOverdueDebt: 0 })
}

export function calculateCobranzaInvoiceKpis(invoices: CobranzaInvoice[]): CobranzaKpis {
  const clientsWithBalance = new Set(invoices.map(invoice => invoice.client_id))
  const clientsWithOverdueDebt = new Set(invoices.filter(invoice => invoice.overdue).map(invoice => invoice.client_id))
  return {
    totalAmount: invoices.reduce((total, invoice) => total + amount(invoice.pending_amount), 0),
    overdueAmount: invoices.reduce((total, invoice) => total + (invoice.overdue ? amount(invoice.pending_amount) : 0), 0),
    clientsWithBalance: clientsWithBalance.size,
    clientsWithOverdueDebt: clientsWithOverdueDebt.size,
  }
}
