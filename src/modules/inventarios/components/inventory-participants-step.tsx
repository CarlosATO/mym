'use client'

import { useEffect, useState } from 'react'
import { Check, Search, UserPlus, UserX } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { CatalogUserOption, InventoryParticipant } from '@/app/actions/inventarios/sessions'
import {
  addInventorySessionParticipant,
  revokeInventorySessionParticipant,
  getActiveCompanySessionSetup,
} from '@/app/actions/inventarios/sessions'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

const ROLE_OPTIONS = [
  { value: 'COUNTER', label: 'Tomador' },
  { value: 'SUPERVISOR', label: 'Supervisor' },
  { value: 'ADMINISTRATOR', label: 'Administrador' },
  { value: 'MANAGER', label: 'Encargado' },
]

const REQUIREMENTS: Array<{ role: string; label: string }> = [
  { role: 'ADMINISTRATOR', label: 'Al menos 1 administrador' },
  { role: 'COUNTER', label: 'Al menos 1 tomador' },
  { role: 'SUPERVISOR', label: 'Al menos 1 supervisor' },
  { role: 'MANAGER', label: 'Al menos 1 encargado' },
]

interface ParticipantsStepProps {
  companyId: string
  sessionId: string
  users: CatalogUserOption[]
  onReadyChange?: (ready: boolean) => void
}

function makeKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function InventoryParticipantsStep({ companyId, sessionId, users, onReadyChange }: ParticipantsStepProps) {
  const router = useRouter()
  const [participants, setParticipants] = useState<InventoryParticipant[]>([])
  const [responsibleUserId, setResponsibleUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedUser, setSelectedUser] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const result = await getActiveCompanySessionSetup(sessionId)
    if (result.data) {
      setParticipants(result.data.participants)
      setResponsibleUserId(result.data.session?.responsible_user_id ?? '')
    }
    setLoading(false)
  }

  useEffect(() => {
    getActiveCompanySessionSetup(sessionId).then(result => {
      if (result.data) {
        setParticipants(result.data.participants)
        setResponsibleUserId(result.data.session?.responsible_user_id ?? '')
      }
      setLoading(false)
    })
  }, [sessionId])

  const activeParticipants = participants.filter(p => !p.revoked_at)
  const activeRoles = new Set(activeParticipants.map(p => p.functional_role))
  const ready = ['ADMINISTRATOR', 'COUNTER', 'SUPERVISOR', 'MANAGER'].every(role => activeRoles.has(role))

  useEffect(() => {
    onReadyChange?.(ready)
  }, [ready, onReadyChange])

  const filteredUsers = users.filter(u => {
    const name = `${u.nombre} ${u.apellido}`.toLowerCase()
    const q = search.toLowerCase()
    return name.includes(q) || u.email.toLowerCase().includes(q)
  })

  const roleCount = (role: string) => activeParticipants.filter(p => p.functional_role === role).length

  const addParticipant = async () => {
    if (!selectedUser || !selectedRole || busy) return
    const duplicate = activeParticipants.some(
      p => p.user_id === selectedUser && p.functional_role === selectedRole
    )
    if (duplicate) {
      setError('Ese usuario ya participa con ese rol.')
      return
    }
    setBusy(true)
    setError(null)
    const result = await addInventorySessionParticipant(companyId, sessionId, selectedUser, selectedRole, makeKey())
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setSelectedUser('')
    setSelectedRole('')
    setSearch('')
    await refresh()
    router.refresh()
  }

  const revokeParticipant = async (participant: InventoryParticipant) => {
    if (!window.confirm(`¿Revocar a ${participant.user_name ?? 'este participante'} (${inventoryRoleLabel(participant.functional_role)})?`)) return
    setBusy(true)
    setError(null)
    const result = await revokeInventorySessionParticipant(
      companyId,
      sessionId,
      participant.user_id,
      'Revocado desde el asistente',
      makeKey()
    )
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await refresh()
    router.refresh()
  }

  const pendingRequirements = REQUIREMENTS.filter(req => !activeRoles.has(req.role))

  if (loading) {
    return <InventoryLoadingState label="Cargando participantes…" />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-theme-text-muted">
        Agrega los participantes de la sección de conteo. El responsable ya participa como administrador.
      </p>

      {/* Requisitos mínimos */}
      <div className="rounded-lg border border-theme-border bg-theme-text/2 p-3">
        <p className="mb-2 text-xs font-semibold text-theme-text-muted uppercase tracking-wider">Requisitos para continuar</p>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {REQUIREMENTS.map(req => {
            const met = activeRoles.has(req.role)
            return (
              <li key={req.role} className={`flex items-center gap-2 text-sm ${met ? 'text-emerald-700 dark:text-emerald-300' : 'text-theme-text-muted'}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${met ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-theme-border'}`}>
                  {met && <Check className="h-3 w-3" />}
                </span>
                {req.label}
              </li>
            )
          })}
        </ul>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Agregar participante */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar usuario"
            aria-label="Buscar usuario"
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
          />
          {search && filteredUsers.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-theme-border bg-theme-surface shadow-lg">
              {filteredUsers.map(user => (
                <li key={user.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedUser(user.id); setSearch(`${user.nombre} ${user.apellido}`.trim()) }}
                    className="w-full px-3 py-2 text-left text-sm text-theme-text hover:bg-theme-text/5"
                  >
                    {`${user.nombre} ${user.apellido}`.trim()}
                    <span className="ml-2 text-xs text-theme-text-muted">{user.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <select
          value={selectedRole}
          onChange={e => setSelectedRole(e.target.value)}
          aria-label="Rol funcional"
          className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
        >
          <option value="">Rol</option>
          {ROLE_OPTIONS.map(role => (
            <option key={role.value} value={role.value}>{role.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={addParticipant}
          disabled={!selectedUser || !selectedRole || busy}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          <UserPlus className="h-4 w-4" />
          Agregar
        </button>
      </div>

      {/* Lista de participantes */}
      {busy && <InventoryLoadingState compact label="Guardando cambios…" />}

      {activeParticipants.length === 0 ? (
        <p className="text-sm text-theme-text-muted">Sin participantes activos.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-theme-border">
          <ul className="divide-y divide-theme-border/40">
            {activeParticipants.map(participant => {
              const isResponsible = participant.user_id === responsibleUserId && participant.functional_role === 'ADMINISTRATOR'
              return (
                <li key={participant.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-theme-text">
                      {participant.user_name ?? '—'}
                      {isResponsible && (
                        <span className="ml-2 rounded-full border border-theme-border bg-theme-text/5 px-1.5 py-0.5 text-[10px] font-semibold text-theme-text-muted">
                          Administrador responsable
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-theme-text-muted">{inventoryRoleLabel(participant.functional_role)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-theme-text-muted/60">{roleCount(participant.functional_role)}</span>
                    <button
                      type="button"
                      onClick={() => revokeParticipant(participant)}
                      disabled={busy || isResponsible}
                      aria-label={`Revocar ${participant.user_name ?? 'participante'}`}
                      title={isResponsible ? 'El administrador responsable no puede revocarse a sí mismo' : 'Revocar participante'}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-30"
                    >
                      <UserX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {pendingRequirements.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Faltan: {pendingRequirements.map(r => r.label).join(', ')}.
        </p>
      )}
    </div>
  )
}
