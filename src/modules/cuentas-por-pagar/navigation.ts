import { FilePlus2, FileText } from 'lucide-react'
import type { ModuleNavigation, NavigationLocation } from '@/components/layout/module-shell-types'

const basePath = '/dashboard/cuentas-por-pagar'
const servicesPath = `${basePath}/ingreso-servicios`

export const cuentasPorPagarNavigation: ModuleNavigation = {
  groups: [
    {
      id: 'operacion',
      label: 'Operación',
      items: [
        {
          id: 'facturas',
          label: 'Bandeja de facturas',
          icon: FileText,
          target: { href: basePath },
          active: ({ pathname }: NavigationLocation) => pathname === basePath,
        },
        {
          id: 'ingreso-servicios',
          label: 'Ingreso de Servicios',
          icon: FilePlus2,
          target: { href: servicesPath },
          active: ({ pathname }: NavigationLocation) =>
            pathname === servicesPath || pathname.startsWith(`${servicesPath}/`),
        },
      ],
    },
  ],
}

export function getCuentasPorPagarBreadcrumb({ pathname }: NavigationLocation) {
  if (pathname.startsWith(servicesPath)) {
    return ['Cuentas por Pagar', 'Ingreso de Servicios']
  }
  return ['Cuentas por Pagar', 'Bandeja de facturas']
}
