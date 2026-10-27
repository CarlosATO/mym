'use client'

import { AlertTriangle, CircleAlert, RefreshCw } from 'lucide-react'
import type { PreparationCommercialAlert } from '@/app/actions/logistica/sales-order-preparation-commercial'

function statusMessage(alert: PreparationCommercialAlert): string {
  if (alert.status === 'UNAVAILABLE') return 'No se pudo verificar Bsale. No se puede confirmar que la Nota de Venta esté actualizada.'
  if (alert.status === 'INCOMPLETE') return 'La información comercial está incompleta. Revisión requerida.'
  if (alert.status === 'AMBIGUOUS') return 'No se pudo resolver con seguridad la identidad o comparación comercial.'
  return 'La revisión comercial no aplica a este estado.'
}

function lineLabel(line: PreparationCommercialAlert['differences'][number]['current'] | PreparationCommercialAlert['differences'][number]['previous']): string {
  if (!line) return 'Producto sin identificación'
  return line.sku || line.productName || (line.variantId == null ? 'Producto sin identificación' : `Variante ${line.variantId}`)
}

function quantityChangeLabel(difference: PreparationCommercialAlert['differences'][number]): string {
  const previous = difference.previous?.quantity ?? '—'
  const current = difference.current?.quantity ?? '—'
  return `${previous} → ${current}`
}

function formatAmount(value: number): string {
  return `${value > 0 ? '+' : ''}$ ${value.toLocaleString('es-CL')}`
}

export function PreparationCommercialChangeAlert({
  alert,
  compact = false,
}: {
  alert: PreparationCommercialAlert | null | undefined
  compact?: boolean
}) {
  if (!alert || alert.status === 'UNCHANGED' || alert.status === 'NOT_APPLICABLE') return null
  const changed = alert.status === 'CHANGED'
  if (changed && compact) {
    return (
      <div role="alert" className="rounded-md border border-red-500/80 bg-red-100/80 px-2 py-1.5 text-[10px] font-extrabold leading-snug text-red-950 shadow-sm">
        <p className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> NV MODIFICADA EN BSALE</p>
      </div>
    )
  }
  const removed = alert.differences.filter(difference => difference.kind === 'REMOVED')
  const added = alert.differences.filter(difference => difference.kind === 'ADDED')
  const quantityChanges = alert.differences.filter(difference => difference.kind === 'QUANTITY_INCREASED' || difference.kind === 'QUANTITY_DECREASED')
  const otherChanges = alert.differences.filter(difference => !['REMOVED', 'ADDED', 'QUANTITY_INCREASED', 'QUANTITY_DECREASED'].includes(difference.kind))

  return (
    <div
      role={changed ? 'alert' : 'status'}
      className={`rounded-lg border-2 px-3 py-2.5 text-xs leading-snug ${
        changed
          ? 'border-red-500 bg-red-50 text-red-950 shadow-sm'
          : 'border-amber-400 bg-amber-50 text-amber-950'
      }`}
    >
      <p className="flex items-center gap-2 text-sm font-extrabold tracking-tight">
        {changed ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CircleAlert className="h-3.5 w-3.5 shrink-0" />}
        {changed ? 'ATENCIÓN: NOTA DE VENTA MODIFICADA' : statusMessage(alert)}
      </p>
      {changed && (
        <>
          <p className="mt-1 font-medium">Bsale registra cambios en este pedido. Revisa las diferencias antes de continuar.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {removed.length > 0 && <ChangeGroup title="Productos retirados" tone="removed" differences={removed} />}
            {added.length > 0 && <ChangeGroup title="Productos agregados" tone="added" differences={added} />}
            {quantityChanges.length > 0 && <ChangeGroup title="Cantidades modificadas" tone="quantity" differences={quantityChanges} quantity />}
          </div>
          {otherChanges.length > 0 && <div className="mt-3"><ChangeGroup title="Otros cambios" tone="quantity" differences={otherChanges} /></div>}
          {alert.totalDelta != null && <p className="mt-3 border-t border-red-200 pt-2 font-bold">Diferencia comercial: {formatAmount(alert.totalDelta)}</p>}
        </>
      )}
      {!changed && <p className="mt-1 flex items-center gap-1 font-medium"><RefreshCw className="h-3 w-3" /> {alert.detail}</p>}
    </div>
  )
}

function ChangeGroup({
  title,
  tone,
  differences,
  quantity = false,
}: {
  title: string
  tone: 'removed' | 'added' | 'quantity'
  differences: PreparationCommercialAlert['differences']
  quantity?: boolean
}) {
  const toneClasses = tone === 'removed'
    ? 'border-red-200 bg-red-100/70 text-red-950'
    : tone === 'added'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
      : 'border-red-200/80 bg-white/70 text-red-950'
  return (
    <section className={`rounded-md border px-2.5 py-2 ${toneClasses}`}>
      <h4 className="text-[10px] font-extrabold uppercase tracking-wide">{title}</h4>
      <ul className="mt-1 space-y-1 font-medium">
        {differences.map((difference, index) => (
          <li key={`${difference.kind}-${index}`}>
            <span className="font-bold">{lineLabel(difference.current ?? difference.previous)}</span>
            {quantity && <span className="ml-1 tabular-nums">{quantityChangeLabel(difference)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function PreparationCommercialPreparationNote({ alert }: { alert: PreparationCommercialAlert | null | undefined }) {
  if (!alert || alert.status !== 'CHANGED') return null
  return (
    <div className="rounded-md border border-red-200 bg-red-50/70 px-3 py-2 text-[11px] font-medium text-red-950">
      Esta lista corresponde a la versión anterior de la Nota de Venta. Los cambios de Bsale aún no han sido aceptados.
    </div>
  )
}
