'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import {
  Boxes,
  Check,
  Menu,
  Moon,
  Settings,
  Sun,
  Users,
} from 'lucide-react'
import { CompanyLogo } from '@/components/company-logo'
import { UserMenu } from '@/components/layout/user-menu'
import { BsaleReplenishmentTopbarControl } from '@/components/integraciones/bsale-replenishment-topbar-control'
import type { Profile } from '@/lib/types'
import type { Company } from '@/app/actions/companies'
import { cn } from '@/lib/utils'

interface AppTopbarProps {
  profile: Profile & { roles: { name: string } }
  activeCompany: Company
  permissions: string[]
  moduleName?: string
  showPortalLink?: boolean
  variant?: 'default' | 'module'
  sidebarMode?: 'expanded' | 'compact'
}

export interface TopbarNavModule {
  id: string
  label: string
  href: string
  permission: string
  matchPrefixes: string[]
  disabled?: boolean
}

// Mapa de rutas → nombre de ubicación (orden importa: más específico primero)
export const ROUTE_NAMES: { prefix: string; name: string }[] = [
  { prefix: '/dashboard/adquisiciones',    name: 'Adquisiciones' },
  { prefix: '/dashboard/logistica/mermas', name: 'Mermas' },
  { prefix: '/dashboard/logistica',        name: 'WMS · Logística' },
  { prefix: '/dashboard/comercial',        name: 'Clientes / Ventas' },
  { prefix: '/dashboard/analisis-comercial', name: 'Comercial' },
  { prefix: '/dashboard/inventarios',      name: 'Inventario' },
  { prefix: '/dashboard/rrhh',             name: 'RRHH' },
  { prefix: '/dashboard',                  name: 'Caylo' },
]

// Orden estrictamente alfabético (después de Inicio)
export const TOPBAR_MODULES: TopbarNavModule[] = [
  {
    id: 'adquisiciones',
    label: 'Adquisiciones',
    href: '/dashboard/adquisiciones',
    permission: 'module.adquisiciones.view',
    matchPrefixes: ['/dashboard/adquisiciones'],
  },
  {
    id: 'comercial',
    label: 'Clientes / Ventas',
    href: '/dashboard/comercial',
    permission: 'module.comercial.view',
    matchPrefixes: ['/dashboard/comercial'],
  },
  {
    id: 'analisis-comercial',
    label: 'Comercial',
    href: '/dashboard/analisis-comercial',
    permission: 'module.analisis-comercial.view',
    matchPrefixes: ['/dashboard/analisis-comercial'],
  },
  {
    id: 'inventarios',
    label: 'Inventario',
    href: '/dashboard/inventarios',
    permission: 'module.inventarios.view',
    matchPrefixes: ['/dashboard/inventarios'],
  },
  {
    id: 'logistica',
    label: 'Logística',
    href: '/dashboard/logistica',
    permission: 'module.logistica.view',
    matchPrefixes: ['/dashboard/logistica'],
  },
  {
    id: 'rrhh',
    label: 'RRHH',
    href: '/dashboard/rrhh',
    permission: 'module.rrhh.view',
    matchPrefixes: ['/dashboard/rrhh'],
  },
]

export function AppTopbar({ profile, activeCompany, permissions }: AppTopbarProps) {
  const pathname = usePathname()
  const [gearOpen, setGearOpen] = useState(false)
  const [sidebarActive, setSidebarActive] = useState(true)
  const gearRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme } = useTheme()
  const effectiveTheme = theme === 'dark' ? 'dark' : 'light'

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (gearRef.current && !gearRef.current.contains(event.target as Node)) {
        setGearOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Sincronizar el estado visual del botón ☰ con el sidebar del módulo activo
  useEffect(() => {
    function handleSidebarChange(event: Event) {
      const custom = event as CustomEvent<{ collapsed?: boolean; open?: boolean }>
      if (typeof custom.detail?.open === 'boolean') {
        setSidebarActive(custom.detail.open)
      } else if (typeof custom.detail?.collapsed === 'boolean') {
        setSidebarActive(!custom.detail.collapsed)
      }
    }
    window.addEventListener('mym:sidebar-change', handleSidebarChange)
    return () => window.removeEventListener('mym:sidebar-change', handleSidebarChange)
  }, [])

  const isAdmin =
    permissions.includes('system.admin') || profile.roles?.name === 'SUPER_USUARIO'

  const visibleModules = TOPBAR_MODULES.filter(
    (mod) => isAdmin || permissions.includes(mod.permission)
  )

  const isAtPortalRoot = pathname === '/dashboard'
  const isAnalysisCommercialSurface = pathname.startsWith('/dashboard/analisis-comercial')
  const isAdquisicionesSurface = pathname.startsWith('/dashboard/adquisiciones')
  const isWmsSurface = pathname.startsWith('/dashboard/logistica')
  const isMermasSurface = pathname.startsWith('/dashboard/logistica/mermas')
  const usesExecutiveTheme = isAnalysisCommercialSurface || isAdquisicionesSurface || isWmsSurface || isMermasSurface
  const legacyExecutiveClass = usesExecutiveTheme ? 'border-[#D1C7BD] bg-[#EFE9E1]/95' : 'border-theme-border/80 bg-theme-surface/95'

  function handleToggleModuleSidebar() {
    window.dispatchEvent(new CustomEvent('mym:topbar-toggle-sidebar'))
  }

  return (
    <header
      data-surface-theme={legacyExecutiveClass}
      className="fixed top-0 left-0 right-0 z-40 h-12 border-b border-theme-border/80 bg-theme-surface/95 backdrop-blur-md transition-colors"
    >
      <div className="flex h-full w-full items-center justify-between gap-3 px-3 sm:px-5">
        {/* ── Izquierda bien al borde: Botón ☰ (en módulos, estilo Bsale) + Logo Caylo ── */}
        <div className="flex items-center gap-2.5 shrink-0">
          {!isAtPortalRoot && (
            <button
              type="button"
              onClick={handleToggleModuleSidebar}
              aria-label={sidebarActive ? 'Ocultar menú lateral' : 'Mostrar menú lateral'}
              title={sidebarActive ? 'Ocultar menú lateral' : 'Mostrar menú lateral'}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full transition-all duration-150',
                sidebarActive
                  ? 'bg-sky-500/14 text-sky-600 dark:bg-sky-400/20 dark:text-sky-300'
                  : 'text-theme-text-muted hover:bg-theme-text/6 hover:text-theme-text'
              )}
            >
              <Menu className="h-[18px] w-[18px]" />
            </button>
          )}

          <Link href="/dashboard" className="group flex items-center gap-2 shrink-0">
            <CompanyLogo
              logoUrl={activeCompany.logo_url}
              size={28}
              className="rounded-lg transition-transform duration-200 group-hover:scale-105"
            />
            <div className="leading-tight">
              <p className="text-[14px] font-bold tracking-tight text-theme-text">
                Caylo
              </p>
              <p className="text-[9.5px] font-medium text-theme-text-muted/75 leading-none">
                PetGroup
              </p>
            </div>
          </Link>
        </div>

        {/* ── Centro: Navegación global alfabética estilo Bsale ── */}
        <nav
          aria-label="Módulos del sistema"
          className="hidden md:flex items-center justify-center gap-1 overflow-x-auto hide-scrollbar"
        >
          <Link
            href="/dashboard"
            className={cn(
              'rounded-lg px-3 py-1.5 text-[12.5px] transition-all duration-150 whitespace-nowrap',
              isAtPortalRoot
                ? 'bg-sky-600/12 font-semibold text-sky-700 dark:bg-sky-400/15 dark:text-sky-300'
                : 'font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
            )}
          >
            Inicio
          </Link>

          {visibleModules.map((mod) => {
            const isActive = mod.matchPrefixes.some((prefix) =>
              pathname.startsWith(prefix)
            )
            return (
              <Link
                key={mod.id}
                href={mod.href}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-[12.5px] transition-all duration-150 whitespace-nowrap',
                  isActive
                    ? 'bg-sky-600/12 font-semibold text-sky-700 dark:bg-sky-400/15 dark:text-sky-300'
                    : 'font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                )}
              >
                {mod.label}
              </Link>
            )
          })}
        </nav>

        {/* ── Derecha: Sincronizar elegante + Engranaje Popover + Usuario ── */}
        <div className="flex items-center gap-2 shrink-0">
          <BsaleReplenishmentTopbarControl
            isSuperUsuario={profile.roles?.name === 'SUPER_USUARIO'}
          />

          {/* Botón de engranaje con Popover estilo Imagen 4 (Operaciones + Mi cuenta y vista) */}
          <div ref={gearRef} className="relative">
            <button
              type="button"
              onClick={() => setGearOpen((prev) => !prev)}
              aria-label="Menú de operaciones y configuración"
              title="Operaciones y configuración"
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                gearOpen
                  ? 'border-sky-500/40 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                  : 'border-transparent text-theme-text-muted hover:bg-theme-text/6 hover:text-theme-text'
              )}
            >
              <Settings className="h-4 w-4" />
            </button>

            {gearOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setGearOpen(false)}
                />
                <div className="absolute right-0 top-full z-50 mt-2 w-[340px] sm:w-[440px] rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.16)] backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-150">
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    {/* Columna 1: Operaciones (en orden alfabético) */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 px-2 pb-1">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400">
                          <Boxes className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-xs font-bold text-theme-text">
                          Operaciones
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {visibleModules.map((mod) => (
                          <Link
                            key={mod.id}
                            href={mod.href}
                            onClick={() => setGearOpen(false)}
                            className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            <span>{mod.label}</span>
                          </Link>
                        ))}
                      </div>
                    </div>

                    {/* Columna 2: Mi cuenta y vista */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 px-2 pb-1">
                        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400">
                          <Users className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-xs font-bold text-theme-text">
                          Mi cuenta y vista
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        <Link
                          href="/dashboard"
                          onClick={() => setGearOpen(false)}
                          className="block rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                        >
                          Página de inicio
                        </Link>
                        <Link
                          href="/dashboard/perfil"
                          onClick={() => setGearOpen(false)}
                          className="block rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                        >
                          Mi perfil
                        </Link>
                        {(isAdmin || permissions.includes('usuarios.view')) && (
                          <Link
                            href="/dashboard/usuarios"
                            onClick={() => setGearOpen(false)}
                            className="block rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            Gestión de usuarios
                          </Link>
                        )}
                        {(isAdmin || permissions.includes('roles.view')) && (
                          <Link
                            href="/dashboard/roles"
                            onClick={() => setGearOpen(false)}
                            className="block rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            Roles y permisos
                          </Link>
                        )}
                        {isAdmin && (
                          <Link
                            href="/dashboard/configurar-empresa"
                            onClick={() => setGearOpen(false)}
                            className="block rounded-lg px-2.5 py-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            Configuración Caylo
                          </Link>
                        )}
                      </div>

                      {/* Selector compacto de tema */}
                      <div className="mt-2 border-t border-theme-border/60 pt-2 px-2">
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                          Apariencia
                        </p>
                        <div className="grid grid-cols-2 gap-1">
                          <button
                            type="button"
                            onClick={() => setTheme('light')}
                            className={cn(
                              'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                              effectiveTheme === 'light'
                                ? 'bg-sky-600/12 text-sky-700 dark:text-sky-300'
                                : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                            )}
                          >
                            <Sun className="h-3 w-3" />
                            Claro
                            {effectiveTheme === 'light' && <Check className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => setTheme('dark')}
                            className={cn(
                              'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                              effectiveTheme === 'dark'
                                ? 'bg-sky-600/12 text-sky-700 dark:text-sky-300'
                                : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                            )}
                          >
                            <Moon className="h-3 w-3" />
                            Oscuro
                            {effectiveTheme === 'dark' && <Check className="h-3 w-3" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <UserMenu
            profile={profile}
            activeCompany={activeCompany}
            permissions={permissions}
          />
        </div>
      </div>
    </header>
  )
}
