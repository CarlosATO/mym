import { AccessDenied } from '@/components/access-denied'
import { getActiveCompanyId } from '@/app/actions/companies'
import { getCxpBsaleBodegaReconciliation } from '@/app/actions/cuentas-por-pagar'
import { createClient } from '@/lib/supabase/server'
import { InvoiceInbox } from '@/modules/cuentas-por-pagar/invoice-inbox'

export default async function CuentasPorPagarPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (
    !user ||
    (await getActiveCompanyId(user)) !== 'd1000000-0000-0000-0000-000000000001'
  ) {
    return <AccessDenied />
  }

  const reconciliationResult = await getCxpBsaleBodegaReconciliation()

  if (!reconciliationResult.ok) {
    return (
      <p className="text-sm text-theme-text-muted">
        {reconciliationResult.error ||
          'No se pudo cargar la conciliación de facturas Bsale con Bodega o no tiene acceso.'}
      </p>
    )
  }

  return (
    <InvoiceInbox
      report={reconciliationResult.data}
      financialByKey={reconciliationResult.financialByKey}
      financialCounts={reconciliationResult.financialCounts}
    />
  )
}
