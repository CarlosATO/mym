import type { ReceivablesFreshnessStatus } from '@/lib/control-financiero/receivables-freshness'

export function CobranzaFreshnessNotice({ status, snapshotLabel }: { status: ReceivablesFreshnessStatus; snapshotLabel: string | null }) {
  if (status === 'NO_DATA') {
    return (
      <div className="border border-[#B38A55]/40 bg-[#F6EFE2] px-3 py-2 text-left text-[10px] text-[#806238]" role="status">
        <p className="font-semibold">Sin snapshot de deuda vigente</p>
        <p className="mt-0.5">No hay un snapshot COMPLETED disponible para esta empresa.</p>
      </div>
    )
  }

  if (status === 'STALE') {
    return (
      <div className="border border-[#A45B58]/40 bg-[#F5E8E4] px-3 py-2 text-left text-[10px] text-[#8A4B4B]" role="alert">
        <p className="font-semibold">Datos de deuda desactualizados</p>
        <p className="mt-0.5">Última actualización: {snapshotLabel ?? '—'}. El saldo puede no representar la posición vigente en BSale.</p>
      </div>
    )
  }

  return (
    <div className="border border-[#66856B]/30 bg-[#EDF4EC] px-3 py-2 text-left text-[10px] text-[#426247]" role="status">
      <p>Datos de deuda actualizados al <strong>{snapshotLabel ?? '—'}</strong></p>
    </div>
  )
}
