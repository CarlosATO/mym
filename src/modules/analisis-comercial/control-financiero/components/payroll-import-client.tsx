'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { confirmPayrollImportAction, previewPayrollFileAction, type PayrollImportHistoryItem, type PayrollPreviewResult } from '@/app/actions/control-financiero/payroll'

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

function clp(value: number | null | undefined) {
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value ?? 0)}`
}

function periodLabel(year: number | null, month: number | null) {
  return year && month ? `${MONTHS[month - 1] ?? 'Mes'} ${year}` : 'Período no determinado'
}

export function PayrollImportClient({ history, companyId }: { history: PayrollImportHistoryItem[]; companyId: string }) {
  const [year, setYear] = useState('2026')
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<Extract<PayrollPreviewResult, { ok: true }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'ready' | 'importing' | 'success' | 'error'>('idle')
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function analyze(selectedFile: File | null, selectedYear = year) {
    setFile(selectedFile)
    setResult(null)
    setError(null)
    if (!selectedFile) {
      setStatus('idle')
      return
    }
    const formData = new FormData()
    formData.set('companyId', companyId)
    formData.set('selectedYear', selectedYear)
    formData.set('file', selectedFile)
    setStatus('analyzing')
    startTransition(async () => {
      const response = await previewPayrollFileAction(formData)
      if (!response.ok) {
        setError(response.message)
        setStatus('error')
        return
      }
      setResult(response)
      setStatus('ready')
    })
  }

  function confirm() {
    if (!file || !result || !result.preview.validation.canImport || isPending) return
    const formData = new FormData()
    formData.set('companyId', companyId)
    formData.set('selectedYear', year)
    formData.set('file', file)
    setError(null)
    setStatus('importing')
    startTransition(async () => {
      const response = await confirmPayrollImportAction(formData)
      if (!response.ok) {
        setError(response.message)
        setStatus('error')
        return
      }
      setStatus('success')
      setResult(null)
      setFile(null)
      router.refresh()
    })
  }

  const preview = result?.preview
  const period = preview ? periodLabel(preview.file.selectedYear, preview.file.detectedMonth) : null

  return (
    <main className="min-h-[calc(100vh-8rem)] bg-[#EFE9E1] px-5 py-5 text-[#322D29] sm:px-7 sm:py-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#AC9C8D]/60 pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Carga controlada</p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em]">Libro de Remuneraciones</h2>
          <p className="mt-1 text-xs text-[#322D29]/60">Analiza el CSV antes de persistirlo. La confirmación siempre es explícita.</p>
        </div>
        <div className="text-right text-[11px] text-[#322D29]/60">Formato permitido: <strong>.csv</strong></div>
      </div>

      <section className="mt-5 grid gap-4 border border-[#D1C7BD] bg-white p-4 md:grid-cols-[180px_1fr_auto] md:items-end">
        <label className="block text-xs font-semibold">
          Año del período
          <select value={year} onChange={event => { setYear(event.target.value); if (file) analyze(file, event.target.value) }} className="mt-1.5 w-full border border-[#AC9C8D] bg-[#FBF9F6] px-3 py-2 text-sm">
            {[2026, 2025, 2027].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="flex min-h-10 cursor-pointer items-center border border-dashed border-[#72383D]/50 bg-[#FBF9F6] px-3 py-2 text-xs font-semibold hover:bg-white">
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={event => analyze(event.target.files?.[0] ?? null)} />
          <span>{file ? file.name : 'Seleccionar archivo CSV'}</span>
        </label>
        <span className="text-right text-[11px] text-[#322D29]/55">{status === 'analyzing' ? 'Analizando…' : status === 'importing' ? 'Importando…' : status === 'success' ? 'Importación completada' : 'Sin persistencia al seleccionar'}</span>
      </section>

      {error && <div className="mt-4 border border-[#A23E48]/35 bg-[#A23E48]/8 px-4 py-3 text-xs text-[#72383D]">{error}</div>}
      {status === 'success' && <div className="mt-4 border border-emerald-700/25 bg-emerald-700/8 px-4 py-3 text-xs text-emerald-900">Libro importado correctamente. No se modificaron Estado de Resultados ni Flujo de Caja.</div>}

      {preview && <PreviewPanel preview={preview} period={period ?? ''} idempotency={result.idempotency} onConfirm={confirm} disabled={isPending} />}

      {!preview && <History history={history} />}
    </main>
  )
}

function PreviewPanel({ preview, period, idempotency, onConfirm, disabled }: { preview: Extract<PayrollPreviewResult, { ok: true }>['preview']; period: string; idempotency: Extract<PayrollPreviewResult, { ok: true }>['idempotency']; onConfirm: () => void; disabled: boolean }) {
  const blocked = !preview.validation.canImport || idempotency.fileAlreadyImported || idempotency.periodAlreadyImported
  const metrics = [
    ['Trabajadores', preview.workers.workerCount.toLocaleString('es-CL')],
    ['Filas', preview.file.rowCount.toLocaleString('es-CL')],
    ['Sueldo base', clp(preview.totals.totalSalary)],
    ['Total haberes', clp(preview.totals.totalEarnings)],
    ['Total descuentos', clp(preview.totals.totalDeductions)],
    ['Total líquido', clp(preview.totals.totalNetPay)],
    ['Aportes empleador', clp(preview.totals.totalEmployerContributions)],
    ['Indemnizaciones', clp(preview.totals.totalIndemnities)],
    ['Costo laboral total', clp(preview.totals.totalLaborCost)],
    ['Costo laboral recurrente', clp(preview.totals.recurringLaborCost)],
  ]
  return <section className="mt-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#AC9C8D]/60 pb-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#72383D]">Preview</p><h3 className="mt-1 text-lg font-semibold">{period}</h3></div><p className="text-xs text-[#322D29]/60">{preview.file.filename} · {preview.file.encoding}</p></div>
    <div className="grid gap-px border border-[#D1C7BD] bg-[#D1C7BD] sm:grid-cols-2 lg:grid-cols-5">{metrics.map(([label, value]) => <div key={label} className="bg-white px-3 py-3"><p className="text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55">{label}</p><p className="mt-1 text-sm font-semibold tabular-nums">{value}</p></div>)}</div>
    {(preview.validation.errors.length > 0 || preview.validation.warnings.length > 0 || idempotency.previousVersions.length > 0) && <div className="grid gap-3 md:grid-cols-2">
      {preview.validation.errors.length > 0 && <ValidationList title="Bloqueos" values={preview.validation.errors} danger />}
      {preview.validation.warnings.length > 0 && <ValidationList title="Advertencias" values={preview.validation.warnings} />}
      {idempotency.previousVersions.length > 0 && <ValidationList title="Versiones anteriores" values={idempotency.previousVersions.map(version => `${version.status}: ${version.source_filename}`)} />}
    </div>}
    <div className="overflow-x-auto border border-[#D1C7BD] bg-white"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-[#F4F0EA] text-[10px] uppercase tracking-[0.08em] text-[#322D29]/60"><tr>{['RUT', 'Días', 'Sueldo', 'Gratificación', 'Haberes', 'Descuentos', 'Aportes empleador', 'Líquido', 'Costo laboral'].map(label => <th key={label} className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{preview.rows.map(row => <tr key={row.sourceRowNumber} className="border-t border-[#EEE8E0]"><td className="px-3 py-2 font-medium">{row.workerRutNormalized ?? '—'}</td><td className="px-3 py-2">{row.daysWorked ?? '—'}</td><td className="px-3 py-2 tabular-nums">{clp(row.salary)}</td><td className="px-3 py-2 tabular-nums">{clp(row.gratification)}</td><td className="px-3 py-2 tabular-nums">{clp(row.totalEarnings)}</td><td className="px-3 py-2 tabular-nums">{clp(row.totalDeductions)}</td><td className="px-3 py-2 tabular-nums">{clp(row.totalEmployerContributions)}</td><td className="px-3 py-2 tabular-nums">{clp(row.netPay)}</td><td className="px-3 py-2 tabular-nums">{clp((row.totalEarnings ?? 0) + (row.totalEmployerContributions ?? 0))}</td></tr>)}</tbody></table></div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#D1C7BD] pt-4"><p className="max-w-xl text-xs text-[#322D29]/60">El servidor volverá a leer y validar el archivo antes de insertar. No se aceptan totales enviados por el navegador.</p><button type="button" onClick={onConfirm} disabled={blocked || disabled} className="bg-[#72383D] px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{disabled ? 'Procesando…' : blocked ? 'Importación bloqueada' : 'Confirmar importación'}</button></div>
  </section>
}

function ValidationList({ title, values, danger = false }: { title: string; values: string[]; danger?: boolean }) {
  return <div className={`border px-4 py-3 ${danger ? 'border-[#A23E48]/30 bg-[#A23E48]/6' : 'border-[#D1C7BD] bg-white'}`}><p className="text-xs font-semibold">{title}</p><ul className="mt-2 space-y-1 text-xs text-[#322D29]/70">{values.map(value => <li key={value}>• {value}</li>)}</ul></div>
}

function History({ history }: { history: PayrollImportHistoryItem[] }) {
  return <section className="mt-6 border-t border-[#AC9C8D]/60 pt-5"><div className="flex items-end justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#72383D]">Trazabilidad</p><h3 className="mt-1 text-lg font-semibold">Historial de importaciones</h3></div><p className="text-xs text-[#322D29]/55">{history.length} registros</p></div>{history.length === 0 ? <p className="mt-4 border border-dashed border-[#AC9C8D]/70 bg-white/35 px-4 py-8 text-center text-xs text-[#322D29]/60">No hay importaciones de remuneraciones para esta empresa.</p> : <div className="mt-4 overflow-x-auto border border-[#D1C7BD] bg-white"><table className="w-full min-w-[700px] text-left text-xs"><thead className="bg-[#F4F0EA] text-[10px] uppercase tracking-[0.08em] text-[#322D29]/60"><tr>{['Período', 'Archivo', 'Fecha', 'Trabajadores', 'Costo laboral', 'Estado'].map(label => <th key={label} className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead><tbody>{history.map(item => <tr key={item.id} className="border-t border-[#EEE8E0]"><td className="px-3 py-2">{periodLabel(item.period_year, item.period_month)}</td><td className="px-3 py-2">{item.source_filename}</td><td className="px-3 py-2">{item.imported_at ? new Date(item.imported_at).toLocaleString('es-CL') : '—'}</td><td className="px-3 py-2">{item.worker_count}</td><td className="px-3 py-2 tabular-nums">{clp(item.total_labor_cost)}</td><td className="px-3 py-2">{item.status}</td></tr>)}</tbody></table></div>}</section>
}
