import { AlertCircle } from 'lucide-react'
import { getFinanceCogs, getFinanceSalesNet } from '@/lib/control-financiero/finance-api'
import { buildStatementRows, hasStatementInformation, type StatementRow } from '@/lib/control-financiero/statement'

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function formatClp(value: string | null) {
  if (value === null) return '—'
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`
}

function formatDate(value: string | null) {
  if (!value) return null
  const [, month, day] = value.split('-')
  return `${day}-${MONTHS[Number(month) - 1].toLowerCase()}-${value.slice(0, 4)}`
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

function CoverageIndicator({ count }: { count: number | null }) {
  if (!count) return null
  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 align-middle text-[9px] font-semibold text-[#72383D]"
      title={`Cobertura incompleta: ${count} documento${count === 1 ? '' : 's'} sin costo observado`}
      aria-label={`Cobertura incompleta: ${count} documento${count === 1 ? '' : 's'} sin costo observado`}
    >
      <AlertCircle className="h-3 w-3" aria-hidden="true" />
      {count}
    </span>
  )
}

function valueTone(value: string | null) {
  return value?.startsWith('-') ? 'text-[#A23E48]' : 'text-[#322D29]'
}

function FinancialMatrix({ rows }: { rows: StatementRow[] }) {
  return (
    <div className="overflow-x-auto border border-[#D1C7BD] bg-white/45">
      <table className="min-w-[1080px] w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-[#D1C7BD] bg-[#D1C7BD]/25 text-[10px] uppercase tracking-[0.1em] text-[#322D29]/65">
            <th className="sticky left-0 z-20 w-[260px] bg-[#E7DED5] px-4 py-3 text-left font-bold">Concepto</th>
            {MONTHS.map(month => <th key={month} className="px-3 py-3 text-right font-bold">{month}</th>)}
            <th className="sticky right-[76px] z-20 border-l border-[#D1C7BD] bg-[#E7DED5] px-4 py-3 text-right font-bold text-[#72383D]">YTD</th>
            <th className="sticky right-0 z-20 w-[76px] border-l border-[#D1C7BD] bg-[#E7DED5] px-3 py-3 text-right font-bold text-[#72383D]">% Ventas</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className={`border-b border-[#D1C7BD]/70 ${row.emphasis ? 'bg-[#D1C7BD]/15' : ''}`}>
              <th className={`sticky left-0 z-10 px-4 py-4 text-left ${row.emphasis ? 'bg-[#E7DED5] font-bold' : 'bg-[#EFE9E1] font-semibold'} text-[#322D29]`}>{row.label}</th>
              {row.values.map((value, index) => (
                <td key={`${row.label}-${index}`} className={`px-3 py-4 text-right tabular-nums ${valueTone(value)}`}>
                  {formatClp(value)}
                  <CoverageIndicator count={row.missing[index]} />
                </td>
              ))}
              <td className={`sticky right-[76px] z-10 border-l border-[#D1C7BD] px-4 py-4 text-right font-semibold tabular-nums ${row.emphasis ? 'bg-[#E7DED5]' : 'bg-[#E7DED5]'} ${valueTone(row.ytd)}`}>
                {formatClp(row.ytd)}
                <CoverageIndicator count={row.ytdMissing} />
              </td>
              <td className="sticky right-0 z-10 border-l border-[#D1C7BD] bg-[#E7DED5] px-3 py-4 text-right tabular-nums text-[#72383D]">
                {formatPercent(row.percentageYtd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function EstadoResultadosPage() {
  const [salesResult, cogsResult] = await Promise.all([getFinanceSalesNet(2026), getFinanceCogs(2026)])
  const sales = salesResult.ok ? salesResult.data : null
  const cogs = cogsResult.ok ? cogsResult.data : null
  const hasInformation = hasStatementInformation(sales, cogs)
  const dataThrough = sales?.data_through ?? cogs?.data_through ?? null
  const rows = buildStatementRows(sales, cogs)
  const noDataError = !salesResult.ok
    ? { status: salesResult.status, message: salesResult.message }
    : !cogsResult.ok
      ? { status: cogsResult.status, message: cogsResult.message }
      : { status: 503, message: 'No hay datos financieros disponibles para este período.' }

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-5 sm:px-7 sm:py-6">
      <div className="flex items-end justify-between gap-4 border-b border-[#AC9C8D]/60 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Estado de Resultados</p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#322D29]">Ventas, costo y margen bruto</h2>
        </div>
        <p className="text-right text-[11px] text-[#322D29]/60">Año 2026</p>
      </div>

      <div className="mt-5">
        {!hasInformation ? (
          <ApiError status={noDataError.status} message={noDataError.message} />
        ) : (
          <>
            {(!salesResult.ok || !cogsResult.ok) && (
              <div className="mb-3 border border-[#72383D]/25 bg-white/45 px-4 py-3 text-xs text-[#72383D]">
                {salesResult.ok ? 'Costo de Ventas no disponible; Margen Bruto no se calcula.' : 'Ventas Netas no disponibles; Margen Bruto no se calcula.'}
              </div>
            )}
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#322D29]/60">
              <span>Moneda: CLP</span>
              {dataThrough && <span>Datos hasta {formatDate(dataThrough)}</span>}
              {sales && <span>{sales.documents_count.toLocaleString('es-CL')} documentos de venta</span>}
              {cogs && <span>{cogs.ytd.observed_document_count?.toLocaleString('es-CL') ?? '—'} documentos con costo observado</span>}
            </div>
            <FinancialMatrix rows={rows} />
            {cogs && <p className="mt-3 text-[10px] text-[#322D29]/60">Costo de Ventas = costo bruto menos reversión COGS de Notas de Crédito. Los indicadores señalan períodos con cobertura incompleta.</p>}
          </>
        )}
      </div>
    </main>
  )
}
