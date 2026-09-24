import { BarChart3, Package, Truck, WalletCards } from 'lucide-react'
import type { BreadcrumbValue, ModuleNavigation } from '@/components/layout/module-shell-types'

const analysisBase = '/dashboard/analisis-comercial'

export const analisisComercialNavigation: ModuleNavigation = {
  groups: [
    {
      id: 'analisis-360',
      label: 'Análisis Comercial',
      items: [
        {
          id: 'vista-general',
          label: '01  Vista general',
          icon: BarChart3,
          target: { href: analysisBase },
          active: { pathname: { exact: analysisBase } },
        },
        {
          id: 'proveedor-360',
          label: '02  Proveedor 360',
          icon: Truck,
          target: { href: `${analysisBase}/proveedor` },
          active: { pathname: { prefix: `${analysisBase}/proveedor` } },
        },
        {
          id: 'producto-360',
          label: '03  Producto 360',
          icon: Package,
          target: { href: `${analysisBase}/producto` },
          active: { pathname: { prefix: `${analysisBase}/producto` } },
        },
      ],
    },
    {
      id: 'control-financiero-views',
      label: 'Control Financiero',
      items: [
        {
          id: 'control-financiero-summary',
          label: '04  Resumen financiero',
          icon: WalletCards,
          target: { href: `${analysisBase}/control-financiero` },
          active: { pathname: { exact: `${analysisBase}/control-financiero` } },
          visibility: { anyOf: ['analisis_comercial.control_financiero.view', 'system.admin'] },
        },
        {
          id: 'control-financiero-results',
          label: '05  Estado de Resultados',
          target: { href: `${analysisBase}/control-financiero/estado-resultados` },
          active: { pathname: { prefix: `${analysisBase}/control-financiero/estado-resultados` } },
          visibility: { anyOf: ['analisis_comercial.control_financiero.view', 'system.admin'] },
        },
        {
          id: 'control-financiero-cash-flow',
          label: '06  Flujo de Caja',
          target: { href: `${analysisBase}/control-financiero/flujo-caja` },
          active: { pathname: { prefix: `${analysisBase}/control-financiero/flujo-caja` } },
          visibility: { anyOf: ['analisis_comercial.control_financiero.view', 'system.admin'] },
        },
        {
          id: 'control-financiero-working-capital',
          label: '07  Capital de Trabajo',
          target: { href: `${analysisBase}/control-financiero/capital-trabajo` },
          active: { pathname: { prefix: `${analysisBase}/control-financiero/capital-trabajo` } },
          visibility: { anyOf: ['analisis_comercial.control_financiero.view', 'system.admin'] },
        },
      ],
    },
  ],
}

export const getAnalisisComercialBreadcrumb: BreadcrumbValue = ({ pathname }) => {
  if (pathname.startsWith(`${analysisBase}/control-financiero/estado-resultados`)) return ['Análisis Comercial', 'Control Financiero', 'Estado de Resultados']
  if (pathname.startsWith(`${analysisBase}/control-financiero/flujo-caja`)) return ['Análisis Comercial', 'Control Financiero', 'Flujo de Caja']
  if (pathname.startsWith(`${analysisBase}/control-financiero/capital-trabajo`)) return ['Análisis Comercial', 'Control Financiero', 'Capital de Trabajo']
  if (pathname.startsWith(`${analysisBase}/control-financiero`)) return ['Análisis Comercial', 'Control Financiero']
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
