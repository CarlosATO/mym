'use client'

import { UserRound, Camera } from 'lucide-react'
import Image from 'next/image'
import { formatRut } from '@/modules/rrhh/lib/rut'

export function EmployeeIdentityCard({
  name,
  rut,
  cargo,
  estado = 'ACTIVO',
  photoUrl,
  canEdit = false,
  onPhotoSelected,
}: {
  name?: string
  rut?: string
  cargo?: string
  estado?: 'ACTIVO' | 'INACTIVO'
  photoUrl?: string | null
  canEdit?: boolean
  onPhotoSelected?: (file: File) => void
}) {
  const displayName = name?.trim() || 'Nuevo trabajador'
  const initials = displayName === 'Nuevo trabajador'
    ? '?'
    : displayName.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()

  return <aside className="h-fit rounded-xl border border-sky-200 border-t-4 border-t-sky-400 bg-white p-5 text-center shadow-sm dark:border-sky-900/60 dark:bg-theme-surface lg:sticky lg:top-16">
    <div className="relative mx-auto h-24 w-24"><div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-4 border-theme-accent/15 bg-theme-accent/10 text-2xl font-bold text-theme-accent">{photoUrl ? <Image src={photoUrl} alt={`Fotografía de ${displayName}`} width={96} height={96} unoptimized className="h-full w-full object-cover" /> : <span aria-hidden="true">{initials || <UserRound className="h-8 w-8" />}</span>}</div>{canEdit && <label className="absolute -bottom-1 -right-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border-2 border-theme-surface bg-theme-accent text-white shadow-sm" title={photoUrl ? 'Cambiar foto' : 'Agregar foto'}><Camera className="h-3.5 w-3.5" /><input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file && onPhotoSelected) onPhotoSelected(file); event.currentTarget.value = '' }} /></label>}</div>
    <h2 className="mt-4 text-lg font-bold uppercase tracking-tight text-theme-text">{displayName}</h2>
    <p className="mt-1 font-mono text-sm text-theme-text-muted">{formatRut(rut)}</p>
    {cargo?.trim() && <p className="mt-2 text-sm font-medium text-theme-text-muted">{cargo}</p>}
    <span className={estado === 'ACTIVO' ? 'mt-4 inline-flex rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300' : 'mt-4 inline-flex rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-300'}>{estado}</span>
    <p className="mt-5 border-t border-theme-border pt-4 text-[10px] uppercase tracking-wider text-theme-text-muted">{canEdit ? (photoUrl ? 'Cambiar foto' : 'Agregar foto') : 'Perfil de trabajador'}</p>
  </aside>
}
