'use client'

import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { AppTopbar } from '@/components/layout/app-topbar'
import { cn } from '@/lib/utils'
import { ModuleSidebar } from './module-sidebar'
import type { BreadcrumbValue, ModuleIdentity, ModuleNavigation, NavigationLocation, SurfaceMode } from './module-shell-types'
import { usePathname, useSearchParams } from 'next/navigation'

type ModuleShellProps = {
  children: React.ReactNode
  identity: ModuleIdentity
  navigation: ModuleNavigation
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  activeCompany?: Company | null
  legacySidebarStorageKey?: string
  permissions?: string[]
  pageTitle: string
  breadcrumb: BreadcrumbValue
  surfaceMode?: SurfaceMode
  showPortalLink?: boolean
  topbarVariant?: 'default' | 'module'
}

const STORAGE_KEY = 'mym:erp-sidebar-collapsed'
const LEGACY_STORAGE_KEY = 'mym:wms-sidebar-collapsed'
const WIDE_VIEWPORT_QUERY = '(min-width: 1180px)'

export function ModuleShell({
  children,
  identity,
  navigation,
  profile,
  activeCompany: providedActiveCompany,
  legacySidebarStorageKey,
  permissions = [],
  pageTitle,
  breadcrumb,
  surfaceMode = 'standard',
  showPortalLink = false,
  topbarVariant = 'default',
}: ModuleShellProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [loadedActiveCompany, setLoadedActiveCompany] = useState<Company | null>(null)
  const [collapsed, setCollapsed] = useState(() => readCollapsedPreference(legacySidebarStorageKey))
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isWideViewport, setIsWideViewport] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE_VIEWPORT_QUERY).matches)

  useEffect(() => {
    if (providedActiveCompany === undefined) getActiveCompany().then(setLoadedActiveCompany)
  }, [providedActiveCompany])

  useEffect(() => {
    const mediaQuery = window.matchMedia(WIDE_VIEWPORT_QUERY)
    const handleViewportChange = () => setIsWideViewport(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleViewportChange)
    return () => mediaQuery.removeEventListener('change', handleViewportChange)
  }, [])

  const responsiveCollapsed = !isWideViewport
  const effectiveCollapsed = collapsed || responsiveCollapsed
  const location: NavigationLocation = { pathname, searchParams }
  const resolvedBreadcrumb = typeof breadcrumb === 'function' ? breadcrumb(location) : breadcrumb
  const activeCompany = providedActiveCompany === undefined ? loadedActiveCompany : providedActiveCompany

  function toggleCollapsed() {
    setCollapsed(value => {
      const next = !value
      window.localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }

  if (!activeCompany) return <div className="min-h-screen bg-theme-bg" />

  return (
    <div className="min-h-screen bg-theme-bg text-foreground">
      <AppTopbar
        profile={profile as never}
        activeCompany={activeCompany}
        permissions={permissions}
        showPortalLink={showPortalLink}
        variant={topbarVariant}
        sidebarMode={effectiveCollapsed ? 'compact' : 'expanded'}
      />

      {mobileOpen && <button aria-label="Cerrar navegación" className="fixed inset-0 z-30 bg-theme-sidebar-bg/70 md:hidden" onClick={() => setMobileOpen(false)} />}

      <ModuleSidebar
        identity={identity}
        navigation={navigation}
        collapsed={collapsed}
        responsiveCollapsed={responsiveCollapsed}
        mobileOpen={mobileOpen}
        permissions={permissions}
        onToggle={toggleCollapsed}
        onNavigate={() => setMobileOpen(false)}
      />

      <div className={cn('pt-12 transition-[padding] duration-200', effectiveCollapsed ? 'md:pl-[92px]' : 'md:pl-[268px]')}>
        <div className="flex h-12 items-center gap-3 border-b border-theme-border/70 bg-theme-surface/70 px-5 md:hidden">
          <button aria-label="Abrir navegación" onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text"><Menu className="h-5 w-5" /></button>
          <span className="text-sm font-semibold text-theme-text">{pageTitle}</span>
        </div>
        <main className="min-w-0 px-4 py-4 md:px-6 md:py-5">
          <div className="mb-3 flex min-w-0 items-center gap-2 px-1 text-[11px] text-theme-text-muted">
            {resolvedBreadcrumb.map((part, index) => <span key={`${part}-${index}`} className={cn(index === resolvedBreadcrumb.length - 1 ? 'font-semibold text-theme-text' : 'text-theme-text-muted/70')}>{index > 0 && <span className="mr-2 text-theme-border">/</span>}{part}</span>)}
          </div>
          {surfaceMode === 'none' ? children : (
            <section className={cn('overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface shadow-sm', surfaceMode === 'standard' ? 'min-h-[calc(100vh-7.5rem)]' : 'min-h-0')}>
              {children}
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

function readCollapsedPreference(legacyStorageKey = LEGACY_STORAGE_KEY) {
  if (typeof window === 'undefined') return false
  const globalValue = window.localStorage.getItem(STORAGE_KEY)
  if (globalValue !== null) return globalValue === 'true' || globalValue === '1'
  const legacyValue = window.localStorage.getItem(legacyStorageKey)
  return legacyValue === 'true' || legacyValue === '1'
}
