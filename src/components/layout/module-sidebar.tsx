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
  collapsed: boolean
  responsiveCollapsed: boolean
  mobileOpen: boolean
  permissions: string[]
  onToggle: () => void
  onNavigate: () => void
}

export function ModuleSidebar({ identity, navigation, collapsed, responsiveCollapsed, mobileOpen, permissions, onToggle, onNavigate }: ModuleSidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const location = { pathname, searchParams }
  const effectiveCollapsed = (collapsed || responsiveCollapsed) && !mobileOpen
  const visibleGroups = navigation.groups
    .map(group => ({ ...group, items: group.items.filter(item => isVisible(item, permissions)) }))
    .filter(group => group.items.length > 0)
  const home = navigation.home && isVisible(navigation.home, permissions) ? navigation.home : null
  const sidebarWidth = collapsed || responsiveCollapsed ? 'md:w-[68px]' : 'md:w-[244px]'
  const primaryAction = navigation.primaryAction && isVisible(navigation.primaryAction, permissions) ? navigation.primaryAction : null

  return (
    <aside className={cn(
      'fixed left-3 top-3 bottom-3 z-40 flex flex-col overflow-hidden rounded-[20px] border border-theme-sidebar-border bg-theme-sidebar-bg text-theme-sidebar-text shadow-lg transition-[width,transform] duration-200',
      sidebarWidth,
      mobileOpen ? 'translate-x-0 w-[244px]' : '-translate-x-[calc(100%+0.75rem)] md:translate-x-0'
    )}>
      <div className={cn('flex h-[76px] shrink-0 items-center border-b border-theme-sidebar-border bg-theme-sidebar-surface px-4', effectiveCollapsed && 'md:justify-center md:px-2')}>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {identity.icon && <identity.icon className="h-4 w-4 shrink-0 text-theme-sidebar-accent" />}
            <p className="truncate text-[11px] font-bold uppercase tracking-[0.22em] text-theme-sidebar-accent">{identity.label}</p>
          </div>
          {(!effectiveCollapsed || mobileOpen) && identity.subtitle && <p className="mt-1 truncate text-sm font-medium text-theme-sidebar-text">{identity.subtitle}</p>}
        </div>
      </div>

      {primaryAction && <PrimaryAction item={primaryAction} collapsed={effectiveCollapsed} searchParams={searchParams} onNavigate={onNavigate} />}

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {home && <SidebarItem item={home} location={location} collapsed={effectiveCollapsed} permissions={permissions} onNavigate={onNavigate} />}
        {visibleGroups.map(group => {
          const groupActive = group.items.some(item => isBranchActive(item, location))
          return (
            <div key={group.id} className="mt-5">
              {(!effectiveCollapsed || mobileOpen) && group.label && (
                <p className={cn('mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.16em]', groupActive ? 'text-theme-sidebar-accent' : 'text-theme-sidebar-muted')}>
                  {group.label}
                </p>
              )}
              {group.items.map(item => (
                <SidebarItem key={item.id} item={item} location={location} collapsed={effectiveCollapsed} permissions={permissions} onNavigate={onNavigate} />
              ))}
            </div>
          )
        })}
      </nav>

      <div className={cn('border-t border-theme-sidebar-border bg-theme-sidebar-surface p-3', effectiveCollapsed && 'md:px-2')}>
        <button
          title={collapsed ? 'Expandir navegación' : responsiveCollapsed ? 'Navegación compacta en este ancho' : 'Contraer navegación'}
          onClick={onToggle}
          className="hidden w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-theme-sidebar-muted hover:bg-theme-sidebar-hover hover:text-theme-sidebar-text md:flex"
        >
          {effectiveCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!effectiveCollapsed && 'Contraer menú'}
        </button>
      </div>
    </aside>
  )
}

function SidebarItem({ item, location, collapsed, permissions, onNavigate, depth = 0 }: { item: ModuleNavItem; location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }; collapsed: boolean; permissions: string[]; onNavigate: () => void; depth?: number }) {
  const children = (item.children ?? []).filter(child => isVisible(child, permissions))
  const childBranchActive = children.some(child => isBranchActive(child, location))
  // A parent remains visible as context, but only the selected child receives
  // the active treatment when this branch has a child selection.
  const active = isItemActive(item, location) && !childBranchActive
  const Icon = item.icon
  const href = buildNavHref(item.target, location.searchParams)
  const itemContent = (
    <>
      {Icon ? <Icon className={cn('h-[17px] w-[17px] shrink-0', active ? 'text-theme-sidebar-accent' : 'text-theme-sidebar-muted group-hover:text-theme-sidebar-text')} /> : <span className="h-[17px] w-[17px] shrink-0" />}
      {!collapsed && <span className="truncate">{item.label}</span>}
      {active && !collapsed && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-theme-sidebar-accent" />}
    </>
  )
  const className = cn(
    'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
    collapsed && 'md:justify-center md:px-2',
    !collapsed && depth === 1 && 'pl-8',
    !collapsed && depth >= 2 && 'pl-11',
    item.disabled
      ? 'cursor-not-allowed text-theme-sidebar-muted/50'
      : active
        ? 'bg-theme-sidebar-active/20 font-semibold text-theme-sidebar-active-text ring-1 ring-inset ring-theme-sidebar-accent/30'
        : 'text-theme-sidebar-muted hover:bg-theme-sidebar-hover hover:text-theme-sidebar-text'
  )

  if (item.disabled) {
    return <div title={collapsed ? item.label : undefined} className={className}>{itemContent}{children.map(child => <SidebarItem key={child.id} item={child} location={location} collapsed={collapsed} permissions={permissions} onNavigate={onNavigate} depth={depth + 1} />)}</div>
  }

  return (
    <>
      <Link href={href} title={collapsed ? item.label : undefined} onClick={onNavigate} className={className}>
        {itemContent}
      </Link>
      {children.map(child => <SidebarItem key={child.id} item={child} location={location} collapsed={collapsed} permissions={permissions} onNavigate={onNavigate} depth={depth + 1} />)}
    </>
  )
}

function PrimaryAction({ item, collapsed, searchParams, onNavigate }: { item: ModuleNavItem; collapsed: boolean; searchParams: Pick<URLSearchParams, 'get'>; onNavigate: () => void }) {
  const Icon = item.icon
  return (
    <div className={cn('shrink-0 py-2.5', collapsed ? 'px-2' : 'px-3')}>
      <Link
        href={buildNavHref(item.target, searchParams)}
        title={collapsed ? item.label : undefined}
        aria-label={item.label}
        onClick={onNavigate}
        className={cn('flex items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-2 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover', collapsed && 'px-0')}
      >
        {Icon && <Icon className="h-4 w-4 shrink-0" />}
        {!collapsed && <span>{item.label}</span>}
      </Link>
    </div>
  )
}

function isItemActive(item: ModuleNavItem, location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }) {
  return matchesActive(location, item.active, item.target)
}

function isBranchActive(item: ModuleNavItem, location: { pathname: string; searchParams: Pick<URLSearchParams, 'get' | 'has'> }): boolean {
  return isItemActive(item, location) || (item.children ?? []).some(child => isBranchActive(child, location))
}
