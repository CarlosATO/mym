'use client'

import { Fragment, useCallback, useMemo, useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Send, ShieldAlert } from 'lucide-react'
import {
  applyActiveCompanyCampaignLogistics,
  getActiveCompanyCampaignLogisticsItemDetail,
  getActiveCompanyCampaignLogisticsReconciliation,
  refreshActiveCompanyCampaignLogisticsReconciliation,
  type LogisticsCampaignDetail,
  type LogisticsReconciliationData,
  type LogisticsReconciliationProduct,
} from '@/app/actions/inventarios/logistics-reconciliation'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface Props {
  campaignId: string
  initialData: LogisticsReconciliationData
}

const REASON_LABELS: Record<string, string> = {
  BSALE_STOCK_UNAVAILABLE: 'No hay stock Bsale disponible para esta lectura',
  BSALE_STALE: 'La lectura Bsale quedó desactualizada',
  CAMPAIGN_NOT_APPROVED: 'El Inventario no está aprobado',
  SOURCE_SESSION_NOT_APPROVED: 'Una jornada del Inventario no está aprobada',
  MISSING_OFFICIAL_VERSION: 'Falta resultado oficial de una jornada',
  MULTIPLE_CURRENT_OFFICIAL_VERSIONS: 'Hay múltiples resultados oficiales vigentes',
  UNRESOLVED_RECOUNT: 'Recuento sin distribución resoluble',
  UNMAPPED_PRODUCT: 'Producto sin mapeo logístico',
  UNMAPPED_LOCATION: 'Ubicación sin mapeo a Logística',
  INACTIVE_LOCATION: 'Ubicación logística inactiva',
  NON_AVAILABLE_PHYSICAL_STOCK: 'Contiene stock dañado o no disponible',
  LOT_OR_EXPIRY_UNSUPPORTED: 'Lote o vencimiento no soportado',
  UNREPRESENTED_LOGISTICS_STOCK: 'Hay stock logístico no representado',
  MISSING_OFFICIAL_LOCATION: 'Falta resultado oficial por ubicación',
  LOCATION_OUT_OF_SCOPE: 'Ubicación fuera del alcance del Inventario',
  DUPLICATE_LOGISTICS_LOCATION: 'Hay múltiples líneas para una ubicación',
  RECONCILIATION_NOT_READY: 'La conciliación aún no está READY',
}

function quantity(value: number | null) {
  return value === null ? '—' : value.toLocaleString('es-CL', { maximumFractionDigits: 3 })
}

function tone(status: string) {
  if (status === 'READY') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'MISMATCH') return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (status === 'STALE') return 'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300'
  if (status === 'BLOCKED') return 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300'
  if (status === 'APPLIED') return 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
  return 'border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300'
}

function StatusPill({ status }: { status: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone(status)}`}>{status}</span>
}

function Reasons({ reasons }: { reasons: string[] }) {
  return reasons.length === 0
    ? <span className="text-xs text-theme-text-muted">Sin bloqueos</span>
    : <ul className="space-y-0.5 text-xs text-red-700 dark:text-red-300">{reasons.map(reason => <li key={reason}>{REASON_LABELS[reason] ?? reason}</li>)}</ul>
}

function SummaryCard({ label, value, color = 'text-theme-text' }: { label: string; value: number; color?: string }) {
  return <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted/65">{label}</p><p className={`mt-1 text-xl font-bold ${color}`}>{value}</p></div>
}

function canApply(product: LogisticsReconciliationProduct) {
  return product.reconciliation_status === 'READY' && product.logistics_applicability_status === 'READY' && product.logistics_application_status === 'NOT_APPLIED'
}

function Detail({ detail, pending }: { detail: LogisticsCampaignDetail; pending: boolean }) {
  return (
    <div className="space-y-3">
      {detail.lines.length === 0 ? <p className="text-xs text-theme-text-muted">No hay líneas de ubicación publicadas para este item.</p> : (
        <div className="overflow-x-auto rounded-lg border border-theme-border/70">
          <table className="w-full min-w-[980px] text-xs">
            <thead><tr className="border-b border-theme-border/60 text-left uppercase tracking-wider text-theme-text-muted/60"><th className="px-3 py-2">Procedencia</th><th className="px-3 py-2 text-right">Target</th><th className="px-3 py-2 text-right">Anterior</th><th className="px-3 py-2 text-right">Delta</th><th className="px-3 py-2">Resultado</th><th className="px-3 py-2">Referencias</th></tr></thead>
            <tbody>{detail.lines.map(line => <tr key={line.id} className="border-b border-theme-border/40 last:border-0 align-top">
              <td className="px-3 py-2"><p className="font-medium text-theme-text">{line.session_name ?? 'Jornada sin nombre'}</p><p className="text-theme-text-muted">{line.warehouse_name ?? 'Bodega sin nombre'} · {line.logistics_location_code ?? 'Ubicación sin código'}{line.logistics_location_name ? ` · ${line.logistics_location_name}` : ''}</p></td>
              <td className="px-3 py-2 text-right text-theme-text">{quantity(line.target_quantity)}</td><td className="px-3 py-2 text-right text-theme-text-muted">{quantity(line.previous_balance)}</td><td className="px-3 py-2 text-right font-semibold text-theme-text">{quantity(line.delta)}</td>
              <td className="px-3 py-2">{line.application_result ? <StatusPill status={line.application_result === 'NO_OP' ? 'APPLIED' : line.application_result} /> : <span className="text-theme-text-muted">Sin aplicar</span>}{line.applied_at && <p className="mt-1 text-theme-text-muted">{formatDateTimeChile(line.applied_at)}</p>}</td>
              <td className="px-3 py-2 text-theme-text-muted">{line.adjustment_id || line.adjustment_item_id || line.kardex_movement_id ? <div className="space-y-0.5">{line.adjustment_id && <p>Ajuste: {line.adjustment_id}</p>}{line.adjustment_item_id && <p>Ítem: {line.adjustment_item_id}</p>}{line.kardex_movement_id && <p>Kardex: {line.kardex_movement_id}</p>}</div> : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {pending && <div className="flex items-center gap-2 text-xs text-theme-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando detalle…</div>}
    </div>
  )
}

export function InventoryLogisticsReconciliation({ campaignId, initialData }: Props) {
  const [data, setData] = useState(initialData)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, LogisticsCampaignDetail>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const selectable = useMemo(() => data.products.filter(canApply), [data.products])
  const selectedProducts = useMemo(() => data.products.filter(product => selected.has(product.id) && canApply(product)), [data.products, selected])

  const load = useCallback(async () => {
    const result = await getActiveCompanyCampaignLogisticsReconciliation(campaignId)
    if (result.error || !result.data) { setError(result.error ?? 'No se pudo actualizar la conciliación.'); return }
    setData(result.data)
    setSelected(current => new Set([...current].filter(id => result.data!.products.some(product => product.id === id && canApply(product)))))
    setDetails({})
    setError(null)
  }, [campaignId])

  const refresh = () => { setError(null); setNotice(null); startTransition(async () => { const result = await refreshActiveCompanyCampaignLogisticsReconciliation(campaignId); if (!result.success) { setError(result.error ?? 'No se pudo actualizar la conciliación.'); return } await load(); setNotice('Conciliación actualizada con la última lectura de Bsale.') }) }
  const apply = (ids: string[]) => {
    const validIds = data.products.filter(product => ids.includes(product.id) && canApply(product)).map(product => product.id)
    if (validIds.length === 0) return
    if (!window.confirm(`Se enviarán ${validIds.length} item${validIds.length === 1 ? '' : 's'} a Logística. ¿Continuar?`)) return
    setError(null); setNotice(null); startTransition(async () => { const result = await applyActiveCompanyCampaignLogistics(campaignId, validIds); if (!result.success) { setError(result.error ?? 'No se pudo aplicar la conciliación.'); return } await load(); setNotice('Aplicación ejecutada. La conciliación fue refrescada.') })
  }
  const toggleDetail = (id: string) => { if (expanded === id) { setExpanded(null); return } setExpanded(id); if (details[id]) return; startTransition(async () => { const result = await getActiveCompanyCampaignLogisticsItemDetail(campaignId, id); if (result.error) setError(result.error); else if (result.data) setDetails(current => ({ ...current, [id]: result.data! })) }) }

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-base font-bold text-theme-text">Conciliación logística del Inventario</h2><p className="mt-1 text-xs text-theme-text-muted">Consolida todas las jornadas aprobadas. Solo los items READY y logísticamente READY pueden enviarse a Logística.</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={refresh} disabled={pending} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} /> Actualizar Bsale</button><button type="button" onClick={() => apply(selectable.map(product => product.id))} disabled={pending || selectable.length === 0} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-3.5 w-3.5" /> Aplicar todos READY ({selectable.length})</button></div></div>
    {error && <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}{notice && <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"><SummaryCard label="Total" value={data.summary.item_count} /><SummaryCard label="READY" value={data.summary.ready_count} color="text-emerald-600 dark:text-emerald-400" /><SummaryCard label="MISMATCH" value={data.summary.mismatch_count} color="text-amber-600 dark:text-amber-400" /><SummaryCard label="BLOCKED" value={data.summary.blocked_count} color="text-red-600 dark:text-red-400" /><SummaryCard label="STALE" value={data.summary.stale_count} color="text-orange-600 dark:text-orange-400" /><SummaryCard label="APPLIED" value={data.summary.applied_count} color="text-violet-600 dark:text-violet-400" /></div>
    {selectedProducts.length > 0 && <div className="flex flex-col gap-2 rounded-lg border border-theme-accent/25 bg-theme-accent/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm font-medium text-theme-text">{selectedProducts.length} item{selectedProducts.length === 1 ? '' : 's'} READY seleccionado{selectedProducts.length === 1 ? '' : 's'}.</span><button type="button" onClick={() => apply(selectedProducts.map(product => product.id))} disabled={pending} className="inline-flex h-7 items-center justify-center gap-1 rounded-md bg-theme-accent px-2.5 text-xs font-semibold text-white disabled:opacity-50"><Send className="h-3 w-3" /> Aplicar seleccionados</button></div>}
    <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm"><div className="overflow-x-auto"><table className="w-full min-w-[1250px] border-collapse text-sm"><thead><tr className="border-b border-theme-border/60 text-left text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted/65"><th className="w-10 px-3 py-2.5" /><th className="px-3 py-2.5">SKU / Producto</th><th className="px-3 py-2.5">Oficina Bsale</th><th className="px-3 py-2.5 text-right">Físico</th><th className="px-3 py-2.5 text-right">Bsale</th><th className="px-3 py-2.5 text-right">Diferencia</th><th className="px-3 py-2.5">Conciliación</th><th className="px-3 py-2.5">Aplicabilidad / bloqueo</th><th className="px-3 py-2.5">Aplicación</th><th className="px-3 py-2.5" /></tr></thead><tbody>{data.products.map(product => { const eligible = canApply(product); const open = expanded === product.id; return <Fragment key={product.id}><tr className="border-b border-theme-border/40 align-top last:border-0 hover:bg-theme-text/2"><td className="px-3 py-3"><input type="checkbox" checked={selected.has(product.id)} disabled={!eligible || pending} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(product.id)) next.delete(product.id); else next.add(product.id); return next })} aria-label={`Seleccionar ${product.sku}`} className="h-4 w-4 accent-theme-accent disabled:opacity-40" /></td><td className="px-3 py-3"><p className="font-semibold text-theme-text">{product.sku}</p><p className="text-xs text-theme-text-muted">{product.product_name}</p></td><td className="px-3 py-3 font-medium text-theme-text">{product.bsale_office_id}</td><td className="px-3 py-3 text-right">{quantity(product.physical_quantity)}</td><td className="px-3 py-3 text-right">{quantity(product.bsale_quantity)}</td><td className={`px-3 py-3 text-right font-semibold ${product.difference_quantity === 0 ? 'text-theme-text-muted' : 'text-amber-600 dark:text-amber-400'}`}>{quantity(product.difference_quantity)}</td><td className="px-3 py-3"><StatusPill status={product.reconciliation_status} /></td><td className="px-3 py-3"><div className="flex items-center gap-1.5"> <StatusPill status={product.logistics_applicability_status} />{product.logistics_block_reasons.length > 0 && <ShieldAlert className="h-3.5 w-3.5 text-red-500" />}</div><Reasons reasons={product.logistics_block_reasons} /></td><td className="px-3 py-3"><StatusPill status={product.logistics_application_status} /></td><td className="px-3 py-3"><button type="button" onClick={() => toggleDetail(product.id)} className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border px-2 text-xs font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Detalle</button></td></tr>{open && <tr className="border-b border-theme-border/40 bg-theme-bg/40"><td colSpan={10} className="px-4 py-3">{details[product.id] ? <Detail detail={details[product.id]} pending={false} /> : <Detail detail={{ item: {}, sources: [], lines: [] }} pending={pending} />}</td></tr>}</Fragment> })}</tbody></table></div></div>
  </div>
}
