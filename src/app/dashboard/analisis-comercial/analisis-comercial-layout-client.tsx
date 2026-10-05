'use client'

import { ModuleShell } from '@/components/layout/module-shell'
import type { Company } from '@/app/actions/companies'
import {
  analisisComercialIdentity,
  analisisComercialNavigation,
  getAnalisisComercialBreadcrumb,
} from '@/modules/analisis-comercial/lib/navigation'

interface AnalisisComercialLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
  activeCompany: Company | null
}

export function AnalisisComercialLayoutClient({ children, profile, permissions, activeCompany }: AnalisisComercialLayoutClientProps) {
  return (
    <ModuleShell
      identity={analisisComercialIdentity}
      navigation={analisisComercialNavigation}
      profile={profile}
      permissions={permissions}
      activeCompany={activeCompany}
      pageTitle="Análisis Comercial"
      breadcrumb={getAnalisisComercialBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
      sidebarVariant="financial"
      themeVariant="financial"
    >
      {children}
    </ModuleShell>
  )
}
