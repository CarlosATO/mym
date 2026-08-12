import type { InventoryCampaignParticipant } from '@/app/actions/inventarios/campaigns'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'

interface InventoryParticipantsPanelProps {
  detail: InventorySessionDetail
  campaignParticipants?: InventoryCampaignParticipant[]
}

interface ParticipantBadge {
  key: string
  userName: string
  isRevoked: boolean
  roles: string[]
}

function buildSessionParticipantBadges(participants: InventorySessionDetail['participants']): ParticipantBadge[] {
  const grouped = new Map<string, InventorySessionDetail['participants']>()

  for (const participant of participants) {
    const current = grouped.get(participant.user_id) ?? []
    current.push(participant)
    grouped.set(participant.user_id, current)
  }

  return Array.from(grouped.entries()).map(([userId, entries]) => {
    const activeEntries = entries.filter(entry => !entry.revoked_at)
    const source = activeEntries[0] ?? entries[0]
    return {
      key: userId,
      userName: source.user_name ?? '—',
      isRevoked: activeEntries.length === 0,
      roles: Array.from(new Set(activeEntries.map(entry => inventoryRoleLabel(entry.functional_role)).filter(Boolean))),
    }
  })
}

function buildCampaignParticipantBadges(participants: InventoryCampaignParticipant[]): ParticipantBadge[] {
  const grouped = new Map<string, InventoryCampaignParticipant[]>()

  for (const participant of participants) {
    const current = grouped.get(participant.userId) ?? []
    current.push(participant)
    grouped.set(participant.userId, current)
  }

  return Array.from(grouped.entries()).map(([userId, entries]) => {
    const activeEntries = entries.filter(entry => entry.state === 'ACTIVE' && entry.userIsActive)
    const source = activeEntries[0] ?? entries[0]
    return {
      key: userId,
      userName: source.userName ?? source.email ?? '—',
      isRevoked: activeEntries.length === 0,
      roles: Array.from(new Set(activeEntries.map(entry => inventoryRoleLabel(entry.participantRole)).filter(Boolean))),
    }
  })
}

export function InventoryParticipantsPanel({ detail, campaignParticipants }: InventoryParticipantsPanelProps) {
  const participants = campaignParticipants?.length
    ? buildCampaignParticipantBadges(campaignParticipants)
    : buildSessionParticipantBadges(detail.participants)

  if (!participants || participants.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-theme-border bg-theme-surface/60 px-3 py-4 text-center text-xs text-theme-text-muted">
        Sin participantes registrados.
      </div>
    )
  }

  const active = participants.filter(participant => !participant.isRevoked)
  const revoked = participants.filter(participant => participant.isRevoked)
  const counters = active.filter(participant => participant.roles.includes('Contador')).length

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface px-3 py-2.5 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-theme-text">Equipo participante</span>
        <span className="text-theme-text-muted">
          {active.length} activo{active.length === 1 ? '' : 's'}
          {counters > 0 && ` · ${counters} contador${counters === 1 ? '' : 'es'} disponible${counters === 1 ? '' : 's'}`}
        </span>
        {revoked.length > 0 && (
          <span className="text-red-600/80 dark:text-red-400/80">
            · {revoked.length} revocado{revoked.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {participants.map(participant => {
          const isRevoked = participant.isRevoked
          return (
            <span
              key={participant.key}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
                isRevoked
                  ? 'border-red-500/25 bg-red-500/10 text-red-700/80 dark:text-red-300/80'
                  : 'border-theme-border/60 bg-theme-text/[0.03] text-theme-text'
              }`}
              title={isRevoked ? 'Participante revocado' : 'Participante activo'}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  isRevoked ? 'bg-red-500' : 'bg-emerald-500'
                }`}
              />
              <span className="font-semibold">{participant.userName}</span>
              <span className={`font-normal ${isRevoked ? 'opacity-70' : 'text-theme-text-muted'}`}>
                {participant.roles.join(' / ')}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
