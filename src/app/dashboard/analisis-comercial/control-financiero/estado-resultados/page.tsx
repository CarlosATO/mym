import { getFinanceCogs, getFinanceExpenses, getFinancePersonnel, getFinanceReceivables, getFinanceSalesNet, getFinanceSalesNetByFamily } from '@/lib/control-financiero/finance-api'
import { getActiveCompany } from '@/app/actions/companies'
import { getCashFlowDashboard } from '@/app/actions/control-financiero/bank-statements'
import { getNonPnlCashData } from '@/app/actions/control-financiero/non-pnl-cash'
import { buildFinancialFamilyGroups } from '@/lib/control-financiero/family-groups'
import { buildStatementRows, getCommonCoverage, hasStatementInformation } from '@/lib/control-financiero/statement'
import { FinancialMatrix } from '../financial-matrix'
import { CreditLineControlSection, ManagerialLiquidityCards, NonPnlCashSection } from '../non-pnl-cash-section'
import { ReceivablesSection } from '../receivables-drilldown'
import { EstadoResultadosExcelButton } from '../estado-resultados-excel'
import { getFinancialCompanyDisplayName, getFinancialTradeName } from '@/modules/analisis-comercial/control-financiero/lib/company-display'

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function formatClp(value: string | null) {
  if (value === null) return '—'
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

function formatPeriod(value: string | null) {
  if (!value) return null
  const [, month, day] = value.split('-')
  return `${day}-${month}-${value.slice(0, 4)}`
}

function ApiError({ status, message }: { status: number; message: string }) {
  const title = status === 403 ? 'Sin permiso para consultar Control Financiero' : 'No se pudieron cargar los datos financieros'
  return (
    <div className="border border-[#72383D]/25 bg-white/45 px-5 py-8">
      <p className="text-sm font-semibold text-[#72383D]">{title}</p>
      <p className="mt-2 text-xs leading-5 text-[#322D29]/65">{message}</p>
    </div>
  )
}

export default async function EstadoResultadosPage() {
  const [salesResult, cogsResult, familyResult, personnelResult, expensesResult, receivablesResult, cashFlowResult, nonPnlResult, activeCompany] = await Promise.all([
    getFinanceSalesNet(2026),
    getFinanceCogs(2026),
    getFinanceSalesNetByFamily(2026),
    getFinancePersonnel(2026),
    getFinanceExpenses(2026),
    getFinanceReceivables(2026),
    getCashFlowDashboard(2026, 12, undefined, 1, 'ALL', '', undefined, 'year', 'all').catch(() => null),
    getNonPnlCashData(2026).catch(() => null),
    getActiveCompany(),
  ])
  const sales = salesResult.ok ? salesResult.data : null
  const cogs = cogsResult.ok ? cogsResult.data : null
  const families = familyResult.ok ? familyResult.data.families : []
  const personnel = personnelResult.ok ? personnelResult.data : null
  const expenses = expensesResult.ok ? expensesResult.data : null
  const receivables = receivablesResult.ok ? receivablesResult.data : null
  const normalizedFamilies = familyResult.ok
    ? buildFinancialFamilyGroups(families, [])
    : { groups: [], individuals: [] }
  const hasInformation = hasStatementInformation(sales, cogs, personnel, expenses)
  const dataThrough = sales?.data_through ?? cogs?.data_through ?? null
  const reportThroughMonth = dataThrough && dataThrough.startsWith('2026-')
    ? Number(dataThrough.slice(5, 7))
    : 12
  const visiblePersonnelMonths = personnel?.coverage.availableMonths.filter(month => month <= reportThroughMonth) ?? []
  const commonCoverage = getCommonCoverage(sales, cogs, personnel, expenses)
  const rows = buildStatementRows(sales, cogs, personnel, reportThroughMonth, expenses)
  const finalResultRow = rows.find(row => row.label === 'RESULTADO GERENCIAL')
  const availablePeriod = dataThrough ? `hasta ${formatPeriod(dataThrough)}` : 'período disponible'
  const noDataError = !salesResult.ok
    ? { status: salesResult.status, message: salesResult.message }
    : !cogsResult.ok
      ? { status: cogsResult.status, message: cogsResult.message }
       : { status: 503, message: 'No hay datos financieros disponibles para este período.' }
  const cogsCoverageNote = cogs?.months.some(month => (month.coverage_status === 'INCOMPLETE' || Number(month.missing_document_count ?? 0) > 0) && month.month === 9)
    || cogs?.months.some(month => (month.coverage_status === 'INCOMPLETE' || Number(month.missing_document_count ?? 0) > 0) && month.month === 10)
    ? 'Costo de Ventas: septiembre con cobertura incompleta; octubre pendiente de actualización de costos.'
    : null

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-4 sm:px-7 sm:py-5">
      <section className="border border-[#D1C7BD] bg-[#FCFBF9] p-3 shadow-[0_8px_24px_rgba(50,45,41,0.05)] sm:p-4">
        <div className="flex items-center justify-between gap-3 border-b border-[#D1C7BD] pb-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Estado de Resultados</p>
            <h2 className="truncate text-lg font-semibold tracking-[-0.03em] text-[#322D29]">Estado de Resultados por período</h2>
          </div>
            <div className="flex shrink-0 items-center gap-2"><p className="text-[11px] text-[#322D29]/60">2026</p><EstadoResultadosExcelButton year={2026} coverage={[
             ...(dataThrough ? [`Datos hasta ${formatPeriod(dataThrough)}`] : []),
             ...(sales ? [`Ventas ${availablePeriod}`] : []),
             ...(personnel ? [`Remuneraciones hasta ${visiblePersonnelMonths.length ? `${MONTHS[visiblePersonnelMonths[visiblePersonnelMonths.length - 1] - 1].toLowerCase()}-2026` : 'ningún mes'}`] : []),
             ...(expenses ? [`Gastos bancarios hasta ${expenses.coverage.latestAvailableMonth ? `${MONTHS[expenses.coverage.latestAvailableMonth - 1].toLowerCase()}-2026` : 'ningún mes'}`] : []),
             ...(cogs ? [`Costo de Ventas actualizado hasta ${cogs.data_through ? formatPeriod(cogs.data_through) : 'sin fecha'} · Pendientes: ${cogs.ytd.missing_document_count ?? 0}`] : []),
             `Cobertura común: ${commonCoverage.text}`,
             ...(cogsCoverageNote ? [cogsCoverageNote] : []),
            ]} coverageNotes={cogsCoverageNote ? [cogsCoverageNote] : []} tradeName={getFinancialTradeName(activeCompany)} companyName={getFinancialCompanyDisplayName(activeCompany)} rows={rows} groups={normalizedFamilies.groups} nonPnl={nonPnlResult} currentBalance={cashFlowResult?.currentBalance ?? null} accountBalances={cashFlowResult?.accountBalances ?? []} receivables={receivables} /></div>
         </div>

         <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[#322D29]/60">
           <span>CLP</span>
           {dataThrough && <span>Datos {formatPeriod(dataThrough)}</span>}
           {sales && <span>Ventas {availablePeriod.replace('hasta ', '')}</span>}
           {personnel && <span>Remuneraciones {visiblePersonnelMonths.length ? MONTHS[visiblePersonnelMonths[visiblePersonnelMonths.length - 1] - 1] : '—'}</span>}
           {expenses && <span>Gastos {expenses.coverage.latestAvailableMonth ? MONTHS[expenses.coverage.latestAvailableMonth - 1] : '—'}</span>}
           {cogs && <span>Costo de Ventas {cogs.data_through ? formatPeriod(cogs.data_through) : '—'} · Pendientes {cogs.ytd.missing_document_count ?? 0}</span>}
           <span>Resultado común {commonCoverage.text}</span>
         </div>

         <div className="mt-2">
          {!expensesResult.ok && (
            <p className="mb-3 border border-[#A45B58]/30 bg-[#F8EDEA] px-3 py-2 text-xs text-[#8A4B4B]">
              No se pudieron cargar los gastos identificados. El Estado de Resultados está incompleto.
            </p>
          )}
          {!hasInformation ? (
            <ApiError status={noDataError.status} message={noDataError.message} />
          ) : (
            <>
            {(!salesResult.ok || !cogsResult.ok) && (
              <p className="mb-3 text-xs text-[#72383D]">
                {salesResult.ok ? 'Costo de Ventas no disponible; Margen Bruto no se calcula.' : 'Ventas Netas no disponibles; Margen Bruto no se calcula.'}
              </p>
            )}
             {expenses && Number(expenses.pendingHistoricalAmount ?? 0) > 0 && (
              <p className="mb-3 text-[10px] text-[#322D29]/60">
                Pendiente histórico no incluido: {formatClp(expenses.pendingHistoricalAmount)}
              </p>
             )}
             <ManagerialLiquidityCards
               resultYtd={finalResultRow?.ytd ?? null}
               marginYtd={finalResultRow?.percentageYtd ?? null}
               data={nonPnlResult}
               currentBalance={cashFlowResult?.currentBalance ?? null}
               accountBalances={cashFlowResult?.accountBalances ?? []}
               year={2026}
             />
             <FinancialMatrix
               rows={rows}
               groups={normalizedFamilies.groups}
               companyId={familyResult.ok ? familyResult.data.company_id : ''}
                 year={2026}
                 horizonMonth={reportThroughMonth}
                 familyUnavailable={!familyResult.ok}
               />
              {nonPnlResult && <NonPnlCashSection data={nonPnlResult} currentBalance={cashFlowResult?.currentBalance ?? null} year={2026} />}
              {nonPnlResult && <CreditLineControlSection data={nonPnlResult} accountBalances={cashFlowResult?.accountBalances ?? []} year={2026} />}
              {receivables && <ReceivablesSection data={receivables} year={2026} />}
            {cogs && <p className="mt-3 text-[10px] text-[#322D29]/60">Costo de Ventas = costo bruto menos reversión COGS de Notas de Crédito. Los indicadores señalan períodos con cobertura incompleta.</p>}
            </>
          )}
        </div>
      </section>
    </main>
  )
}
