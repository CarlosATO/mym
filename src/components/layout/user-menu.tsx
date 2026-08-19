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
  { label: 'Auditoría', href: '/dashboard/auditoria', icon: 'ClipboardList', permission: 'audit.view' },
  { label: 'Seguridad', href: '/dashboard/seguridad', icon: 'Lock', permission: 'security.view' },
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
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="group flex h-9 max-w-[240px] items-center gap-2 rounded-xl border border-theme-accent/20 bg-theme-accent/8 px-2.5 text-left text-theme-text shadow-sm transition-all duration-200 hover:border-theme-accent/40 hover:bg-theme-accent/12"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-theme-accent/25 bg-theme-accent/15 text-xs font-bold uppercase text-theme-text-accent transition-colors group-hover:bg-theme-accent/20">
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
        <LucideIcons.ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-theme-text-accent transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
           <div className="absolute right-0 top-full mt-2 w-64 bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-theme-border shadow-2xl z-50 py-2 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
            {/* Header */}
            <div className="px-4 py-3 border-b border-theme-border/60">
              <p className="text-sm font-semibold text-theme-text truncate">{profile.nombre} {profile.apellido}</p>
              <p className="text-xs text-theme-text-muted/60 truncate">{profile.email}</p>
            </div>

            {/* Cuenta */}
            <div className="p-1 border-b border-theme-border/60">
              <p className="px-3 py-1.5 text-[9px] font-bold text-theme-accent uppercase tracking-wider">Cuenta</p>
              <Link
                href="/dashboard/perfil"
                onClick={() => setOpen(false)}
                 className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-theme-text/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
              >
                <LucideIcons.User className="h-3.5 w-3.5 text-theme-text-muted/70" />
                Mi perfil
              </Link>
              <Link
                href="/dashboard/seguridad"
                onClick={() => setOpen(false)}
                 className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-theme-text/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
              >
                <LucideIcons.Lock className="h-3.5 w-3.5 text-theme-text-muted/70" />
                Seguridad
              </Link>
            </div>

            {/* Administracion */}
            {(profile.roles?.name === 'SUPER_USUARIO' || allowedAdminLinks.length > 0) && (
              <div className="p-1 border-b border-theme-border/60">
                <p className="px-3 py-1.5 text-[9px] font-bold text-theme-accent uppercase tracking-wider">Administración</p>
                {profile.roles?.name === 'SUPER_USUARIO' && (
                  <Link
                    href="/dashboard/configurar-empresa"
                    onClick={() => setOpen(false)}
                     className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-theme-text/5 hover:text-theme-text text-theme-text-muted transition-colors text-left font-medium"
                  >
                    <LucideIcons.Settings className="h-3.5 w-3.5 text-theme-accent" />
                    Empresa
                  </Link>
                )}
                {allowedAdminLinks.map(link => {
                  const Icon = getIcon(link.icon)
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setOpen(false)}
                       className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-theme-text/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
                    >
                      <Icon className="h-3.5 w-3.5 text-theme-text-muted/70" />
                      {link.label}
                    </Link>
                  )
                })}
              </div>
            )}

            {/* Sesión */}
            <div className="p-1">
              <form action={logout}>
                <button
                  type="submit"
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-red-500/10 text-red-400 transition-colors text-left font-medium"
                >
                  <LucideIcons.LogOut className="h-3.5 w-3.5 text-red-400/80" />
                  Cerrar sesión
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
