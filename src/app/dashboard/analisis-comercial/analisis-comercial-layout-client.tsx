'use client'

import { ModuleShell } from '@/components/layout/module-shell'
import { analisisComercialIdentity, analisisComercialNavigation, getAnalisisComercialBreadcrumb } from '@/modules/analisis-comercial/lib/navigation'

interface AnalisisComercialLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}

export function AnalisisComercialLayoutClient({ children, profile, permissions }: AnalisisComercialLayoutClientProps) {
  return (
    <ModuleShell
      identity={analisisComercialIdentity}
      navigation={analisisComercialNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="Análisis Comercial"
      breadcrumb={getAnalisisComercialBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
    >
      {children}
    </ModuleShell>
  )
}
