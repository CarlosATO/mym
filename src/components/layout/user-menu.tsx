'use client'

import { useState, useRef, useEffect } from 'react'
import type { ComponentType } from 'react'
import Link from 'next/link'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { logout } from '@/app/actions/auth'
import type { Profile } from '@/lib/types'
import type { Company } from '@/app/actions/companies'

interface UserMenuProps {
  profile: Profile & { roles: { name: string } }
  activeCompany: Company | null
  permissions: string[]
}

const adminLinkDefs = [
  { label: 'Usuarios', href: '/dashboard/usuarios', icon: 'Users', permission: 'usuarios.view' },
  { label: 'Roles', href: '/dashboard/roles', icon: 'Shield', permission: 'roles.view' },
  { label: 'Auditoría', href: '/dashboard/auditoria', icon: 'ClipboardList', permission: 'audit.view', description: 'Consulta cambios de datos: creaciones, modificaciones y eliminaciones.' },
  { label: 'Registros de seguridad', href: '/dashboard/seguridad', icon: 'Lock', permission: 'security.view', description: 'Consulta accesos y eventos: inicios de sesión, cierres y cambios de contraseña.' },
]

function getIcon(iconName: string) {
  const Icon = (LucideIcons as unknown as Record<string, ComponentType<{ className?: string }>>)[iconName]
  return Icon ?? LucideIcons.Box
}

export function UserMenu({ profile, activeCompany, permissions }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const allowedAdminLinks = adminLinkDefs.filter(link => permissions.includes(link.permission))

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger ── */}
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="group flex h-9 max-w-[240px] items-center gap-2 rounded-xl border border-theme-accent/20 bg-theme-accent/8 px-2.5 text-left text-theme-text shadow-sm transition-all duration-200 hover:border-theme-accent/40 hover:bg-theme-accent/12"
      >
        {/* Avatar */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-theme-accent/25 bg-theme-accent/15 text-xs font-bold uppercase text-theme-text-accent transition-colors group-hover:bg-theme-accent/20">
          {profile.nombre?.[0] ?? 'U'}
        </div>
        <div className="truncate leading-tight">
          <p className="max-w-[120px] truncate text-[11px] font-bold text-theme-text">
            {profile.nombre} {profile.apellido}
          </p>
          <p className="max-w-[120px] truncate text-[9px] font-medium capitalize text-theme-text-muted/70">
            {profile.roles?.name?.toLowerCase()?.replace('_', ' ') ?? ''}
          </p>
        </div>
        <LucideIcons.ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-theme-text-accent transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {/* ── Panel ── */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-68 min-w-[272px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-[0_8px_32px_-4px_rgba(0,0,0,0.14),0_2px_8px_-2px_rgba(0,0,0,0.08)] backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-200">

            {/* ── Header: identidad del usuario ── */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-theme-border/50">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-theme-accent/15 text-sm font-bold uppercase text-theme-text-accent">
                {profile.nombre?.[0] ?? 'U'}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-theme-text truncate leading-snug">
                  {profile.nombre} {profile.apellido}
                </p>
                <p className="text-[11px] text-theme-text-muted/70 truncate leading-snug">{profile.email}</p>
              </div>
            </div>

            {/* ── Cuenta ── */}
            <div className="py-1.5 border-b border-theme-border/50">
              <MenuItem
                href="/dashboard/perfil"
                icon={LucideIcons.User}
                label="Mi perfil"
                onClose={() => setOpen(false)}
                withChevron
              />
            </div>

            {/* ── Administración ── */}
            {(profile.roles?.name === 'SUPER_USUARIO' || allowedAdminLinks.length > 0) && (
              <div className="py-1.5 border-b border-theme-border/50">
                <p className="px-4 pt-1 pb-1 text-[9px] font-semibold uppercase tracking-widest text-theme-text-muted/50">
                  Administración
                </p>

                {profile.roles?.name === 'SUPER_USUARIO' && (
                  <MenuItem
                    href="/dashboard/configurar-empresa"
                    icon={LucideIcons.Settings}
                    label="Empresa"
                    onClose={() => setOpen(false)}
                    withChevron
                  />
                )}

                {allowedAdminLinks.map(link => {
                  const Icon = getIcon(link.icon)
                  return (
                    <MenuItem
                      key={link.href}
                      href={link.href}
                      icon={Icon}
                      label={link.label}
                      tooltip={link.description}
                      onClose={() => setOpen(false)}
                      withChevron
                    />
                  )
                })}
              </div>
            )}

            {/* ── Cerrar sesión ── */}
            <div className="py-1.5">
              <form action={logout}>
                <button
                  type="submit"
                  className="group flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-red-500/8 hover:text-red-500"
                >
                  <LucideIcons.LogOut className="h-[15px] w-[15px] shrink-0 text-red-400/80 transition-colors group-hover:text-red-500" />
                  <span className="font-medium">Cerrar sesión</span>
                </button>
              </form>
            </div>

          </div>
        </>
      )}
    </div>
  )
}

/* ── Sub-componente: ítem de menú reutilizable ── */
interface MenuItemProps {
  href: string
  icon: ComponentType<{ className?: string }>
  label: string
  subtitle?: string
  tooltip?: string
  withChevron?: boolean
  onClose: () => void
}

function MenuItem({ href, icon: Icon, label, subtitle, tooltip, withChevron, onClose }: MenuItemProps) {
  return (
    <Link
      href={href}
      title={tooltip}
      onClick={onClose}
      className="group relative flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-theme-text/5"
    >
      <Icon className="h-[15px] w-[15px] shrink-0 text-theme-text-muted/55" />
      <div className="flex-1 min-w-0">
        <span className="block text-sm text-theme-text-muted group-hover:text-theme-text transition-colors leading-snug">
          {label}
        </span>
        {subtitle && (
          <span className="block text-[10px] text-theme-text-muted/50 leading-snug font-medium uppercase tracking-wide mt-0.5">
            {subtitle}
          </span>
        )}
      </div>
      {withChevron && (
        <LucideIcons.ChevronRight className="h-3.5 w-3.5 shrink-0 text-theme-text-muted/30 transition-all group-hover:text-theme-text-muted/60 group-hover:translate-x-0.5" />
      )}
      {/* Tooltip flotante para ítems con descripción larga */}
      {tooltip && (
        <span className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 hidden w-56 -translate-y-1/2 rounded-xl border border-theme-border bg-theme-surface px-3 py-2.5 text-[10px] leading-relaxed text-theme-text shadow-lg group-hover:block">
          {tooltip}
        </span>
      )}
    </Link>
  )
}
