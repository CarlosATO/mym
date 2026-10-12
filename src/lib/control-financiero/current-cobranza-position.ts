import type { FinanceReceivablesAnalysis } from './finance-api'
// @ts-expect-error Node financial harnesses use explicit TypeScript extensions.
import { applyCobranzaPaymentOverlay, buildCobranzaClients, calculateCobranzaClientKpis } from '../../modules/analisis-comercial/lib/cobranza-metrics.ts'

export type CurrentCobranzaPosition = {
  source: FinanceReceivablesAnalysis['receivables_source']
  snapshotAt: string | null
  asOfDate: string
  snapshotDocumentCount: number
  activeDocumentCount: number
  visibleDocumentCount: number
  /** Cobranza opens with scope='overdue', age='0', no search, viewMode='CLIENTS'. */
  defaultScope: { receivableAmount: number; overdueAmount: number; clientCount: number }
  allPortfolio: { receivableAmount: number; overdueAmount: number; clientCount: number }
  /** Same filtered document collection as Cobranza's default client view. */
  documents: FinanceReceivablesAnalysis['documents']
  /** Complete current portfolio after the canonical payment overlay. */
  allDocuments: FinanceReceivablesAnalysis['documents']
  overlayCount: number
  latestConfirmedPaymentAt: string | null
  clientsUnqueryable: number
}

export function buildCurrentCobranzaPosition(
  analysis: FinanceReceivablesAnalysis,
  overlay: Array<{ documentId: number; pendingAmount: number; confirmedAt?: string }>,
): CurrentCobranzaPosition {
  const asOfDate = analysis.snapshot_date ?? analysis.close_date
  const documents = applyCobranzaPaymentOverlay(analysis.documents, overlay)
  const clients = buildCobranzaClients(documents, asOfDate)
  const defaultClients = clients.filter(client => client.overdueAmount > 0)
  const defaultKpis = calculateCobranzaClientKpis(defaultClients)
  const allKpis = calculateCobranzaClientKpis(clients)
  return {
    source: analysis.receivables_source,
    snapshotAt: analysis.snapshot_at ?? null,
    asOfDate,
    snapshotDocumentCount: analysis.summary.pending_documents,
    activeDocumentCount: documents.length,
    visibleDocumentCount: defaultClients.reduce((total, client) => total + client.pendingDocuments, 0),
    defaultScope: { receivableAmount: defaultKpis.totalAmount, overdueAmount: defaultKpis.overdueAmount, clientCount: defaultKpis.clientsWithBalance },
    allPortfolio: { receivableAmount: allKpis.totalAmount, overdueAmount: allKpis.overdueAmount, clientCount: allKpis.clientsWithBalance },
    documents: defaultClients.flatMap(client => client.documents),
    allDocuments: clients.flatMap(client => client.documents),
    overlayCount: overlay.length,
    latestConfirmedPaymentAt: overlay.map(item => item.confirmedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
    clientsUnqueryable: analysis.clients_unqueryable ?? 0,
  }
}
