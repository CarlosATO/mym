import { getCashFlowDashboard } from '@/app/actions/control-financiero/bank-statements'
import { canClassifyFinancialMovements, getFinancialClassificationCategories, getFinancialPersonnelBeneficiaries } from '@/app/actions/control-financiero/classification'
import { CashFlowClient } from '@/modules/analisis-comercial/control-financiero/components/cash-flow-client'
import { todayInSantiago } from '@/lib/datetime'

export default async function FlujoCajaPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; account?: string; page?: string; classification?: string; search?: string; category?: string; scope?: string; direction?: string }> }) {
  const params = await searchParams
  const today = todayInSantiago()
  const year = Number(params.year) || Number(today.slice(0, 4))
  const month = Math.min(12, Math.max(1, Number(params.month) || Number(today.slice(5, 7))))
  const accountId = params.account || undefined
  const page = Math.max(1, Math.floor(Number(params.page) || 1))
  const classification = params.classification === 'PENDING' || params.classification === 'REVIEWED' || params.classification === 'HISTORICAL' ? params.classification : 'ALL'
  const scope = params.scope === 'year' ? 'year' : 'month'
  const direction = params.direction === 'credit' || params.direction === 'debit' ? params.direction : 'all'
  const data = await getCashFlowDashboard(year, month, accountId, page, classification, params.search ?? '', params.category || undefined, scope, direction)
  const categories = await getFinancialClassificationCategories()
  const beneficiaries = await getFinancialPersonnelBeneficiaries()
  const canClassify = await canClassifyFinancialMovements()
  return <CashFlowClient key={data.companyId} data={data} categories={categories} beneficiaries={beneficiaries} canClassify={canClassify} year={year} month={month} accountId={accountId} />
}
