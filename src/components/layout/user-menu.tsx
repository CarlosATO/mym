'use client'

import { useState, useRef, useEffect } from 'react'
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
  const Icon = (LucideIcons as Record<string, any>)[iconName]
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
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/10 bg-theme-surface/60 hover:bg-white/10 text-theme-text transition-all duration-200 shadow-sm text-left max-w-[240px]"
      >
        <div className="w-6 h-6 rounded bg-gradient-to-br from-theme-accent-hover to-theme-accent flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm uppercase">
          {profile.nombre?.[0] ?? 'U'}
        </div>
        <div className="truncate leading-tight">
          <p className="text-xs font-bold text-theme-text truncate max-w-[120px]">
            {profile.nombre} {profile.apellido}
          </p>
          <p className="text-[10px] text-theme-text-muted/60 truncate max-w-[120px] capitalize">
            {profile.roles?.name?.toLowerCase()?.replace('_', ' ') ?? ''}
          </p>
        </div>
        <LucideIcons.ChevronDown className={cn('h-3.5 w-3.5 text-theme-accent transition-transform shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-64 bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl shadow-black/40 z-50 py-2 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
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
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-white/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
              >
                <LucideIcons.User className="h-3.5 w-3.5 text-theme-text-muted/70" />
                Mi perfil
              </Link>
              <Link
                href="/dashboard/seguridad"
                onClick={() => setOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-white/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
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
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-white/5 hover:text-theme-text text-theme-text-muted transition-colors text-left font-medium"
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
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-white/5 hover:text-theme-text text-theme-text-muted transition-colors text-left"
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
