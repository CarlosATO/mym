import { BarChart3, CheckCircle2, CircleDollarSign, FileText, FolderTree, Home, ListChecks, Settings2, Users, XCircle } from 'lucide-react'
import type { BreadcrumbValue, ModuleNavigation } from '@/components/layout/module-shell-types'

const comercialBase = '/dashboard/comercial'

export const comercialNavigation: ModuleNavigation = {
  home: {
    id: 'inicio',
    label: 'Inicio',
    icon: Home,
    target: { href: comercialBase },
    active: { pathname: { exact: comercialBase } },
  },
  groups: [
    {
      id: 'gestion-comercial',
      label: 'Gestión Comercial',
      items: [
        {
          id: 'clientes',
          label: 'Clientes',
          icon: Users,
          target: { href: `${comercialBase}/clientes` },
          active: { pathname: { prefix: `${comercialBase}/clientes` } },
        },
        {
          id: 'cobranza',
          label: 'Cobranza',
          icon: CircleDollarSign,
          target: { href: `${comercialBase}/cobranza` },
          active: { pathname: { prefix: `${comercialBase}/cobranza` } },
        },
      ],
    },
    {
      id: 'comisiones',
      label: 'Comisiones',
      items: [
        {
          id: 'comisiones-simulacion',
          label: 'Simulación',
          icon: BarChart3,
          target: { pathname: `${comercialBase}/comisiones`, query: { view: 'simulacion' } },
          active: ({ pathname, searchParams }) => pathname.startsWith(`${comercialBase}/comisiones`) && (searchParams.get('view') === null || searchParams.get('view') === 'simulacion'),
        },
        {
          id: 'comisiones-borradores',
          label: 'Borradores',
          icon: FileText,
          target: { pathname: `${comercialBase}/comisiones`, query: { view: 'borradores' } },
          active: { pathname: { prefix: `${comercialBase}/comisiones` }, query: { view: 'borradores' } },
        },
        {
          id: 'comisiones-emitidas',
          label: 'Emitidas',
          icon: CheckCircle2,
          target: { pathname: `${comercialBase}/comisiones`, query: { view: 'emitidas' } },
          active: { pathname: { prefix: `${comercialBase}/comisiones` }, query: { view: 'emitidas' } },
        },
        {
          id: 'comisiones-anuladas',
          label: 'Anuladas',
          icon: XCircle,
          target: { pathname: `${comercialBase}/comisiones`, query: { view: 'anuladas' } },
          active: { pathname: { prefix: `${comercialBase}/comisiones` }, query: { view: 'anuladas' } },
        },
        {
          id: 'comisiones-configuracion',
          label: 'Configuración',
          icon: Settings2,
          target: { pathname: `${comercialBase}/comisiones`, query: { view: 'configuracion' } },
          active: { pathname: { prefix: `${comercialBase}/comisiones` }, query: { view: 'configuracion' } },
          children: [
            {
              id: 'comisiones-config-vendedores',
              label: 'Vendedores',
              icon: Users,
              target: { pathname: `${comercialBase}/comisiones`, query: { view: 'configuracion', config: 'vendedores' } },
              active: ({ pathname, searchParams }) => isConfigTabActive(pathname, searchParams.get('view'), searchParams.get('config'), 'vendedores'),
            },
            {
              id: 'comisiones-config-general',
              label: 'General',
              icon: Settings2,
              target: { pathname: `${comercialBase}/comisiones`, query: { view: 'configuracion', config: 'general' } },
              active: ({ pathname, searchParams }) => isConfigTabActive(pathname, searchParams.get('view'), searchParams.get('config'), 'general'),
            },
            {
              id: 'comisiones-config-grupos',
              label: 'Grupos',
              icon: FolderTree,
              target: { pathname: `${comercialBase}/comisiones`, query: { view: 'configuracion', config: 'grupos' } },
              active: ({ pathname, searchParams }) => isConfigTabActive(pathname, searchParams.get('view'), searchParams.get('config'), 'grupos'),
            },
            {
              id: 'comisiones-config-reglas',
              label: 'Reglas',
              icon: ListChecks,
              target: { pathname: `${comercialBase}/comisiones`, query: { view: 'configuracion', config: 'reglas' } },
              active: ({ pathname, searchParams }) => isConfigTabActive(pathname, searchParams.get('view'), searchParams.get('config'), 'reglas'),
            },
          ],
        },
      ],
    },
  ],
}

function isConfigTabActive(pathname: string, view: string | null, config: string | null, tab: string) {
  return pathname.startsWith(`${comercialBase}/comisiones`) && view === 'configuracion' && (config === tab || (config === null && tab === 'vendedores'))
}

export const getComercialBreadcrumb: BreadcrumbValue = ({ pathname }) => {
  if (pathname.startsWith(`${comercialBase}/clientes`)) return ['Clientes y Ventas', 'Clientes']
  if (pathname.startsWith(`${comercialBase}/cobranza`)) return ['Clientes y Ventas', 'Cobranza']
  if (pathname.startsWith(`${comercialBase}/comisiones`)) return ['Clientes y Ventas', 'Comisiones']
  return ['Clientes y Ventas']
}
