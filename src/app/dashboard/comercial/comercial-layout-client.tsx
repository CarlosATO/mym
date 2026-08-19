'use client'

import { BriefcaseBusiness } from 'lucide-react'
import { ModuleShell } from '@/components/layout/module-shell'
import { comercialNavigation, getComercialBreadcrumb } from '@/modules/comercial/lib/navigation'

interface ComercialLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}

export function ComercialLayoutClient({ profile, permissions, children }: ComercialLayoutClientProps) {
  return (
    <ModuleShell
      identity={{ id: 'comercial', label: 'Clientes y Ventas', subtitle: 'Gestión Comercial', icon: BriefcaseBusiness }}
      navigation={comercialNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="Clientes y Ventas"
      breadcrumb={getComercialBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
    >
      {children}
    </ModuleShell>
  )
}
