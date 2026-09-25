import { getFinanceSalesNet } from '@/lib/control-financiero/finance-api'

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function formatClp(value: string | null) {
  if (value === null) return '—'
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

function formatDate(value: string | null) {
  if (!value) return null
  const [, month, day] = value.split('-')
  return `${day}-${MONTHS[Number(month) - 1].toLowerCase()}-${value.slice(0, 4)}`
}

function ApiError({ status, message }: { status: number; message: string }) {
  const title = status === 403 ? 'Sin permiso para consultar Control Financiero' : 'No se pudieron cargar las ventas netas'
  return (
    <div className="border border-[#72383D]/25 bg-white/45 px-5 py-8">
      <p className="text-sm font-semibold text-[#72383D]">{title}</p>
      <p className="mt-2 text-xs leading-5 text-[#322D29]/65">{message}</p>
    </div>
  )
}

export default async function EstadoResultadosPage() {
  const result = await getFinanceSalesNet(2026)

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-5 sm:px-7 sm:py-6">
      <div className="flex items-end justify-between gap-4 border-b border-[#AC9C8D]/60 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Estado de Resultados</p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[#322D29]">Ventas netas</h2>
        </div>
        <p className="text-right text-[11px] text-[#322D29]/60">Año 2026</p>
      </div>

      <div className="mt-5">
        {!result.ok ? (
          <ApiError status={result.status} message={result.message} />
        ) : !result.data.has_information ? (
          <div className="border border-dashed border-[#AC9C8D]/70 bg-white/35 px-5 py-8">
            <p className="text-sm font-semibold text-[#322D29]">Sin datos de ventas para 2026</p>
            <p className="mt-2 text-xs text-[#322D29]/60">La fuente financiera no informó documentos para este período.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#322D29]/60">
              <span>Moneda: CLP</span>
              <span>Datos hasta {formatDate(result.data.data_through)}</span>
              <span>{result.data.documents_count.toLocaleString('es-CL')} documentos</span>
            </div>

            <div className="overflow-x-auto border border-[#D1C7BD] bg-white/45">
              <table className="min-w-[940px] w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#D1C7BD] bg-[#D1C7BD]/25 text-[10px] uppercase tracking-[0.1em] text-[#322D29]/65">
                    <th className="sticky left-0 z-10 bg-[#E7DED5] px-4 py-3 text-left font-bold">Concepto</th>
                    {MONTHS.map(month => <th key={month} className="px-3 py-3 text-right font-bold">{month}</th>)}
                    <th className="sticky right-0 z-10 border-l border-[#D1C7BD] bg-[#E7DED5] px-4 py-3 text-right font-bold text-[#72383D]">YTD</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-[#D1C7BD]/70">
                    <th className="sticky left-0 z-10 bg-[#EFE9E1] px-4 py-4 text-left font-semibold text-[#322D29]">Ventas netas</th>
                    {result.data.months.map(month => (
                      <td key={month.month} className="px-3 py-4 text-right tabular-nums text-[#322D29]">{formatClp(month.amount)}</td>
                    ))}
                    <td className="sticky right-0 z-10 border-l border-[#D1C7BD] bg-[#E7DED5] px-4 py-4 text-right font-semibold tabular-nums text-[#72383D]">{formatClp(result.data.total_ytd)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
