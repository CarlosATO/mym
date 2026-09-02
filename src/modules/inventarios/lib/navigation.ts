import { Boxes, ClipboardList, Eye, FileCheck2, Layers, LayoutDashboard, PlayCircle, Upload, Plus, type LucideIcon } from 'lucide-react'
import type { ModuleNavigation, ModuleNavItem, NavigationLocation } from '@/components/layout/module-shell-types'
import { INVENTORY_NAV_ITEMS } from './states'

const inventoryPath = '/dashboard/inventarios'

function inventoryTarget(pathname: string) {
  return {
    pathname,
    query: { inventoryId: undefined },
    preserveQuery: (key: string, value: string) => key === 'inventoryId' && value !== 'all',
  }
}

function inventoryMatcher(pathname: string) {
  return ({ pathname: currentPath }: NavigationLocation) => currentPath === pathname || currentPath.startsWith(`${pathname}/`)
}

const icons: Record<string, LucideIcon> = { LayoutDashboard, Layers, ClipboardList, Boxes, Upload, PlayCircle, Eye, FileCheck2 }

function toNavigationItem(item: typeof INVENTORY_NAV_ITEMS[number]): ModuleNavItem {
  const visibilityById: Partial<Record<typeof INVENTORY_NAV_ITEMS[number]['id'], string>> = {
    campanas: 'inventarios.campaigns.read',
    jornadas: 'inventarios.sessions.create',
    unidades: 'inventarios.sites.manage',
    importaciones: 'inventarios.imports.manage',
    operacion: 'inventarios.tasks.execute',
    revision: 'inventarios.sessions.approve',
    resultados: 'inventarios.campaigns.read',
  }
  const requiredPermission = visibilityById[item.id]

  return {
    id: item.id,
    label: item.label,
    icon: icons[item.icon],
    target: inventoryTarget(item.href),
    ...(requiredPermission ? { visibility: { allOf: [requiredPermission] } } : {}),
    active: item.id === 'resumen'
      ? ({ pathname }: NavigationLocation) => pathname === item.href
      : inventoryMatcher(item.href),
  }
}

const inventoryItems = INVENTORY_NAV_ITEMS.map(toNavigationItem)

export const inventoryNavigation: ModuleNavigation = {
  primaryAction: {
    id: 'nueva-seccion',
    label: 'Nueva sección de conteo',
    icon: Plus,
    visibility: { allOf: ['inventarios.sessions.create'] },
    target: inventoryTarget(`${inventoryPath}/jornadas/nueva`),
  },
  home: inventoryItems.find(item => item.id === 'resumen'),
  groups: [{ id: 'inventarios', items: inventoryItems.filter(item => item.id !== 'resumen') }],
}

export function getInventoryBreadcrumb({ pathname }: NavigationLocation) {
  const item = inventoryItems.find(candidate => {
    if (!('pathname' in candidate.target)) return false
    return candidate.id === 'resumen'
      ? pathname === candidate.target.pathname
      : pathname === candidate.target.pathname || pathname.startsWith(`${candidate.target.pathname}/`)
  })
  return ['Inventarios', item?.label ?? 'Inventarios']
}
