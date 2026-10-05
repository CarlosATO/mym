import { getFinanceCogs, getFinanceExpenses, getFinancePersonnel, getFinanceReceivables, getFinanceSalesNet, getFinanceSalesNetByFamily } from '@/lib/control-financiero/finance-api'
import { buildFinancialFamilyGroups } from '@/lib/control-financiero/family-groups'
import { buildStatementRows, getCommonCoverage, hasStatementInformation } from '@/lib/control-financiero/statement'
import { FinancialMatrix } from '../financial-matrix'
import { ReceivablesSection } from '../receivables-drilldown'

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

function formatPercent(value: number | null) {
  return value === null ? '—' : `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`
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
  const [salesResult, cogsResult, familyResult, personnelResult, expensesResult, receivablesResult] = await Promise.all([
    getFinanceSalesNet(2026),
    getFinanceCogs(2026),
    getFinanceSalesNetByFamily(2026),
    getFinancePersonnel(2026),
    getFinanceExpenses(2026),
    getFinanceReceivables(2026),
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
  const kpiLabels = [
    'RESULTADO GERENCIAL',
    'RESULTADO OPERACIONAL',
    'Ventas Netas',
    'Margen Bruto',
    'Costo de Ventas',
    'GASTOS DE PERSONAL',
    'GASTOS OPERACIONALES IDENTIFICADOS',
    'GASTOS FINANCIEROS / NO OPERACIONALES',
  ]
  const kpiRows = kpiLabels.map(label => rows.find(row => row.label === label)).filter((row): row is NonNullable<typeof row> => Boolean(row))
  const availablePeriod = dataThrough ? `hasta ${formatPeriod(dataThrough)}` : 'período disponible'
  const noDataError = !salesResult.ok
    ? { status: salesResult.status, message: salesResult.message }
    : !cogsResult.ok
      ? { status: cogsResult.status, message: cogsResult.message }
      : { status: 503, message: 'No hay datos financieros disponibles para este período.' }

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-5 sm:px-7 sm:py-6">
      <section className="border border-[#D1C7BD] bg-[#FCFBF9] p-4 shadow-[0_8px_24px_rgba(50,45,41,0.05)] sm:p-5">
        <div className="flex items-end justify-between gap-4 border-b border-[#D1C7BD] pb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Estado de Resultados</p>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#322D29]">Estado de Resultados por período</h2>
          </div>
          <p className="text-right text-[11px] text-[#322D29]/60">Año 2026</p>
        </div>

        <div className="mt-5">
          {!hasInformation ? (
            <ApiError status={noDataError.status} message={noDataError.message} />
          ) : (
            <>
            {(!salesResult.ok || !cogsResult.ok) && (
              <p className="mb-3 text-xs text-[#72383D]">
                {salesResult.ok ? 'Costo de Ventas no disponible; Margen Bruto no se calcula.' : 'Ventas Netas no disponibles; Margen Bruto no se calcula.'}
              </p>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#322D29]/60">
              <span>CLP</span>
              {dataThrough && <span>Datos hasta {formatPeriod(dataThrough)}</span>}
              {sales && <span>Ventas {availablePeriod}</span>}
              {personnel && <span>Remuneraciones hasta {visiblePersonnelMonths.length ? `${MONTHS[visiblePersonnelMonths[visiblePersonnelMonths.length - 1] - 1].toLowerCase()}-2026` : 'ningún mes'}</span>}
              {expenses && <span>Gastos bancarios hasta {expenses.coverage.latestAvailableMonth ? `${MONTHS[expenses.coverage.latestAvailableMonth - 1].toLowerCase()}-2026` : 'ningún mes'}</span>}
              <span>Resultado común {commonCoverage.text}</span>
            </div>
            {expenses && Number(expenses.pendingHistoricalAmount ?? 0) > 0 && (
              <p className="mb-3 text-[10px] text-[#322D29]/60">
                Pendiente histórico no incluido: {formatClp(expenses.pendingHistoricalAmount)}
              </p>
            )}
            <div className="mb-4 grid items-stretch gap-1.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              {kpiRows.map(row => {
                const managerial = row.label === 'RESULTADO GERENCIAL'
                const result = row.result
                const title = row.label === 'RESULTADO GERENCIAL'
                  ? 'Resultado final del período'
                  : row.label === 'RESULTADO OPERACIONAL'
                    ? 'Resultado del negocio'
                    : row.label
                const subtitle = row.label === 'RESULTADO GERENCIAL'
                  ? 'Después de gastos financieros'
                  : row.label === 'RESULTADO OPERACIONAL'
                    ? 'Antes de gastos financieros'
                    : result ? row.ytdLabel : availablePeriod
                return (
                  <div key={row.label} className={`flex min-h-[104px] min-w-0 flex-col justify-between border px-2.5 py-2 ${managerial ? 'border-[#72383D] bg-[#F1E4DE] shadow-sm' : result ? 'border-[#AC9C8D] bg-[#F6EEE9]' : 'border-[#D1C7BD] bg-white'}`}>
                    <div>
                      <p className={`break-words text-[9px] font-bold leading-3 tracking-[0.03em] ${managerial ? 'text-[#72383D]' : result ? 'text-[#72383D]/80' : 'uppercase tracking-[0.08em] text-[#AC9C8D]'}`}>{title}</p>
                      <p className="mt-1 min-h-[20px] text-[8px] font-semibold uppercase leading-2.5 tracking-[0.04em] text-[#72383D]/70">{subtitle}</p>
                    </div>
                    <div className="mt-2">
                      <p className={`font-semibold tabular-nums ${managerial || result ? 'text-lg' : 'text-base'} ${row.ytd?.startsWith('-') ? 'text-[#A23E48]' : 'text-[#322D29]'}`}>{formatClp(row.ytd)}</p>
                      <p className="mt-0.5 text-[8px] leading-2.5 text-[#322D29]/60">{row.percentageYtd === null ? 'Sin porcentaje disponible' : `${formatPercent(row.percentageYtd)} ${row.percentageLabel ?? 'sobre ventas'}`}</p>
                    </div>
                  </div>
                )
              })}
            </div>
             <FinancialMatrix
               rows={rows}
               groups={normalizedFamilies.groups}
               companyId={familyResult.ok ? familyResult.data.company_id : ''}
                 year={2026}
                 horizonMonth={reportThroughMonth}
                 familyUnavailable={!familyResult.ok}
              />
             {receivables && <ReceivablesSection data={receivables} year={2026} />}
            {cogs && <p className="mt-3 text-[10px] text-[#322D29]/60">Costo de Ventas = costo bruto menos reversión COGS de Notas de Crédito. Los indicadores señalan períodos con cobertura incompleta.</p>}
            </>
          )}
        </div>
      </section>
    </main>
  )
}
