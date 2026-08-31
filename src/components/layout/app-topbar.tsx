'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard } from 'lucide-react'
import { CompanyLogo } from '@/components/company-logo'
import { CompanySwitcher } from '@/components/company-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { UserMenu } from '@/components/layout/user-menu'
import { TopbarDate } from '@/components/layout/topbar-date'
import type { Profile } from '@/lib/types'
import type { Company } from '@/app/actions/companies'
import { cn } from '@/lib/utils'

interface AppTopbarProps {
  profile: Profile & { roles: { name: string } }
  activeCompany: Company
  permissions: string[]
  moduleName?: string      // opcional — si se pasa sobreescribe la detección automática
  showPortalLink?: boolean // mantenido por compatibilidad, ya no controla visibilidad
  variant?: 'default' | 'module' // mantenido por compatibilidad, ya no cambia el estilo
  sidebarMode?: 'expanded' | 'compact'
}

// Mapa de rutas → nombre de ubicación (orden importa: más específico primero)
const ROUTE_NAMES: { prefix: string; name: string }[] = [
  { prefix: '/dashboard/adquisiciones',    name: 'Adquisiciones' },
  { prefix: '/dashboard/logistica',        name: 'WMS · Logística' },
  { prefix: '/dashboard/comercial',        name: 'Comercial' },
  { prefix: '/dashboard/analisis-comercial', name: 'Análisis Comercial' },
  { prefix: '/dashboard/inventarios',      name: 'Inventarios' },
  { prefix: '/dashboard/configurar-empresa', name: 'Empresa' },
  { prefix: '/dashboard/usuarios',         name: 'Usuarios' },
  { prefix: '/dashboard/roles',            name: 'Roles' },
  { prefix: '/dashboard/auditoria',        name: 'Auditoría' },
  { prefix: '/dashboard/seguridad',        name: 'Seguridad' },
  { prefix: '/dashboard/perfil',           name: 'Mi Perfil' },
  { prefix: '/dashboard',                  name: 'Portal de Gestión' },
]

function getLocationName(pathname: string): string {
  for (const route of ROUTE_NAMES) {
    if (pathname.startsWith(route.prefix)) return route.name
  }
  return 'Portal'
}

export function AppTopbar({ profile, activeCompany, permissions, moduleName }: AppTopbarProps) {
  const pathname = usePathname()

  const isAtPortalRoot = pathname === '/dashboard'
  const showPortal = !isAtPortalRoot

  // Nombre de ubicación: prop tiene prioridad, si no se auto-detecta desde la ruta
  const locationName = moduleName ?? getLocationName(pathname)

  return (
    // Fondo siempre idéntico — sin importar si estamos en portal o en módulo ERP
    <header className="fixed top-0 left-0 right-0 z-30 h-12 border-b border-theme-border/50 bg-theme-surface/90 backdrop-blur-md shadow-sm">
      <div className="h-full max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between gap-4">

        {/* ── Izquierda: logo empresa (fijo) + separador + nombre de ubicación ── */}
        <div className="flex items-center gap-3 overflow-hidden">

          {/* Logo + nombre empresa — nunca cambia */}
          <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0 group">
            <CompanyLogo
              logoUrl={activeCompany.logo_url}
              size={26}
              className="transition-transform duration-200 group-hover:scale-105"
            />
            <div className="leading-tight shrink-0">
              <p className="font-semibold text-[12px] text-theme-text max-w-[150px] truncate leading-snug">
                {activeCompany.trade_name || activeCompany.business_name}
              </p>
              <p className="text-[8.5px] font-semibold text-theme-text-muted/55 uppercase tracking-wider truncate max-w-[150px] leading-snug">
                PetGroup
              </p>
            </div>
          </Link>

          {/* Separador vertical */}
          <div className="w-px h-4 bg-theme-border/70 shrink-0" />

          {/* Nombre de ubicación — siempre visible, más grande y destacado */}
          <span className="text-sm font-semibold text-theme-text truncate max-w-[200px]">
            {locationName}
          </span>

        </div>

        {/* ── Derecha: controles — siempre idénticos ── */}
        <div className="flex items-center gap-1 shrink-0">

          {/* Botón Portal — visible cuando no estamos en el raíz del portal */}
          {showPortal && (
            <>
              <Link
                href="/dashboard"
                className="hidden sm:flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/8 hover:text-theme-text"
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                <span>Portal</span>
              </Link>
              <div className="w-px h-4 bg-theme-border/50 shrink-0 mx-0.5" />
            </>
          )}

          <TopbarDate />
          <CompanySwitcher />
          <div className="w-px h-4 bg-theme-border/50 shrink-0 mx-0.5" />
          <ThemeSwitcher />
          <UserMenu profile={profile} activeCompany={activeCompany} permissions={permissions} />
        </div>

      </div>
    </header>
  )
}
