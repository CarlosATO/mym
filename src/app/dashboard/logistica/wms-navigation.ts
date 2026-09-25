import type { ActiveMatcher, ModuleNavigation, NavigationLocation } from '@/components/layout/module-shell-types'
import { Archive, ArrowLeft, ArrowLeftRight, CalendarDays, ChartNoAxesCombined, ClipboardList, FileBarChart, GitMerge, History, House, Layers3, Map, Package, PackageOpen, ShieldCheck, ShoppingCart, SlidersHorizontal, Warehouse, Trash2, WalletCards } from 'lucide-react'

const logisticaPath = '/dashboard/logistica'
const actionIds = new Set(['resumen', 'bodegas', 'ubicaciones', 'productos', 'calendario_despacho', 'preparacion_pedidos', 'recepciones', 'traspasos', 'ajustes', 'guias_ruta', 'stock', 'kardex', 'trazabilidad', 'reportes_log'])

function actionTarget(tab: string, action: string) {
  return { pathname: logisticaPath, query: { tab, action } }
}

function actionMatcher(action: string): ActiveMatcher {
  return ({ searchParams }: NavigationLocation) => searchParams.get('action') === action
}

function mermasViewMatcher(view?: string): ActiveMatcher {
  return ({ pathname, searchParams }: NavigationLocation) => {
    const basePath = '/dashboard/logistica/mermas'
    if (view !== undefined || pathname === basePath) {
      if (pathname !== basePath) return false
    } else if (!pathname.startsWith(`${basePath}/`) || ['/salidas', '/venta-trabajadores', '/cuenta-corriente', '/revision-pagos', '/informes'].some((suffix) => pathname.startsWith(`${basePath}${suffix}`))) {
      return false
    }
    return (searchParams.get('view') ?? 'requests') === (view ?? 'requests')
  }
}

function mermasPathMatcher(pathname: string): ActiveMatcher {
  return ({ pathname: currentPath }: NavigationLocation) => currentPath === pathname || currentPath.startsWith(`${pathname}/`)
}

export const wmsNavigation: ModuleNavigation = {
  home: {
    id: 'inicio',
    label: 'Inicio',
    icon: House,
    target: actionTarget('inicio', 'resumen'),
    visibility: { allOf: ['module.logistica.view'] },
    active: ({ pathname, searchParams }: NavigationLocation) => {
      const action = searchParams.get('action')
      if (!action) return pathname === logisticaPath
      return action === 'resumen' || !actionIds.has(action)
    },
  },
  groups: [
    {
      id: 'parametros',
      label: 'Parámetros',
      items: [
        { id: 'bodegas', label: 'Bodegas', icon: Warehouse, target: actionTarget('catalogos', 'bodegas'), active: actionMatcher('bodegas'), visibility: { allOf: ['adquisiciones.warehouses.view'] } },
        { id: 'productos', label: 'Productos', icon: Package, target: actionTarget('catalogos', 'productos'), active: actionMatcher('productos'), visibility: { allOf: ['adquisiciones.products.view'] } },
        { id: 'calendario_despacho', label: 'Calendario de Despacho', icon: CalendarDays, target: actionTarget('catalogos', 'calendario_despacho'), active: actionMatcher('calendario_despacho'), visibility: { allOf: ['system.admin'] } },
      ],
    },
    {
      id: 'movimientos',
      label: 'Movimientos',
      items: [
        { id: 'recepciones', label: 'Recepciones', icon: PackageOpen, target: actionTarget('movimientos', 'recepciones'), active: ({ pathname, searchParams }: NavigationLocation) => pathname.startsWith('/dashboard/logistica/recepciones/') && !searchParams.has('action') || searchParams.get('action') === 'recepciones', visibility: { allOf: ['adquisiciones.po.view'] } },
        { id: 'traspasos', label: 'Traspasos', icon: ArrowLeftRight, target: actionTarget('movimientos', 'traspasos'), active: actionMatcher('traspasos'), visibility: { allOf: ['system.admin'] } },
        { id: 'ajustes', label: 'Ajustes', icon: SlidersHorizontal, target: actionTarget('movimientos', 'ajustes'), active: actionMatcher('ajustes'), visibility: { allOf: ['system.admin'] } },
        { id: 'preparacion_pedidos', label: 'Preparación de Pedidos', icon: ClipboardList, target: actionTarget('preparacion_pedidos', 'preparacion_pedidos'), active: actionMatcher('preparacion_pedidos'), visibility: { allOf: ['logistica.preparation.manage'] } },
        { id: 'guias_ruta', label: 'Guías de Ruta', icon: Map, target: actionTarget('movimientos', 'guias_ruta'), active: ({ pathname, searchParams }: NavigationLocation) => pathname === '/dashboard/logistica/guias-ruta' && !searchParams.has('action') || searchParams.get('action') === 'guias_ruta', visibility: { allOf: ['logistica.route_guides.view'] } },
        { id: 'mermas', label: 'Mermas', icon: Trash2, target: { href: '/dashboard/logistica/mermas' }, active: ({ pathname }: NavigationLocation) => pathname.startsWith('/dashboard/logistica/mermas'), visibility: { allOf: ['logistica.mermas.view'] } },
      ],
    },
    {
      id: 'consultas',
      label: 'Consultas',
      items: [
        { id: 'stock', label: 'Stock', icon: Layers3, target: actionTarget('consultas', 'stock'), active: actionMatcher('stock'), visibility: { allOf: ['logistica.stock.view'] } },
        { id: 'kardex', label: 'Kardex', icon: History, target: actionTarget('consultas', 'kardex'), active: actionMatcher('kardex'), visibility: { allOf: ['logistica.kardex.view'] } },
        { id: 'trazabilidad', label: 'Trazabilidad', icon: GitMerge, target: actionTarget('consultas', 'trazabilidad'), active: actionMatcher('trazabilidad'), visibility: { allOf: ['system.admin'] } },
      ],
    },
    {
      id: 'reportes',
      label: 'Reportes',
      items: [
        { id: 'reportes_log', label: 'Reportes de Almacén', icon: ChartNoAxesCombined, target: actionTarget('reportes', 'reportes_log'), active: actionMatcher('reportes_log'), visibility: { allOf: ['system.admin'] } },
      ],
    },
  ],
}

export const mermasNavigation: ModuleNavigation = {
  home: {
    id: 'mermas_back',
    label: 'Volver a Gestión de Bodega',
    icon: ArrowLeft,
    target: { href: '/dashboard/logistica' },
    active: () => false,
    visibility: { allOf: ['module.logistica.view'] },
  },
  groups: [
    {
      id: 'mermas_operacion',
      label: 'Operación',
      items: [
        { id: 'mermas_solicitud', label: 'Solicitud de merma', icon: Trash2, target: { href: '/dashboard/logistica/mermas' }, active: mermasViewMatcher(), visibility: { allOf: ['logistica.mermas.view'] } },
        { id: 'mermas_bodega', label: 'Bodega de Mermas', icon: Warehouse, target: { pathname: '/dashboard/logistica/mermas', query: { view: 'warehouse' } }, active: mermasViewMatcher('warehouse'), visibility: { allOf: ['logistica.mermas.warehouse.view'] } },
        { id: 'mermas_salidas', label: 'Salidas', icon: ArrowLeftRight, target: { href: '/dashboard/logistica/mermas/salidas' }, active: mermasPathMatcher('/dashboard/logistica/mermas/salidas'), visibility: { allOf: ['system.admin'] } },
        { id: 'mermas_venta_trabajadores', label: 'Venta a trabajadores', icon: ShoppingCart, target: { href: '/dashboard/logistica/mermas/venta-trabajadores' }, active: mermasPathMatcher('/dashboard/logistica/mermas/venta-trabajadores'), visibility: { allOf: ['logistica.mermas.internal_sale.create'] } },
      ],
    },
    {
      id: 'mermas_control',
      label: 'Control',
      items: [
        { id: 'mermas_autorizacion', label: 'Pendientes de autorización', icon: ShieldCheck, target: { pathname: '/dashboard/logistica/mermas', query: { view: 'authorization' } }, active: mermasViewMatcher('authorization'), visibility: { allOf: ['logistica.mermas.authorize'] } },
        { id: 'mermas_cuenta', label: 'Cuenta corriente', icon: WalletCards, target: { href: '/dashboard/logistica/mermas/cuenta-corriente' }, active: mermasPathMatcher('/dashboard/logistica/mermas/cuenta-corriente'), visibility: { allOf: ['logistica.mermas.account.view'] } },
        { id: 'mermas_archivadas', label: 'Archivadas', icon: Archive, target: { pathname: '/dashboard/logistica/mermas', query: { view: 'archived' } }, active: mermasViewMatcher('archived'), visibility: { allOf: ['logistica.mermas.view'] } },
      ],
    },
    {
      id: 'mermas_analisis',
      label: 'Análisis',
      items: [
        { id: 'mermas_informe', label: 'Informe de Mermas', icon: FileBarChart, target: { href: '/dashboard/logistica/mermas/informes' }, active: mermasPathMatcher('/dashboard/logistica/mermas/informes'), visibility: { allOf: ['logistica.mermas.view'] } },
      ],
    },
    {
      id: 'mermas_configuracion',
      label: 'Configuración',
      items: [
        { id: 'mermas_config', label: 'Configuración de Mermas', icon: SlidersHorizontal, target: { pathname: '/dashboard/logistica/mermas', query: { view: 'configuration' } }, active: mermasViewMatcher('configuration'), visibility: { allOf: ['system.admin'] } },
      ],
    },
  ],
}

export function getWmsNavigation(pathname: string): ModuleNavigation {
  return pathname.startsWith('/dashboard/logistica/mermas') ? mermasNavigation : wmsNavigation
}
