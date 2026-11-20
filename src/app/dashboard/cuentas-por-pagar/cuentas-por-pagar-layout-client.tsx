'use client'

import { FileText } from 'lucide-react'
import { ModuleShell } from '@/components/layout/module-shell'
import {
  cuentasPorPagarNavigation,
  getCuentasPorPagarBreadcrumb,
} from '@/modules/cuentas-por-pagar/navigation'

interface CuentasPorPagarLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}

export function CuentasPorPagarLayoutClient({
  children,
  profile,
  permissions,
}: CuentasPorPagarLayoutClientProps) {
  return (
    <ModuleShell
      identity={{
        id: 'cuentas-por-pagar',
        label: 'Cuentas por Pagar',
        subtitle: 'Facturas de proveedores',
        icon: FileText,
      }}
      navigation={cuentasPorPagarNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="Cuentas por Pagar"
      breadcrumb={getCuentasPorPagarBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
      sidebarVariant="default"
      themeVariant="default"
    >
      {children}
    </ModuleShell>
  )
}
