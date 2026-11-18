'use client'

import Link from 'next/link'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  buildNavHref,
  isVisible,
  matchesActive,
  type ModuleIdentity,
  type ModuleNavGroup,
  type ModuleNavItem,
} from './module-shell-types'

type ModuleSidebarProps = {
  identity: ModuleIdentity
  navigation: { home?: ModuleNavItem; primaryAction?: ModuleNavItem; groups: ModuleNavGroup[] }
  expanded: boolean
  railOpen?: boolean
  mobileOpen: boolean
  mobileViewport: boolean
  permissions: string[]
  variant: 'default' | 'financial'
  onToggle: () => void
  onNavigate: () => void
}

function cleanShortLabel(label: string): string {
  // Limpia prefijos numéricos como "01  Vista general" para que el texto bajo el ícono quede limpio estilo Bsale
  return label.replace(/^\d+\s+/, '').trim()
}

export function ModuleSidebar({
  identity,
  navigation,
  expanded,
  railOpen = true,
  mobileOpen,
  mobileViewport,
  permissions,
  variant,
  onToggle,
  onNavigate,
}: ModuleSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const location = { pathname, searchParams }
  const effectiveCollapsed = !expanded
  const visibleGroups = navigation.groups
    .map(group => ({ ...group, items: group.items.filter(item => isVisible(item, permissions)) }))
    .filter(group => group.items.length > 0)
  const home = navigation.home && isVisible(navigation.home, permissions) ? navigation.home : null
  const sidebarWidth = expanded ? 'md:w-[244px]' : 'md:w-[68px]'
  const primaryAction = navigation.primaryAction && isVisible(navigation.primaryAction, permissions) ? navigation.primaryAction : null
  const toggleLabel = expanded ? 'Contraer navegación' : 'Expandir navegación'

  const isVisibleOnDesktop = railOpen

  return (
    <aside
      id="module-sidebar"
      inert={(mobileViewport && !mobileOpen) || (!mobileViewport && !isVisibleOnDesktop) ? true : undefined}
      aria-hidden={(mobileViewport && !mobileOpen) || (!mobileViewport && !isVisibleOnDesktop) ? true : undefined}
      data-width-contract={sidebarWidth}
      className={cn(
        'fixed left-0 top-12 bottom-0 z-30 flex w-[92px] flex-col overflow-hidden bg-theme-bg text-theme-text transition-all duration-200 select-none',
        mobileOpen
          ? 'translate-x-0 w-[220px] border-r border-theme-border bg-theme-surface shadow-xl'
          : '-translate-x-full',
        isVisibleOnDesktop
          ? 'md:translate-x-0 md:w-[92px] md:opacity-100'
          : 'md:-translate-x-full md:opacity-0 md:pointer-events-none'
      )}
    >
      {/* Cabecera visible solo en drawer móvil */}
      {mobileOpen && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-theme-border/70 px-4 md:hidden">
          {identity.icon && <identity.icon className="h-4 w-4 shrink-0 text-sky-600" />}
          <p className="truncate text-xs font-bold uppercase tracking-wider text-theme-text">
            {identity.label}
          </p>
        </div>
      )}

      {primaryAction && (
        <PrimaryAction
          item={primaryAction}
          collapsed={effectiveCollapsed}
          searchParams={searchParams}
          onNavigate={onNavigate}
        />
      )}

      {/* Rail vertical estilo Bsale (Ícono arriba + Texto corto abajo) */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {home && (
          <SidebarItem
            item={home}
            location={location}
            collapsed={effectiveCollapsed}
            mobileOpen={mobileOpen}
            permissions={permissions}
            variant={variant}
            onNavigate={onNavigate}
          />
        )}

        {visibleGroups.map((group, groupIndex) => (
          <div
            key={group.id}
            className={cn(
              'space-y-1.5',
              (home || groupIndex > 0) && 'pt-2 border-t border-theme-border/50'
            )}
          >
            {group.items.map(item => (
              <SidebarItem
                key={item.id}
                item={item}
                location={location}
                collapsed={effectiveCollapsed}
                mobileOpen={mobileOpen}
                permissions={permissions}
                variant={variant}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Pie con botón para ocultar completamente el riel */}
      <div className={cn('shrink-0 border-t p-3', 'border-theme-border/50 bg-theme-bg/80', effectiveCollapsed && 'md:px-2')}>
        <button
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          aria-controls="module-sidebar"
          onClick={onToggle}
          className="hidden w-full flex-col items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/6 hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 md:flex"
        >
          {effectiveCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          <span>Ocultar</span>
        </button>
      </div>
    </aside>
  )
}

function SidebarItem({
  item,
  location,
  collapsed,
  mobileOpen = false,
  permissions,
  variant,
  onNavigate,
  depth = 0,
}: {
  item: ModuleNavItem
  location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }
  collapsed: boolean
  mobileOpen?: boolean
  permissions: string[]
  variant: 'default' | 'financial'
  onNavigate: () => void
  depth?: number
}) {
  const children = (item.children ?? []).filter(child => isVisible(child, permissions))
  const childBranchActive = children.some(child => isBranchActive(child, location))
  // A parent remains visible as context, but only the selected child receives
  // the active treatment when this branch has a child selection.
  const active = isItemActive(item, location) && !childBranchActive
  const isHighlighted = active || (depth === 0 && childBranchActive)
  const Icon = item.icon
  const href = buildNavHref(item.target, location.searchParams)
  const displayLabel = cleanShortLabel(item.label)

  // Sub-ítems (depth > 0): mostrar como píldora compacta debajo del padre cuando la rama está activa
  if (depth > 0) {
    return (
      <Link
        href={href}
        title={item.label}
        aria-label={collapsed ? item.label : undefined}
        onClick={onNavigate}
        className={cn(
          'block w-full rounded-lg px-1.5 py-1 text-center text-[10px] leading-tight transition-colors',
          active
            ? 'bg-sky-500/15 font-bold text-sky-700 dark:text-sky-300'
            : 'font-medium text-theme-text-muted hover:bg-theme-text/6 hover:text-theme-text'
        )}
      >
        <span className="line-clamp-2">{displayLabel}</span>
      </Link>
    )
  }

  const itemContent = mobileOpen ? (
    <div className="flex w-full items-center gap-3 px-2 py-1">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors',
          isHighlighted
            ? 'bg-sky-500/15 text-sky-600 dark:bg-sky-400/20 dark:text-sky-300'
            : 'text-theme-text-muted group-hover:bg-theme-text/6 group-hover:text-theme-text'
        )}
      >
        {Icon && <Icon className="h-[18px] w-[18px]" />}
      </div>
      <span
        className={cn(
          'truncate text-xs',
          isHighlighted ? 'font-bold text-sky-600 dark:text-sky-400' : 'font-medium text-theme-text'
        )}
      >
        {displayLabel}
      </span>
    </div>
  ) : (
    <div className="flex w-full flex-col items-center justify-center py-1 text-center">
      {/* Contenedor del ícono estilo Bsale */}
      <div
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-150',
          isHighlighted
            ? 'bg-sky-500/16 text-sky-600 shadow-2xs dark:bg-sky-400/20 dark:text-sky-300'
            : 'text-slate-500 group-hover:bg-slate-200/70 group-hover:text-slate-800 dark:text-slate-400 dark:group-hover:bg-white/10 dark:group-hover:text-white'
        )}
      >
        {Icon ? (
          <Icon className="h-[20px] w-[20px] shrink-0" />
        ) : (
          <span className="text-[11px] font-bold">{displayLabel.slice(0, 2).toUpperCase()}</span>
        )}
      </div>

      {/* Etiqueta corta centrada debajo del ícono estilo Bsale */}
      <span
        className={cn(
          'mt-1 w-full px-0.5 text-center text-[10.5px] leading-[1.2] tracking-tight line-clamp-2 break-words transition-colors',
          isHighlighted
            ? 'font-bold text-sky-600 dark:text-sky-400'
            : 'font-medium text-slate-600 group-hover:text-slate-900 dark:text-slate-400 dark:group-hover:text-white'
        )}
      >
        {displayLabel}
      </span>
    </div>
  )

  const className = cn(
    'group flex w-full flex-col items-center justify-center rounded-xl transition-colors',
    item.disabled && 'cursor-not-allowed opacity-45'
  )

  if (item.disabled) {
    return (
      <div
        title={collapsed ? item.label : undefined}
        aria-label={collapsed ? item.label : undefined}
        className={className}
      >
        {itemContent}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <Link
        href={href}
        title={collapsed ? item.label : undefined}
        aria-label={collapsed ? item.label : undefined}
        onClick={onNavigate}
        className={className}
      >
        {itemContent}
      </Link>
      {children.length > 0 && (active || childBranchActive) && (
        <div className="space-y-0.5 pt-0.5">
          {children.map(child => (
            <SidebarItem
              key={child.id}
              item={child}
              location={location}
              collapsed={collapsed}
              mobileOpen={mobileOpen}
              permissions={permissions}
              variant={variant}
              onNavigate={onNavigate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PrimaryAction({
  item,
  collapsed,
  searchParams,
  onNavigate,
}: {
  item: ModuleNavItem
  collapsed: boolean
  searchParams: Pick<URLSearchParams, 'get'>
  onNavigate: () => void
}) {
  const Icon = item.icon
  return (
    <div className="shrink-0 px-2 pt-3 pb-1">
      <Link
        href={buildNavHref(item.target, searchParams)}
        title={collapsed ? item.label : undefined}
        aria-label={item.label}
        onClick={onNavigate}
        className="group flex flex-col items-center justify-center text-center"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-600 text-white shadow-xs transition-colors group-hover:bg-sky-700">
          {Icon && <Icon className="h-5 w-5 shrink-0" />}
        </div>
        <span className="mt-1 text-[10px] font-bold leading-tight text-sky-700 dark:text-sky-300 line-clamp-2">
          {cleanShortLabel(item.label)}
        </span>
      </Link>
    </div>
  )
}

function isItemActive(
  item: ModuleNavItem,
  location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }
) {
  return matchesActive(location, item.active, item.target)
}

function isBranchActive(
  item: ModuleNavItem,
  location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }
): boolean {
  return (
    isItemActive(item, location) ||
    (item.children ?? []).some(child => isBranchActive(child, location))
  )
}
