'use client'

import { ShoppingCart } from 'lucide-react'
import { ModuleShell } from '@/components/layout/module-shell'
import { getAdquisicionesBreadcrumb, adquisicionesNavigation } from '@/modules/adquisiciones/lib/navigation'

interface AdquisicionesLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}

export function AdquisicionesLayoutClient({ children, profile, permissions }: AdquisicionesLayoutClientProps) {
  return (
    <ModuleShell
      identity={{ id: 'adquisiciones', label: 'Adquisiciones', subtitle: 'Compras y Abastecimiento', icon: ShoppingCart }}
      navigation={adquisicionesNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="Adquisiciones"
      breadcrumb={getAdquisicionesBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
    >
      {children}
    </ModuleShell>
  )
}
