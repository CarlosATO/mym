'use client'

import { UsersRound } from 'lucide-react'
import { ModuleShell } from '@/components/layout/module-shell'
import { getRrhhBreadcrumb, rrhhNavigation } from '@/modules/rrhh/lib/navigation'

export function RrhhLayoutClient({
  children,
  profile,
  permissions,
}: {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}) {
  return (
    <ModuleShell
      identity={{ id: 'rrhh', label: 'RRHH', subtitle: 'Personas y documentación', icon: UsersRound }}
      navigation={rrhhNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="RRHH"
      breadcrumb={getRrhhBreadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
    >
      {children}
    </ModuleShell>
  )
}
