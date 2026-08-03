import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'

interface InventoryParticipantsPanelProps {
  detail: InventorySessionDetail
}

export function InventoryParticipantsPanel({ detail }: InventoryParticipantsPanelProps) {
  const participants = detail.participants

  if (!participants || participants.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 p-8 text-center">
        <p className="text-sm text-theme-text-muted">Sin participantes registrados.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
            <th className="px-3 py-2.5">Participante</th>
            <th className="px-3 py-2.5">Rol</th>
            <th className="px-3 py-2.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          {participants.map(participant => (
            <tr key={participant.id} className="border-b border-theme-border/40 last:border-0">
              <td className="px-3 py-2.5 text-theme-text">{participant.user_name ?? '—'}</td>
              <td className="px-3 py-2.5 text-theme-text-muted">{inventoryRoleLabel(participant.functional_role)}</td>
              <td className="px-3 py-2.5">
                {participant.revoked_at ? (
                  <span className="inline-flex rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                    Revocado
                  </span>
                ) : (
                  <span className="inline-flex rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    Activo
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
