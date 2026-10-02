import { getPayrollImportHistory } from '@/app/actions/control-financiero/payroll'
import { getActiveCompany } from '@/app/actions/companies'
import { PayrollImportClient } from '@/modules/analisis-comercial/control-financiero/components/payroll-import-client'

export default async function LibroRemuneracionesPage() {
  const [history, company] = await Promise.all([getPayrollImportHistory(), getActiveCompany()])
  return <PayrollImportClient history={history} companyId={company?.id ?? ''} />
}
