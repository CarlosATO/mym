'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Mail, Pencil, Phone, Save, UserRound, X } from 'lucide-react'
import { updateMyProfile } from '@/app/actions/users'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ProfilePersonalInfoProps {
  nombre: string | null | undefined
  apellido: string | null | undefined
  email: string | null | undefined
  telefono: string | null | undefined
}

function normalizePersonName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

function displayValue(value: string | null | undefined) {
  return value?.trim() || 'No registrado'
}

function InfoItem({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-theme-border/60 bg-theme-bg/20 p-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-theme-accent/10 text-theme-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">{label}</p>
        <p className="mt-0.5 truncate text-sm font-medium text-theme-text" title={value}>{value}</p>
      </div>
    </div>
  )
}

export function ProfilePersonalInfo({ nombre, apellido, email, telefono }: ProfilePersonalInfoProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saved, setSaved] = useState({
    nombre: normalizePersonName(nombre ?? ''),
    apellido: normalizePersonName(apellido ?? ''),
    telefono: telefono?.trim() ?? '',
  })
  const [draft, setDraft] = useState(saved)

  function startEditing() {
    setDraft(saved)
    setError('')
    setNotice('')
    setEditing(true)
  }

  function cancelEditing() {
    setDraft(saved)
    setError('')
    setEditing(false)
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setNotice('')

    const formData = new FormData()
    formData.set('nombre', draft.nombre)
    formData.set('apellido', draft.apellido)
    formData.set('telefono', draft.telefono)

    startTransition(async () => {
      const result = await updateMyProfile(formData)
      if (result.error) {
        setError(result.error)
        return
      }

      const nextSaved = {
        nombre: normalizePersonName(draft.nombre),
        apellido: normalizePersonName(draft.apellido),
        telefono: draft.telefono.trim(),
      }
      setSaved(nextSaved)
      setDraft(nextSaved)
      setEditing(false)
      setNotice('Perfil actualizado correctamente.')
      router.refresh()
    })
  }

  return (
    <section className="rounded-2xl border border-theme-border bg-theme-surface/60 p-4 shadow-xl shadow-black/10 sm:p-5">
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
            <UserRound className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-theme-text">Información personal</h2>
            <p className="text-xs text-theme-text-muted/60">Datos registrados en tu perfil interno</p>
          </div>
        </div>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            <Pencil />
            Editar
          </Button>
        )}
      </div>

      {editing ? (
        <form className="space-y-3" onSubmit={handleSubmit}>
          <p className="text-xs text-theme-text-muted/70">Puedes editar nombre, apellido y teléfono. El email es de solo lectura.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold text-theme-text-muted">
              <span>Nombre</span>
              <Input required maxLength={100} value={draft.nombre} onChange={event => setDraft(current => ({ ...current, nombre: event.target.value }))} />
            </label>
            <label className="space-y-1 text-xs font-semibold text-theme-text-muted">
              <span>Apellido</span>
              <Input required maxLength={100} value={draft.apellido} onChange={event => setDraft(current => ({ ...current, apellido: event.target.value }))} />
            </label>
            <label className="space-y-1 text-xs font-semibold text-theme-text-muted">
              <span>Teléfono</span>
              <Input maxLength={20} value={draft.telefono} onChange={event => setDraft(current => ({ ...current, telefono: event.target.value }))} />
            </label>
            <div className="space-y-1 text-xs font-semibold text-theme-text-muted">
              <span>Email</span>
              <div className="flex h-8 items-center gap-2 rounded-lg border border-theme-border/60 bg-theme-bg/40 px-2.5 font-medium text-theme-text" title={displayValue(email)}>
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{displayValue(email)}</span>
              </div>
            </div>
          </div>
          {error && <p role="alert" className="text-xs font-medium text-red-400">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              <Save />
              {pending ? 'Guardando...' : 'Guardar'}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={cancelEditing}>
              <X />
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <InfoItem icon={UserRound} label="Nombre" value={displayValue(saved.nombre)} />
            <InfoItem icon={UserRound} label="Apellido" value={displayValue(saved.apellido)} />
            <InfoItem icon={Mail} label="Email" value={displayValue(email)} />
            <InfoItem icon={Phone} label="Teléfono" value={displayValue(saved.telefono)} />
          </div>
          {notice && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-500"><Check className="h-3.5 w-3.5" />{notice}</p>}
        </>
      )}
    </section>
  )
}
