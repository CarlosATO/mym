import { getFinancialMovementsDashboard } from '@/app/actions/control-financiero/financial-movements'
import { getFinancialInflowCategories, listFinancialInflows } from '@/app/actions/control-financiero/financial-inflows'
import { getRecognizedExpenseCategories, listRecognizedExpenses } from '@/app/actions/control-financiero/recognized-expenses'
import { FinancialMovementsClient } from '@/modules/analisis-comercial/control-financiero/components/financial-movements-client'

export default async function FinancialMovementsPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; status?: string; source?: string; search?: string }> }) {
  const params = await searchParams
  const now = new Date()
  const year = Number(params.year) || now.getFullYear()
  const month = Number(params.month) || now.getMonth() + 1
  const [initialData, categories, inflowCategories, inflows, dashboard] = await Promise.all([
    listRecognizedExpenses({ year, month, status: params.status, sourceType: params.source, search: params.search }),
    getRecognizedExpenseCategories(),
    getFinancialInflowCategories(),
    listFinancialInflows({ year, month }),
    getFinancialMovementsDashboard(year, month),
  ])
  return <FinancialMovementsClient initialData={{ ...initialData, inflows }} categories={categories} inflowCategories={inflowCategories} dashboard={dashboard} year={year} month={month} />
}
