import { getFinanceCogs, getFinanceExpenses, getFinancePersonnel, getFinanceProviderCogs, getFinanceReceivables, getFinanceReceivablesAnalysis, getFinanceSalesNet, getFinanceSalesNetByFamily } from '@/lib/control-financiero/finance-api'
import { applyProviderProfit, providerProfitabilityLoadState } from '@/lib/control-financiero/provider-profit'
import { getCollectionPaymentOverlay } from '@/app/actions/comercial/cobranza-workflow'
import { buildCurrentCobranzaPosition } from '@/lib/control-financiero/current-cobranza-position'
import { buildResultVsCashReport } from '@/lib/control-financiero/result-vs-cash'
import { getActiveCompany } from '@/app/actions/companies'
import { getCashFlowDashboard } from '@/app/actions/control-financiero/bank-statements'
import { getNonPnlCashData } from '@/app/actions/control-financiero/non-pnl-cash'
import { buildFinancialFamilyGroups } from '@/lib/control-financiero/family-groups'
import { accrueOpenMonthPersonnel, buildStatementRows, getConfirmedCoverage, getManagerialAsOfDate, getManagerialCoverage, hasStatementInformation } from '@/lib/control-financiero/statement'
import { todayInSantiago } from '@/lib/datetime'
import { FinancialMatrix } from '../financial-matrix'
import { CreditLineControlSection, ManagerialLiquidityCards, NonPnlCashSection, ResultVsCashSection } from '../non-pnl-cash-section'
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
  const [salesResult, cogsResult, familyResult, providerCogsResult, personnelResult, expensesResult, receivablesResult, currentCollectionResult, cashFlowResult, nonPnlResult, activeCompany] = await Promise.all([
    getFinanceSalesNet(2026),
    getFinanceCogs(2026),
    getFinanceSalesNetByFamily(2026),
    getFinanceProviderCogs(2026),
    getFinancePersonnel(2026),
    getFinanceExpenses(2026),
    getFinanceReceivables(2026),
    getFinanceReceivablesAnalysis(2026, 0),
    getCashFlowDashboard(2026, 12, undefined, 1, 'ALL', '', undefined, 'year', 'all', 5000, true).catch(() => null),
    getNonPnlCashData(2026).catch(() => null),
    getActiveCompany(),
  ])
  // Never publish a finished report (or export) with an empty provider fallback.
  // loading.tsx remains visible until the complete request and its bounded retry settle.
  if (!familyResult.ok) {
    return <main className="min-h-[430px] w-full min-w-0 bg-[#EFE9E1] px-5 py-4 sm:px-7 sm:py-5">
      <ApiError status={familyResult.status} message={`No se pudo completar la carga de ventas por proveedor. ${familyResult.message}`} />
    </main>
  }
  if (!providerCogsResult.ok) {
    return <main className="min-h-[430px] w-full min-w-0 bg-[#EFE9E1] px-5 py-4 sm:px-7 sm:py-5">
      <ApiError status={providerCogsResult.status} message={`Rentabilidad no disponible. Reintenta el módulo para volver a cargar el COGS real por proveedor y familia. ${providerCogsResult.message}`} />
    </main>
  }
  const profitabilityState = providerProfitabilityLoadState(
    familyResult.data.totals.ytd,
    familyResult.data.families.length,
    providerCogsResult.data.providers,
    providerCogsResult.data.families,
  )
  if (profitabilityState === 'INCOMPLETE') {
    return <main className="min-h-[430px] w-full min-w-0 bg-[#EFE9E1] px-5 py-4 sm:px-7 sm:py-5">
      <ApiError status={503} message="Rentabilidad no disponible. El COGS por proveedor y familia llegó vacío; reintenta el módulo." />
    </main>
  }
  const sales = salesResult.ok ? salesResult.data : null
  const cogs = cogsResult.ok ? cogsResult.data : null
  const families = familyResult.ok ? familyResult.data.families : []
  const today = todayInSantiago()
  const personnel = accrueOpenMonthPersonnel(personnelResult.ok ? personnelResult.data : null, sales, cogs, today)
  const managerialAsOfDate = getManagerialAsOfDate(sales, cogs, today)
  const openMonthAccrued = personnel?.months.some(month => month.estimateAsOfDate === managerialAsOfDate) ?? false
  const expenses = expensesResult.ok ? expensesResult.data : null
  const receivables = receivablesResult.ok ? receivablesResult.data : null
  // Cobranza uses this exact period-0 analysis plus confirmed payments after its snapshot.
  const collectionAnalysis = currentCollectionResult.ok ? currentCollectionResult.data : null
  const collectionOverlay = collectionAnalysis
    ? await getCollectionPaymentOverlay([...new Set(collectionAnalysis.documents.map(document => document.client_id))], collectionAnalysis.snapshot_at).catch(() => null)
    : null
  const currentCollection = collectionAnalysis && collectionOverlay !== null
    ? buildCurrentCobranzaPosition(collectionAnalysis, collectionOverlay) : null
  const currentCollectionAnalysis = collectionAnalysis && currentCollection ? {
    ...collectionAnalysis,
    summary: { ...collectionAnalysis.summary,
      receivable_amount: String(currentCollection.defaultScope.receivableAmount),
      overdue_amount: String(currentCollection.defaultScope.overdueAmount),
      closing_receivable_amount: String(currentCollection.defaultScope.receivableAmount),
      closing_overdue_amount: String(currentCollection.defaultScope.overdueAmount),
      pending_documents: currentCollection.visibleDocumentCount,
      clients: currentCollection.defaultScope.clientCount,
    },
    documents: currentCollection.documents,
  } : null
  const normalizedFamilies = familyResult.ok
    ? buildFinancialFamilyGroups(families, [])
    : { groups: [], individuals: [] }
  // Provider gross margin is derived from the provider COGS endpoint (already validated COGS
  // engine). Rows without a resolved provider COGS fall back to "—" instead of a fabricated margin.
  const groups = applyProviderProfit(
    normalizedFamilies.groups,
    providerCogsResult.data.providers,
    providerCogsResult.data.families,
  )
  const hasInformation = hasStatementInformation(sales, cogs, personnel, expenses)
  const dataThrough = sales?.data_through ?? cogs?.data_through ?? null
  const reportThroughMonth = dataThrough && dataThrough.startsWith('2026-')
    ? Number(dataThrough.slice(5, 7))
    : 12
  const visiblePersonnelMonths = personnel?.coverage.availableMonths.filter(month => month <= reportThroughMonth) ?? []
  const confirmedCoverage = getConfirmedCoverage(sales, cogs, personnel, expenses)
  const commonCoverage = getManagerialCoverage(sales, cogs, personnel, expenses)
  const rows = buildStatementRows(sales, cogs, personnel, reportThroughMonth, expenses)
  const finalResultRow = rows.find(row => row.label === 'RESULTADO GERENCIAL')
  const resultVsCash = buildResultVsCashReport({
    resultYtd: finalResultRow?.ytd ?? null,
    resultEstimated: finalResultRow?.ytdEstimated ?? false,
    resultCoverage: commonCoverage.text,
    resultAsOfDate: openMonthAccrued ? managerialAsOfDate : null,
    resultThroughMonth: commonCoverage.throughMonth,
    bankBalance: cashFlowResult?.currentBalance ?? null,
    accountBalances: cashFlowResult?.accountBalances ?? [],
    nonPnl: nonPnlResult,
    collection: currentCollection,
    year: 2026,
  })
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
    <main className="min-h-[430px] w-full min-w-0 bg-[#EFE9E1] px-2 py-4 sm:px-4 sm:py-5 2xl:px-7">
      <section className="w-full min-w-0 border border-[#D1C7BD] bg-[#FCFBF9] p-3 shadow-[0_8px_24px_rgba(50,45,41,0.05)] sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D1C7BD] pb-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Estado de Resultados</p>
            <h2 className="text-lg font-semibold tracking-[-0.03em] text-[#322D29]">Estado de Resultados por período</h2>
          </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2"><p className="text-[11px] text-[#322D29]/60">2026</p><EstadoResultadosExcelButton year={2026} coverage={[
             ...(dataThrough ? [`Datos hasta ${formatPeriod(dataThrough)}`] : []),
             ...(sales ? [`Ventas ${availablePeriod}`] : []),
             ...(personnel ? [`Remuneraciones hasta ${visiblePersonnelMonths.length ? `${MONTHS[visiblePersonnelMonths[visiblePersonnelMonths.length - 1] - 1].toLowerCase()}-2026` : 'ningún mes'}`] : []),
              ...(expenses ? [`Gastos bancarios hasta ${expenses.coverage.latestAvailableMonth ? `${MONTHS[expenses.coverage.latestAvailableMonth - 1].toLowerCase()}-2026` : 'ningún mes'}`] : []),
              ...(expenses?.dataThrough ? [`Último movimiento bancario: ${formatPeriod(expenses.dataThrough)}; no limita la fecha de devengo`] : []),
             ...(cogs ? [`Costo de Ventas actualizado hasta ${cogs.data_through ? formatPeriod(cogs.data_through) : 'sin fecha'} · Pendientes: ${cogs.ytd.missing_document_count ?? 0}`] : []),
              `Cobertura confirmada: ${confirmedCoverage.text}`,
              `Cobertura gerencial: ${commonCoverage.text}`,
               `Meses estimados: ${personnel?.months.filter(month => month.status === 'ESTIMATED' && commonCoverage.months.includes(month.month)).map(month => MONTHS[month.month - 1]).join(', ') || 'ninguno'}`,
               ...(openMonthAccrued ? [`Mes abierto: estimado al ${formatPeriod(managerialAsOfDate)}; remuneraciones y cargas devengadas proporcionalmente hasta esa fecha`] : []),
             ...(cogsCoverageNote ? [cogsCoverageNote] : []),
              ]} coverageNotes={cogsCoverageNote ? [cogsCoverageNote] : []} tradeName={getFinancialTradeName(activeCompany)} companyName={getFinancialCompanyDisplayName(activeCompany)} cutoffDate={dataThrough ?? cashFlowResult?.currentDate ?? null} rows={rows} groups={groups} nonPnl={nonPnlResult} currentBalance={cashFlowResult?.currentBalance ?? null} accountBalances={cashFlowResult?.accountBalances ?? []} cashFlowAccounts={cashFlowResult?.accounts ?? []} cashFlowMovements={cashFlowResult?.movements ?? []} receivables={receivables} currentCollection={currentCollection} /><ResultVsCashSection report={resultVsCash} /></div>
         </div>

         <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[#322D29]/60">
           <span>CLP</span>
           {dataThrough && <span>Datos {formatPeriod(dataThrough)}</span>}
           {sales && <span>Ventas {availablePeriod.replace('hasta ', '')}</span>}
           {personnel && <span>Remuneraciones {visiblePersonnelMonths.length ? MONTHS[visiblePersonnelMonths[visiblePersonnelMonths.length - 1] - 1] : '—'}</span>}
            {expenses && <span>Gastos {expenses.coverage.latestAvailableMonth ? MONTHS[expenses.coverage.latestAvailableMonth - 1] : '—'}</span>}
            {expenses?.dataThrough && <span>Último movimiento bancario {formatPeriod(expenses.dataThrough)}</span>}
           {cogs && <span>Costo de Ventas {cogs.data_through ? formatPeriod(cogs.data_through) : '—'} · Pendientes {cogs.ytd.missing_document_count ?? 0}</span>}
            <span>Confirmado {confirmedCoverage.text} · Gerencial {commonCoverage.text}</span>
             {finalResultRow?.ytdEstimated && <span className="font-semibold text-[#1453A0]">{openMonthAccrued ? `Resultado estimado al ${formatPeriod(managerialAsOfDate)} · remuneraciones devengadas proporcionalmente` : 'Resultado gerencial estimado · Promedio móvil 6 meses'}</span>}
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
                estimated={finalResultRow?.ytdEstimated ?? false}
                confirmedYtd={finalResultRow?.confirmedYtd ?? null}
                confirmedMarginYtd={finalResultRow?.confirmedPercentageYtd ?? null}
                confirmedCoverage={confirmedCoverage.text}
                managerialCoverage={commonCoverage.text}
                estimatedMonths={personnel?.months.filter(month => month.status === 'ESTIMATED' && commonCoverage.months.includes(month.month)).map(month => MONTHS[month.month - 1]) ?? []}
               data={nonPnlResult}
               currentBalance={cashFlowResult?.currentBalance ?? null}
               accountBalances={cashFlowResult?.accountBalances ?? []}
               year={2026}
              />
              <FinancialMatrix
               rows={rows}
               groups={groups}
               companyId={familyResult.ok ? familyResult.data.company_id : ''}
                 year={2026}
                  horizonMonth={reportThroughMonth}
                  dataThrough={dataThrough}
                  managerialAsOfDate={openMonthAccrued ? managerialAsOfDate : null}
                 familyUnavailable={!familyResult.ok}
               />
               {nonPnlResult && <NonPnlCashSection data={nonPnlResult} currentBalance={cashFlowResult?.currentBalance ?? null} year={2026} />}
              {nonPnlResult && <CreditLineControlSection data={nonPnlResult} accountBalances={cashFlowResult?.accountBalances ?? []} year={2026} />}
               {receivables && <ReceivablesSection data={receivables} current={currentCollection} currentAnalysis={currentCollectionAnalysis} year={2026} today={today} />}
            {cogs && <p className="mt-3 text-[10px] text-[#322D29]/60">Costo de Ventas = costo bruto menos reversión COGS de Notas de Crédito. Los indicadores señalan períodos con cobertura incompleta.</p>}
            </>
          )}
        </div>
      </section>
    </main>
  )
}
