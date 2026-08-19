import { BarChart3, LayoutDashboard, Package, Truck } from 'lucide-react'
import type { BreadcrumbValue, ModuleNavigation } from '@/components/layout/module-shell-types'

const analysisBase = '/dashboard/analisis-comercial'

export const analisisComercialNavigation: ModuleNavigation = {
  home: {
    id: 'vista-general',
    label: 'Vista general',
    icon: LayoutDashboard,
    target: { href: analysisBase },
    active: { pathname: { exact: analysisBase } },
  },
  groups: [
    {
      id: 'analisis-360',
      label: 'Análisis 360',
      items: [
        {
          id: 'proveedor-360',
          label: 'Proveedor 360',
          icon: Truck,
          target: { href: `${analysisBase}/proveedor` },
          active: { pathname: { prefix: `${analysisBase}/proveedor` } },
        },
        {
          id: 'producto-360',
          label: 'Producto 360',
          icon: Package,
          target: { href: `${analysisBase}/producto` },
          active: { pathname: { prefix: `${analysisBase}/producto` } },
        },
      ],
    },
  ],
}

export const getAnalisisComercialBreadcrumb: BreadcrumbValue = ({ pathname }) => {
  if (pathname.startsWith(`${analysisBase}/proveedor`)) return ['Análisis Comercial', 'Proveedor 360']
  if (pathname.startsWith(`${analysisBase}/producto`)) return ['Análisis Comercial', 'Producto 360']
  return ['Análisis Comercial']
}

export const analisisComercialIdentity = {
  id: 'analisis-comercial',
  label: 'Análisis Comercial',
  subtitle: 'Inteligencia Comercial',
  icon: BarChart3,
}
