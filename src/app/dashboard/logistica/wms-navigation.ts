import type { ActiveMatcher, ModuleNavigation, NavigationLocation } from '@/components/layout/module-shell-types'
import { ArrowLeftRight, CalendarDays, ChartNoAxesCombined, ClipboardList, GitMerge, History, House, Layers3, Map, Package, PackageOpen, SlidersHorizontal, Warehouse } from 'lucide-react'

const logisticaPath = '/dashboard/logistica'
const actionIds = new Set(['resumen', 'bodegas', 'ubicaciones', 'productos', 'calendario_despacho', 'preparacion_pedidos', 'recepciones', 'traspasos', 'ajustes', 'guias_ruta', 'stock', 'kardex', 'trazabilidad', 'reportes_log'])

function actionTarget(tab: string, action: string) {
  return { pathname: logisticaPath, query: { tab, action } }
}

function actionMatcher(action: string): ActiveMatcher {
  return ({ searchParams }: NavigationLocation) => searchParams.get('action') === action
}

export const wmsNavigation: ModuleNavigation = {
  home: {
    id: 'inicio',
    label: 'Inicio',
    icon: House,
    target: actionTarget('inicio', 'resumen'),
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
        { id: 'bodegas', label: 'Bodegas', icon: Warehouse, target: actionTarget('catalogos', 'bodegas'), active: actionMatcher('bodegas') },
        { id: 'productos', label: 'Productos', icon: Package, target: actionTarget('catalogos', 'productos'), active: actionMatcher('productos') },
        { id: 'calendario_despacho', label: 'Calendario de Despacho', icon: CalendarDays, target: actionTarget('catalogos', 'calendario_despacho'), active: actionMatcher('calendario_despacho') },
      ],
    },
    {
      id: 'preparacion_pedidos',
      label: 'Preparación de Pedidos',
      items: [
        { id: 'preparacion_pedidos', label: 'Preparación de Pedidos', icon: ClipboardList, target: actionTarget('preparacion_pedidos', 'preparacion_pedidos'), active: actionMatcher('preparacion_pedidos') },
      ],
    },
    {
      id: 'movimientos',
      label: 'Movimientos',
      items: [
        { id: 'recepciones', label: 'Recepciones', icon: PackageOpen, target: actionTarget('movimientos', 'recepciones'), active: ({ pathname, searchParams }: NavigationLocation) => pathname.startsWith('/dashboard/logistica/recepciones/') && !searchParams.has('action') || searchParams.get('action') === 'recepciones' },
        { id: 'traspasos', label: 'Traspasos', icon: ArrowLeftRight, target: actionTarget('movimientos', 'traspasos'), active: actionMatcher('traspasos') },
        { id: 'ajustes', label: 'Ajustes', icon: SlidersHorizontal, target: actionTarget('movimientos', 'ajustes'), active: actionMatcher('ajustes') },
        { id: 'guias_ruta', label: 'Guías de Ruta', icon: Map, target: actionTarget('movimientos', 'guias_ruta'), active: ({ pathname, searchParams }: NavigationLocation) => pathname === '/dashboard/logistica/guias-ruta' && !searchParams.has('action') || searchParams.get('action') === 'guias_ruta' },
      ],
    },
    {
      id: 'consultas',
      label: 'Consultas',
      items: [
        { id: 'stock', label: 'Stock', icon: Layers3, target: actionTarget('consultas', 'stock'), active: actionMatcher('stock') },
        { id: 'kardex', label: 'Kardex', icon: History, target: actionTarget('consultas', 'kardex'), active: actionMatcher('kardex') },
        { id: 'trazabilidad', label: 'Trazabilidad', icon: GitMerge, target: actionTarget('consultas', 'trazabilidad'), active: actionMatcher('trazabilidad') },
      ],
    },
    {
      id: 'reportes',
      label: 'Reportes',
      items: [
        { id: 'reportes_log', label: 'Reportes de Almacén', icon: ChartNoAxesCombined, target: actionTarget('reportes', 'reportes_log'), active: actionMatcher('reportes_log') },
      ],
    },
  ],
}
