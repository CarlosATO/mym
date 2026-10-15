import type { ReceivablesFreshnessStatus } from '@/lib/control-financiero/receivables-freshness'

export function CobranzaFreshnessNotice({ status, snapshotLabel }: { status: ReceivablesFreshnessStatus; snapshotLabel: string | null }) {
  if (status === 'NO_DATA') {
    return (
      <div className="border-l-2 border-[#B38A55]/60 bg-[#F6EFE2] px-2 py-1 text-left text-[10px] leading-4 text-[#806238]" role="status">
        <p className="break-words font-semibold">Sin snapshot de deuda vigente</p>
        <p className="break-words">No hay un snapshot COMPLETED disponible para esta empresa.</p>
      </div>
    )
  }

  if (status === 'STALE') {
    return (
      <div className="border-l-2 border-[#A45B58]/60 bg-[#F5E8E4] px-2 py-1 text-left text-[10px] leading-4 text-[#8A4B4B]" role="alert">
        <p className="break-words font-semibold">Datos de deuda desactualizados</p>
        <p className="break-words">Última actualización: {snapshotLabel ?? '—'}. El saldo puede no representar la posición vigente en BSale.</p>
      </div>
    )
  }

  return (
    <div className="border-l-2 border-[#66856B]/60 bg-[#EDF4EC] px-2 py-1 text-left text-[10px] leading-4 text-[#426247]" role="status">
      <p className="break-words">Datos de deuda actualizados al <strong>{snapshotLabel ?? '—'}</strong></p>
    </div>
  )
}
