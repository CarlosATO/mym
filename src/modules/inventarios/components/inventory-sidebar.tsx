'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Boxes, Menu, PanelLeftClose, Plus, X } from 'lucide-react'
import { INVENTORY_NAV_ITEMS } from '@/modules/inventarios/lib/states'

const STORAGE_KEY = 'mym.inventory.sidebarCollapsed'

function isActivePath(pathname: string, href: string) {
  if (href === '/dashboard/inventarios') {
    return pathname === href
  }
  return pathname.startsWith(href)
}

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function SidebarContent({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean
  onToggle: () => void
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const inventoryId = searchParams.get('inventoryId')

  const navHref = (href: string) => {
    if (!inventoryId || inventoryId === 'all') return href
    const params = new URLSearchParams()
    params.set('inventoryId', inventoryId)
    return `${href}?${params.toString()}`
  }

  return (
    <nav className="flex h-full w-full flex-col" aria-label="Navegación de Inventarios">
      {/* Cabecera: encabezado del módulo + botón contraer (desktop) / cerrar (móvil) */}
      <div className={cn('flex h-12 shrink-0 items-center border-b border-theme-border/60', collapsed ? 'px-1.5' : 'justify-between px-3')}>
        <div className={cn('flex min-w-0 items-center gap-2', collapsed && 'flex-1 justify-center')}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-theme-accent/10 text-theme-accent">
            <Boxes className="h-4 w-4" />
          </span>
          {!collapsed && <span className="truncate text-sm font-bold text-theme-text">Inventarios</span>}
        </div>

        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expandir sidebar' : 'Contraer sidebar'}
            title={collapsed ? 'Expandir sidebar' : 'Contraer sidebar'}
            className="hidden h-7 w-7 items-center justify-center rounded-md text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text lg:flex"
          >
            <PanelLeftClose className={cn('h-4 w-4 transition-transform duration-200', collapsed && 'rotate-180')} />
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={onNavigate}
              aria-label="Cerrar menú"
              className="flex h-7 w-7 items-center justify-center rounded-md text-theme-text-muted transition-colors hover:bg-theme-text/5 lg:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Acción destacada */}
      <div className={cn('shrink-0 py-2.5', collapsed ? 'px-2' : 'px-3')}>
        <Link
          href={navHref('/dashboard/inventarios/jornadas/nueva')}
          title={collapsed ? 'Nueva sección de conteo' : undefined}
          aria-label="Nueva sección de conteo"
          onClick={onNavigate}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-2 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover',
            collapsed && 'px-0'
          )}
        >
          <Plus className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Nueva sección de conteo</span>}
        </Link>
      </div>

      {/* Items de navegación */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {INVENTORY_NAV_ITEMS.map(item => {
          const active = isActivePath(pathname, item.href)
          return (
            <Link
              key={item.id}
              href={navHref(item.href)}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
              className={cn(
                'group flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors',
                collapsed ? 'justify-center' : 'justify-start',
                active
                  ? 'bg-theme-accent/10 font-semibold text-theme-accent'
                  : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <span className={cn('h-2 w-2 rounded-full', active ? 'bg-theme-accent' : 'bg-transparent')} aria-hidden />
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

interface InventorySidebarProps {
  mobileOpen?: boolean
  onMobileOpen?: () => void
  onMobileClose?: () => void
}

export function InventorySidebar({ mobileOpen = false, onMobileOpen, onMobileClose }: InventorySidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedPreference)

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        // ignorar fallo de persistencia
      }
      return next
    })
  }, [])

  const width = collapsed ? 64 : 224

  return (
    <>
      {/* Desktop: sidebar fijo contraíble */}
      <aside
        className="sticky top-12 hidden h-[calc(100vh-3rem)] shrink-0 border-r border-theme-border bg-theme-bg/70 backdrop-blur-md lg:block"
        style={{ width }}
      >
        <SidebarContent collapsed={collapsed} onToggle={toggleCollapsed} />
      </aside>

      {/* Móvil: botón + drawer */}
      <button
        type="button"
        onClick={onMobileOpen}
        className="fixed left-3 top-16 z-30 flex h-9 w-9 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted shadow-sm lg:hidden"
        aria-label="Abrir menú de Inventarios"
      >
        <Menu className="h-4 w-4" />
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onMobileClose} aria-hidden />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 border-r border-theme-border bg-theme-bg transition-transform duration-200 lg:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        style={{ width }}
        aria-hidden={!mobileOpen}
      >
        <SidebarContent collapsed={false} onToggle={toggleCollapsed} onNavigate={onMobileClose} />
      </aside>
    </>
  )
}
