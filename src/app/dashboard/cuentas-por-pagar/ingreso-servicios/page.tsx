import { AccessDenied } from '@/components/access-denied'
import { getActiveCompanyId } from '@/app/actions/companies'
import { getServiceSuppliers } from '@/app/actions/cuentas-por-pagar'
import { createClient } from '@/lib/supabase/server'
import { ServiceInvoiceForm } from '@/modules/cuentas-por-pagar/service-invoice-form'

export default async function IngresoServiciosPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || await getActiveCompanyId(user) !== 'd1000000-0000-0000-0000-000000000001') {
    return <AccessDenied />
  }

  const suppliers = await getServiceSuppliers().catch(() => null)
  if (!suppliers) {
    return (
      <p className="text-sm text-theme-text-muted">
        No se pudo cargar el catálogo de proveedores o no tiene acceso a Cuentas por Pagar.
      </p>
    )
  }

  return <ServiceInvoiceForm suppliers={suppliers} />
}
