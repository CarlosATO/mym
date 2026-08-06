'use client'

import { useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  revokeInventoryCampaignParticipant,
  type InventoryCampaignParticipant,
} from '@/app/actions/inventarios/campaigns'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'

interface InventoryCampaignParticipantRevokeDialogProps {
  companyId: string
  campaignId: string
  participant: InventoryCampaignParticipant
  onClose: () => void
  onRevoked: () => void
  onBlocked: () => void
}

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function InventoryCampaignParticipantRevokeDialog({
  companyId,
  campaignId,
  participant,
  onClose,
  onRevoked,
  onBlocked,
}: InventoryCampaignParticipantRevokeDialogProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)

  const roleLabel = inventoryRoleLabel(participant.participantRole)
  const validLength = reason.trim().length >= 5 && reason.trim().length <= 500

  const handleConfirm = async () => {
    if (busy) return
    const trimmed = reason.trim()
    if (trimmed.length < 5 || trimmed.length > 500) {
      setError('El motivo debe tener entre 5 y 500 caracteres.')
      return
    }
    if (!keyRef.current) keyRef.current = newOperationKey()
    setBusy(true)
    setError(null)
    const result = await revokeInventoryCampaignParticipant({
      companyId,
      campaignId,
      participantId: participant.participantId,
      reason: trimmed,
      idempotencyKey: keyRef.current,
    })
    setBusy(false)
    if (result.error) {
      if (result.error.includes('preparada')) onBlocked()
      setError(result.error)
      return
    }
    onRevoked()
  }

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
        <h3 className="text-base font-bold text-theme-text">Revocar rol {roleLabel} de {participant.userName}</h3>
        <p className="mt-1 text-xs text-theme-text-muted">
          Solo se revocará este rol. Los demás roles de la persona se conservan.
        </p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={3}
          placeholder="Motivo de la revocación (mínimo 5 caracteres)"
          className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
        />
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !validLength}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            {busy ? 'Revocando…' : 'Revocar rol'}
          </button>
        </div>
      </div>
    </div>
  )
}
