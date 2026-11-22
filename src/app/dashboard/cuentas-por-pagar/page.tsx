import { AccessDenied } from '@/components/access-denied'
import { getActiveCompanyId } from '@/app/actions/companies'
import {
  getInvoiceSummaries,
  getCxpInboxDocumentStatus,
  getReceiptInvoiceDueDates,
  getReceiptInvoiceCandidates,
  getServiceInvoices,
} from '@/app/actions/cuentas-por-pagar'
import { createClient } from '@/lib/supabase/server'
import { InvoiceInbox } from '@/modules/cuentas-por-pagar/invoice-inbox'
import { mergeInboxCandidates } from '@/modules/cuentas-por-pagar/service-rules'

export default async function CuentasPorPagarPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || await getActiveCompanyId(user) !== 'd1000000-0000-0000-0000-000000000001') {
    return <AccessDenied />
  }

  const [productCandidates, serviceInvoices, summaries, documents, dueDates] = await Promise.all([
    getReceiptInvoiceCandidates().catch(() => null),
    getServiceInvoices().catch(() => []),
    getInvoiceSummaries().catch(() => []),
    getCxpInboxDocumentStatus().catch(() => null),
    getReceiptInvoiceDueDates().catch(() => null),
  ])

  if (!productCandidates) {
    return <p className="text-sm text-theme-text-muted">No se pudo cargar la bandeja de facturas o no tiene acceso.</p>
  }

  const candidates = mergeInboxCandidates(productCandidates, serviceInvoices)
  return <InvoiceInbox initialCandidates={candidates} initialSummaries={summaries} documents={documents} dueDates={dueDates} />
}
