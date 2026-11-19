import type { ReceivablesFreshnessStatus } from '@/lib/control-financiero/receivables-freshness'

export function CobranzaFreshnessNotice({ status, snapshotLabel }: { status: ReceivablesFreshnessStatus; snapshotLabel: string | null }) {
  if (status === 'NO_DATA') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800" role="status" title="No hay un snapshot COMPLETED disponible para esta empresa.">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        Sin snapshot vigente
      </span>
    )
  }

  if (status === 'STALE') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700" role="alert" title={`Última actualización: ${snapshotLabel ?? '—'}. El saldo puede no representar la posición vigente en BSale.`}>
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />
        Desactualizado ({snapshotLabel ?? '—'})
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800" role="status">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
      Actualizado <strong>{snapshotLabel ?? '—'}</strong>
    </span>
  )
}
