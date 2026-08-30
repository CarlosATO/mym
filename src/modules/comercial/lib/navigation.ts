import { BarChart3, CheckCircle2, CircleDollarSign, FileText, Home, ListChecks, Users } from 'lucide-react'
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
          id: 'comisiones-v2-emision',
          label: 'Emisión E.P.',
          icon: BarChart3,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'LINES' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'LINES'),
          visibility: { anyOf: ['comisiones.v2.read', 'system.admin'] },
        },
        {
          id: 'comisiones-v2-borradores',
          label: 'Borradores',
          icon: FileText,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'DRAFTS' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'DRAFTS'),
          visibility: { anyOf: ['comisiones.v2.read', 'system.admin'] },
        },
        {
          id: 'comisiones-v2-emitidas',
          label: 'Emitidas',
          icon: CheckCircle2,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'ISSUED' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'ISSUED'),
          visibility: { anyOf: ['comisiones.v2.read', 'system.admin'] },
        },
      ],
    },
    {
      id: 'comisiones-configuracion-v2',
      label: 'Configuración',
      items: [
        {
          id: 'comisiones-v2-reglas',
          label: 'Reglas',
          icon: ListChecks,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'PLANS' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'PLANS'),
          visibility: { anyOf: ['comisiones.v2.plans.manage', 'system.admin'] },
        },
        {
          id: 'comisiones-v2-vendedores',
          label: 'Vendedores',
          icon: Users,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'SELLERS' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'SELLERS'),
          visibility: { anyOf: ['comisiones.v2.read', 'system.admin'] },
        },
        {
          id: 'comisiones-v2-clientes-no-comisionables',
          label: 'Clientes no comisionables',
          icon: Users,
          target: { pathname: `${comercialBase}/comisiones-v2`, query: { section: 'CUSTOMERS' } },
          active: ({ pathname, searchParams }) => isV2SectionActive(pathname, searchParams.get('section'), 'CUSTOMERS'),
          visibility: { anyOf: ['comisiones.v2.plans.manage', 'system.admin'] },
        },
      ],
    },
  ],
}

function isV2SectionActive(pathname: string, section: string | null, expected: string) {
  return pathname === `${comercialBase}/comisiones-v2` && (section ?? 'LINES') === expected
}

export const getComercialBreadcrumb: BreadcrumbValue = ({ pathname }) => {
  if (pathname.startsWith(`${comercialBase}/clientes`)) return ['Clientes y Ventas', 'Clientes']
  if (pathname.startsWith(`${comercialBase}/cobranza`)) return ['Clientes y Ventas', 'Cobranza']
  if (pathname.startsWith(`${comercialBase}/comisiones-v2`)) return ['Clientes y Ventas', 'Comisiones']
  if (pathname.startsWith(`${comercialBase}/comisiones`)) return ['Clientes y Ventas', 'Comisiones']
  return ['Clientes y Ventas']
}
