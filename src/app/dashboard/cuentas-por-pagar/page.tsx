import { AccessDenied } from '@/components/access-denied'
import { getActiveCompanyId } from '@/app/actions/companies'
import { getReceiptInvoiceCandidates } from '@/app/actions/cuentas-por-pagar'
import { createClient } from '@/lib/supabase/server'
import { InvoiceInbox } from '@/modules/cuentas-por-pagar/invoice-inbox'

export default async function CuentasPorPagarPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || await getActiveCompanyId(user) !== 'd1000000-0000-0000-0000-000000000001') return <AccessDenied />
  const candidates = await getReceiptInvoiceCandidates().catch(() => null)
  if (!candidates) return <p className="text-sm text-theme-text-muted">No se pudo cargar la bandeja de facturas o no tiene acceso.</p>
  return <InvoiceInbox initialCandidates={candidates} />
}
