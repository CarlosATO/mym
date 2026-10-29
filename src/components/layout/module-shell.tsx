'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Menu } from 'lucide-react'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { cn } from '@/lib/utils'
import { ModuleSidebar } from './module-sidebar'
import { resolveSidebarState, type ViewportMode } from './module-sidebar-state'
import { financialThemeStyle } from './theme-variants'
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
  sidebarVariant?: 'default' | 'financial'
  themeVariant?: 'default' | 'financial'
  hideSidebar?: boolean
  breadcrumbAccessoryId?: string
}

const STORAGE_KEY = 'mym:erp-sidebar-collapsed'
const LEGACY_STORAGE_KEY = 'mym:wms-sidebar-collapsed'
const PREFERENCE_EVENT = 'mym:sidebar-preference-change'
const WIDE_VIEWPORT_QUERY = '(min-width: 1536px)'
const MOBILE_VIEWPORT_QUERY = '(max-width: 767px)'

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
  sidebarVariant = 'default',
  themeVariant = 'default',
  hideSidebar = false,
  breadcrumbAccessoryId,
}: ModuleShellProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [loadedActiveCompany, setLoadedActiveCompany] = useState<Company | null>(null)
  const collapsed = useSidebarCollapsedPreference(legacySidebarStorageKey)
  const [temporaryExpanded, setTemporaryExpanded] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const isWideViewport = useViewportQuery(WIDE_VIEWPORT_QUERY)
  const isMobileViewport = useViewportQuery(MOBILE_VIEWPORT_QUERY)
  const viewport: ViewportMode = isMobileViewport ? 'mobile' : isWideViewport ? 'wide' : 'medium'
  const navigationKey = `${pathname}|${viewport}`
  const [lastNavigationKey, setLastNavigationKey] = useState(navigationKey)

  if (navigationKey !== lastNavigationKey) {
    setLastNavigationKey(navigationKey)
    setTemporaryExpanded(false)
    setMobileOpen(false)
  }

  const sidebarState = resolveSidebarState({
    viewport,
    desktopCollapsed: collapsed,
    temporaryExpanded,
    mobileOpen,
  })
  const mobileDrawerOpen = !hideSidebar && viewport === 'mobile' && mobileOpen
  const mediumOverlayOpen = !hideSidebar && viewport === 'medium' && sidebarState.overlay

  useEffect(() => {
    if (providedActiveCompany === undefined) getActiveCompany().then(setLoadedActiveCompany)
  }, [providedActiveCompany])

  useEffect(() => {
    if (!temporaryExpanded && !mobileOpen) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setTemporaryExpanded(false)
      setMobileOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [temporaryExpanded, mobileOpen])

  const location: NavigationLocation = { pathname, searchParams }
  const resolvedBreadcrumb = typeof breadcrumb === 'function' ? breadcrumb(location) : breadcrumb
  const activeCompany = providedActiveCompany === undefined ? loadedActiveCompany : providedActiveCompany

  // Notifica al AppTopbar persistente (en DashboardLayoutClient) cuánto padding aplicar.
  // En pantallas medianas el overlay temporal no reserva ancho expandido.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('mym:sidebar-change', {
        detail: {
          collapsed: hideSidebar ? false : sidebarState.reserveCollapsed,
          overlay: hideSidebar ? false : sidebarState.overlay,
        },
      })
    )
  }, [hideSidebar, sidebarState.reserveCollapsed, sidebarState.overlay])

  function closeOverlays() {
    setTemporaryExpanded(false)
    setMobileOpen(false)
  }

  function toggleSidebar() {
    if (viewport === 'wide') {
      window.localStorage.setItem(STORAGE_KEY, String(!collapsed))
      window.dispatchEvent(new Event(PREFERENCE_EVENT))
      return
    }

    if (viewport === 'mobile') {
      setMobileOpen(value => !value)
      return
    }

    setTemporaryExpanded(value => !value)
  }

  if (!activeCompany) return <div className="min-h-screen bg-theme-bg" />

  return (
    <div
      className="min-h-screen bg-theme-bg text-foreground"
      style={themeVariant === 'financial' ? financialThemeStyle : undefined}
    >

      {mobileDrawerOpen && <button aria-label="Cerrar navegación" className="fixed inset-0 z-30 bg-theme-sidebar-bg/70 md:hidden" onClick={() => setMobileOpen(false)} />}
      {mediumOverlayOpen && <button aria-label="Cerrar navegación" className="fixed inset-0 z-30 bg-theme-sidebar-bg/50" onClick={() => setTemporaryExpanded(false)} />}

      {!hideSidebar && <ModuleSidebar
        identity={identity}
        navigation={navigation}
        expanded={sidebarState.expanded}
        mobileOpen={mobileDrawerOpen}
        mobileViewport={viewport === 'mobile'}
        permissions={permissions}
        variant={sidebarVariant}
        onToggle={toggleSidebar}
        onNavigate={closeOverlays}
      />}

      <div className={cn('pt-12 transition-[padding] duration-200', hideSidebar ? 'md:pl-0' : sidebarState.reserveCollapsed ? 'md:pl-[92px]' : 'md:pl-[268px]')}>
        {!hideSidebar && <div className="flex h-12 items-center gap-3 border-b border-theme-border/70 bg-theme-surface/70 px-5 md:hidden">
          <button
            aria-label="Abrir navegación"
            aria-expanded={mobileDrawerOpen}
            aria-controls="module-sidebar"
            onClick={() => setMobileOpen(true)}
            className="rounded-md p-1.5 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-theme-text">{pageTitle}</span>
        </div>}
        <main className="min-w-0 px-4 py-4 md:px-6 md:py-5">
          <div className="mb-3 flex min-w-0 items-center gap-2 px-1 text-[11px] text-theme-text-muted">
            {resolvedBreadcrumb.map((part, index) => <span key={`${part}-${index}`} className={cn(breadcrumbAccessoryId && 'shrink-0 whitespace-nowrap', index === resolvedBreadcrumb.length - 1 ? 'font-semibold text-theme-text' : 'text-theme-text-muted/70')}>{index > 0 && <span className="mr-2 text-theme-border">/</span>}{part}</span>)}
            {breadcrumbAccessoryId && <div id={breadcrumbAccessoryId} className="ml-auto min-w-0 flex-1" />}
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

function useViewportQuery(query: string) {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const mediaQuery = window.matchMedia(query)
    mediaQuery.addEventListener('change', onStoreChange)
    return () => mediaQuery.removeEventListener('change', onStoreChange)
  }, [query])

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

function useSidebarCollapsedPreference(legacyStorageKey?: string) {
  const subscribe = useCallback((onStoreChange: () => void) => {
    function handleStorage(event: StorageEvent) {
      if (event.key === null || event.key === STORAGE_KEY || event.key === legacyStorageKey || event.key === LEGACY_STORAGE_KEY) {
        onStoreChange()
      }
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener(PREFERENCE_EVENT, onStoreChange)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(PREFERENCE_EVENT, onStoreChange)
    }
  }, [legacyStorageKey])

  const getSnapshot = useCallback(
    () => readCollapsedPreference(legacyStorageKey),
    [legacyStorageKey],
  )

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

function readCollapsedPreference(legacyStorageKey = LEGACY_STORAGE_KEY) {
  if (typeof window === 'undefined') return false
  const globalValue = window.localStorage.getItem(STORAGE_KEY)
  if (globalValue !== null) return globalValue === 'true' || globalValue === '1'
  const legacyValue = window.localStorage.getItem(legacyStorageKey)
  return legacyValue === 'true' || legacyValue === '1'
}
