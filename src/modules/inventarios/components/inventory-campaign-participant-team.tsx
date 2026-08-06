'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronDown, Loader2, RefreshCw, Search, UserPlus, Users, X } from 'lucide-react'
import {
  listInventoryCampaignParticipants,
  listInventoryCampaignUserCatalog,
  addInventoryCampaignParticipant,
  type InventoryCampaignParticipant,
  type InventoryCampaignParticipantRole,
  type InventoryCampaignUserOption,
} from '@/app/actions/inventarios/campaigns'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'
import { formatDateChile } from '@/modules/inventarios/lib/format'
import { InventoryCampaignParticipantRevokeDialog } from '@/modules/inventarios/components/inventory-campaign-participant-revoke-dialog'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

const ROLE_OPTIONS: Array<{ value: InventoryCampaignParticipantRole; label: string }> = [
  { value: 'COUNTER', label: 'Contador' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'ADMINISTRATOR', label: 'Administrador' },
  { value: 'MANAGER', label: 'Gerencia' },
]

const ROLE_BADGE_CLASSES: Record<InventoryCampaignParticipantRole, string> = {
  COUNTER: 'border-sky-600/30 bg-sky-500/15 text-sky-800 dark:text-sky-300',
  SUPERVISOR: 'border-amber-600/30 bg-amber-500/15 text-amber-800 dark:text-amber-300',
  ADMINISTRATOR: 'border-violet-600/30 bg-violet-500/15 text-violet-800 dark:text-violet-300',
  MANAGER: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
}

function fullName(user: { nombre: string; apellido: string | null }): string {
  return user.apellido ? `${user.nombre} ${user.apellido}`.trim() : user.nombre
}

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface CampaignParticipantAddFormProps {
  companyId: string
  campaignId: string
  users: InventoryCampaignUserOption[]
  activeParticipants: InventoryCampaignParticipant[]
  onAdded: () => void
  onBlocked: () => void
}

function CampaignParticipantAddForm({
  companyId,
  campaignId,
  users,
  activeParticipants,
  onAdded,
  onBlocked,
}: CampaignParticipantAddFormProps) {
  const [userSearch, setUserSearch] = useState('')
  const [userPickerOpen, setUserPickerOpen] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)
  const selectionRef = useRef<string>('')

  const selectedUserActiveRoles = new Set(
    activeParticipants.filter(p => p.userId === selectedUserId).map(p => p.participantRole)
  )
  const availableRoles = ROLE_OPTIONS.filter(option => !selectedUserActiveRoles.has(option.value))
  const filteredUsers = users.filter(u => {
    if (!userSearch.trim()) return true
    const q = userSearch.trim().toLowerCase()
    return fullName(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  const handleAdd = async () => {
    if (!selectedUserId || !selectedRole || busy) return
    const selection = `${selectedUserId}:${selectedRole}`
    if (selectionRef.current !== selection) {
      selectionRef.current = selection
      keyRef.current = newOperationKey()
    }
    setBusy(true)
    const result = await addInventoryCampaignParticipant({
      companyId,
      campaignId,
      userId: selectedUserId,
      participantRole: selectedRole as InventoryCampaignParticipantRole,
      idempotencyKey: keyRef.current ?? newOperationKey(),
    })
    setBusy(false)
    if (result.error) {
      if (result.error.includes('preparada')) onBlocked()
      return
    }
    keyRef.current = null
    selectionRef.current = ''
    setSelectedUserId('')
    setSelectedRole('')
    setUserSearch('')
    onAdded()
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/60" />
          <input
            value={userSearch}
            onChange={e => {
              setUserSearch(e.target.value)
              setUserPickerOpen(true)
              setSelectedUserId('')
              setSelectedRole('')
            }}
            onFocus={() => setUserPickerOpen(true)}
            placeholder="Buscar usuario por nombre o email…"
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-8 pr-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
          />
          {userPickerOpen && (
            <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-theme-border bg-theme-surface shadow-lg">
              {filteredUsers.length === 0 ? (
                <li className="px-3 py-2 text-xs text-theme-text-muted">Sin resultados.</li>
              ) : (
                filteredUsers.map(u => (
                  <li key={u.userId}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUserId(u.userId)
                        setSelectedRole('')
                        setUserPickerOpen(false)
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-theme-text hover:bg-theme-text/5"
                    >
                      <span>
                        {fullName(u)}
                        <span className="ml-1 text-xs text-theme-text-muted/70">{u.email}</span>
                      </span>
                      {u.userId === selectedUserId && <Check className="h-3.5 w-3.5 text-theme-accent" />}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <select
          value={selectedRole}
          onChange={e => setSelectedRole(e.target.value)}
          aria-label="Rol a agregar"
          className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent sm:w-40"
        >
          <option value="">Rol</option>
          {availableRoles.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!selectedUserId || !selectedRole || busy}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {busy ? 'Agregando…' : 'Agregar'}
        </button>
      </div>
      <p className="text-[11px] text-theme-text-muted">Solo aparecen usuarios activos con acceso a esta empresa.</p>
      <p className="text-[11px] text-theme-text-muted">
        ¿No encuentras a una persona? Primero debes crearle acceso en PetGroup.{' '}
        <Link href="/dashboard/usuarios" className="font-medium text-theme-accent hover:underline">
          Gestionar usuarios
        </Link>
      </p>
    </div>
  )
}

interface InventoryCampaignParticipantTeamProps {
  companyId: string
  campaignId: string
  campaignStatus: string
  canManage: boolean
}

export function InventoryCampaignParticipantTeam({
  companyId,
  campaignId,
  campaignStatus,
  canManage,
}: InventoryCampaignParticipantTeamProps) {
  const [participants, setParticipants] = useState<InventoryCampaignParticipant[]>([])
  const [users, setUsers] = useState<InventoryCampaignUserOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [blockedByPreparation, setBlockedByPreparation] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<InventoryCampaignParticipant | null>(null)

  const editable = canManage && campaignStatus === 'DRAFT' && !blockedByPreparation

  const refreshParticipants = async () => {
    const result = await listInventoryCampaignParticipants(companyId, campaignId)
    if (result.error) {
      setLoadError(result.error)
      return
    }
    setParticipants(result.data?.participants ?? [])
  }

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    const [teamResult, catalogResult] = await Promise.all([
      listInventoryCampaignParticipants(companyId, campaignId),
      listInventoryCampaignUserCatalog(companyId),
    ])
    setLoading(false)
    if (teamResult.error) {
      setLoadError(teamResult.error)
      return
    }
    setParticipants(teamResult.data?.participants ?? [])
    if (catalogResult.error) {
      setLoadError(catalogResult.error)
      return
    }
    setUsers(catalogResult.data ?? [])
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, campaignId])

  const activeParticipants = useMemo(
    () => participants.filter(p => p.state === 'ACTIVE'),
    [participants]
  )
  const revokedParticipants = useMemo(
    () => participants.filter(p => p.state === 'REVOKED'),
    [participants]
  )

  const counts = useMemo(
    () => ({
      counter: activeParticipants.filter(p => p.participantRole === 'COUNTER').length,
      supervisor: activeParticipants.filter(p => p.participantRole === 'SUPERVISOR').length,
      administrator: activeParticipants.filter(p => p.participantRole === 'ADMINISTRATOR').length,
      manager: activeParticipants.filter(p => p.participantRole === 'MANAGER').length,
    }),
    [activeParticipants]
  )

  const groupedByUser = useMemo(() => {
    const groups = new Map<string, InventoryCampaignParticipant[]>()
    for (const p of activeParticipants) {
      const list = groups.get(p.userId) ?? []
      list.push(p)
      groups.set(p.userId, list)
    }
    return Array.from(groups.values())
  }, [activeParticipants])

  const roleBadge = (participant: InventoryCampaignParticipant, withRevoke: boolean) => (
    <span
      key={participant.participantId}
      className={`inline-flex h-6 items-center gap-0.5 rounded-full border px-2 text-xs font-medium ${ROLE_BADGE_CLASSES[participant.participantRole]}`}
    >
      {inventoryRoleLabel(participant.participantRole)}
      {withRevoke && (
        <button
          type="button"
          onClick={() => setRevokeTarget(participant)}
          aria-label={`Revocar rol ${inventoryRoleLabel(participant.participantRole)} de ${participant.userName ?? 'este participante'}`}
          className="-mr-1 ml-1 rounded-full p-0.5 text-current opacity-50 transition-opacity hover:opacity-100 focus:opacity-100 focus:outline-none"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )

  if (loading) {
    return (
      <section className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h2 className="text-sm font-bold text-theme-text">Equipo participante</h2>
        <InventoryLoadingState className="mt-2" compact />
      </section>
    )
  }

  return (
    <>
      <section className="flex h-full flex-col rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-theme-text">Equipo participante</h2>
            <p className="mt-0.5 text-xs text-theme-text-muted">Administradores, supervisores y contadores.</p>
          </div>
          <button
            type="button"
            onClick={() => setManageOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-text/5"
          >
            <Users className="h-3.5 w-3.5" />
            {editable ? 'Gestionar equipo' : 'Ver equipo'}
          </button>
        </div>

        <div className="mt-2 flex-1 space-y-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-theme-text-muted">
            <span><span className="font-semibold text-theme-text">{counts.administrator}</span> Administrador</span>
            <span><span className="font-semibold text-theme-text">{counts.supervisor}</span> Supervisor</span>
            <span><span className="font-semibold text-theme-text">{counts.counter}</span> Contadores</span>
            <span><span className="font-semibold text-theme-text">{counts.manager}</span> Gerencia</span>
          </div>

          <div className="space-y-1.5">
            {groupedByUser.length === 0 ? (
              <p className="rounded-lg border border-dashed border-theme-border px-3 py-3 text-center text-xs text-theme-text-muted">
                Aún no hay integrantes.
              </p>
            ) : (
              groupedByUser.map(row => (
                <div key={row[0].userId} className="flex items-center justify-between gap-2 rounded-lg border border-theme-border bg-theme-surface/40 px-2.5 py-1.5">
                  <p className="truncate text-xs font-medium text-theme-text">{row[0].userName ?? row[0].email}</p>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {row.map(participant => roleBadge(participant, false))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {revokedParticipants.length > 0 && (
          <p className="mt-2 text-[11px] text-theme-text-muted">
            {revokedParticipants.length} rol(es) en el historial
          </p>
        )}
      </section>

      {manageOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-theme-border/60 px-5 py-3">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-theme-text">Equipo participante</h3>
                <p className="text-sm text-theme-text-muted">Administradores, supervisores y contadores de la campaña.</p>
              </div>
              <button
                type="button"
                onClick={() => setManageOpen(false)}
                className="rounded-lg px-2 py-1 text-sm text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                Cerrar
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {loadError && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
                  <p>{loadError}</p>
                  <button
                    type="button"
                    onClick={load}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text hover:bg-theme-text/5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Reintentar
                  </button>
                </div>
              )}

              {!loadError && (
                <>
                  {editable ? (
                    <CampaignParticipantAddForm
                      companyId={companyId}
                      campaignId={campaignId}
                      users={users}
                      activeParticipants={activeParticipants}
                      onAdded={() => {
                        setNotice('Rol agregado al equipo.')
                        refreshParticipants()
                      }}
                      onBlocked={() => setBlockedByPreparation(true)}
                    />
                  ) : (
                    <div className="rounded-lg border border-theme-border bg-theme-surface/60 px-3 py-2 text-xs text-theme-text-muted">
                      {blockedByPreparation
                        ? 'El equipo ya no puede modificarse porque la campaña fue preparada.'
                        : canManage
                          ? 'El equipo solo puede modificarse mientras la campaña esté en estado DRAFT.'
                          : 'No tienes permisos para modificar el equipo de esta campaña.'}
                    </div>
                  )}

                  {notice && <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{notice}</p>}

                  {groupedByUser.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-theme-border px-3 py-4 text-center text-xs text-theme-text-muted">
                      Aún no hay integrantes en el equipo de esta campaña.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-theme-border bg-theme-surface/40">
                      <ul className="divide-y divide-theme-border">
                        {groupedByUser.map(row => (
                          <li key={row[0].userId} className="flex flex-col gap-1.5 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-theme-text">{row[0].userName ?? row[0].email}</p>
                              <p className="truncate text-xs text-theme-text-muted/80">{row[0].email}</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {row.map(participant => roleBadge(participant, editable))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {revokedParticipants.length > 0 && (
                    <div className="border-t border-theme-border pt-2.5">
                      <button
                        type="button"
                        onClick={() => setHistoryOpen(open => !open)}
                        className="flex items-center gap-1 text-xs font-semibold text-theme-text"
                      >
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
                        Historial de roles · {revokedParticipants.length}
                      </button>
                      {historyOpen && (
                        <div className="mt-2 space-y-1">
                          {revokedParticipants.map(p => (
                            <div key={p.participantId} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-lg bg-theme-surface/40 px-2.5 py-1.5 text-xs">
                              <span className="font-medium text-theme-text">
                                {p.userName}
                                <span className="ml-1.5 font-normal text-theme-text-muted">{inventoryRoleLabel(p.participantRole)}</span>
                              </span>
                              <span className="text-theme-text-muted">
                                {p.revokedAt ? formatDateChile(p.revokedAt) : ''}
                                {p.revocationReason ? ` · ${p.revocationReason}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {revokeTarget && (
        <InventoryCampaignParticipantRevokeDialog
          key={revokeTarget.participantId}
          companyId={companyId}
          campaignId={campaignId}
          participant={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null)
            setNotice('Rol revocado del equipo.')
            refreshParticipants()
          }}
          onBlocked={() => setBlockedByPreparation(true)}
        />
      )}
    </>
  )
}
