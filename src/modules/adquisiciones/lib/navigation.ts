import { BarChart3, FileText, LayoutDashboard, Route, ShoppingCart, Users, Warehouse, type LucideIcon } from 'lucide-react'
import type { ModuleNavigation, NavigationLocation } from '@/components/layout/module-shell-types'

const basePath = '/dashboard/adquisiciones'

const routes = {
  home: basePath,
  suppliers: `${basePath}/catalogos/proveedores`,
  catalog: `${basePath}/catalogos/catalogo`,
  warehouses: `${basePath}/catalogos/bodegas`,
  replenishment: `${basePath}/reposicion`,
  purchaseOrders: `${basePath}/ordenes-compra`,
  routeSettlements: `${basePath}/rendicion-rutas`,
} as const

const icons: Record<keyof typeof routes, LucideIcon> = {
  home: LayoutDashboard,
  suppliers: Users,
  catalog: FileText,
  warehouses: Warehouse,
  replenishment: BarChart3,
  purchaseOrders: ShoppingCart,
  routeSettlements: Route,
}

function exact(pathname: string) {
  return ({ pathname: currentPath }: NavigationLocation) => currentPath === pathname
}

function prefix(pathname: string) {
  return ({ pathname: currentPath }: NavigationLocation) => currentPath === pathname || currentPath.startsWith(`${pathname}/`)
}

export const adquisicionesNavigation: ModuleNavigation = {
  home: {
    id: 'inicio',
    label: 'Inicio',
    icon: icons.home,
    target: { href: routes.home },
    active: exact(routes.home),
  },
  groups: [
    {
      id: 'catalogos',
      label: 'Catálogos',
      items: [
        { id: 'proveedores', label: 'Proveedores', icon: icons.suppliers, target: { href: routes.suppliers }, active: prefix(routes.suppliers) },
        { id: 'catalogo', label: 'Catálogo', icon: icons.catalog, target: { href: routes.catalog }, active: prefix(routes.catalog) },
        { id: 'bodegas', label: 'Bodegas', icon: icons.warehouses, target: { href: routes.warehouses }, active: prefix(routes.warehouses) },
      ],
    },
    {
      id: 'analisis-compras',
      label: 'Análisis y Compras',
      items: [
        { id: 'reposicion', label: 'Análisis de reposición', icon: icons.replenishment, target: { href: routes.replenishment }, active: prefix(routes.replenishment) },
        { id: 'ordenes-compra', label: 'Órdenes de compra', icon: icons.purchaseOrders, target: { href: routes.purchaseOrders }, active: prefix(routes.purchaseOrders) },
      ],
    },
    {
      id: 'operacion',
      label: 'Operación',
      items: [
        {
          id: 'rendicion-rutas',
          label: 'Rendición de rutas',
          icon: icons.routeSettlements,
          target: { href: routes.routeSettlements },
          active: prefix(routes.routeSettlements),
          visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
          children: [
            {
              id: 'rendicion-rutas-bandeja',
              label: 'Bandeja de Rendiciones',
              target: { pathname: routes.routeSettlements, query: { tab: 'tray' } },
              active: ({ pathname, searchParams }) => pathname === routes.routeSettlements && (searchParams.get('tab') === null || searchParams.get('tab') === 'tray'),
              visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
            },
            {
              id: 'rendicion-rutas-cobros-posteriores',
              label: 'Cobros posteriores',
              target: { pathname: routes.routeSettlements, query: { tab: 'post-collections' } },
              active: { pathname: { exact: routes.routeSettlements }, query: { tab: 'post-collections' } },
              visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
            },
             {
               id: 'rendicion-rutas-cierre-fondos',
              label: 'Cierre de Fondos',
              target: { pathname: routes.routeSettlements, query: { tab: 'fund-closures' } },
              active: { pathname: { exact: routes.routeSettlements }, query: { tab: 'fund-closures' } },
               visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
             },
             {
                id: 'rendicion-rutas-depositos',
                label: 'Depósitos',
                target: { pathname: routes.routeSettlements, query: { tab: 'deposits' } },
                active: { pathname: { exact: routes.routeSettlements }, query: { tab: 'deposits' } },
                visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
              },
              {
                id: 'rendicion-rutas-cheques',
               label: 'Cheques',
               target: { pathname: routes.routeSettlements, query: { tab: 'checks' } },
               active: { pathname: { exact: routes.routeSettlements }, query: { tab: 'checks' } },
               visibility: { anyOf: ['adquisiciones.route_settlements.view', 'system.admin'] },
             },
           ],
        },
      ],
    },
  ],
}

export function getAdquisicionesBreadcrumb({ pathname }: NavigationLocation) {
  if (pathname === routes.home) return ['Adquisiciones']
  if (pathname.startsWith(routes.suppliers)) return ['Adquisiciones', 'Catálogos', 'Proveedores']
  if (pathname.startsWith(routes.catalog)) return ['Adquisiciones', 'Catálogos', 'Catálogo']
  if (pathname.startsWith(routes.warehouses)) return ['Adquisiciones', 'Catálogos', 'Bodegas']
  if (pathname.startsWith(routes.replenishment)) return ['Adquisiciones', 'Análisis y Compras', 'Análisis de reposición']
  if (pathname.startsWith(routes.purchaseOrders)) return ['Adquisiciones', 'Análisis y Compras', 'Órdenes de compra']
  if (pathname.startsWith(routes.routeSettlements)) return ['Adquisiciones', 'Operación', 'Rendición de rutas']
  return ['Adquisiciones']
}
