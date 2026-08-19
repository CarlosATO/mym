'use client'

import { ModuleShell } from '@/components/layout/module-shell'
import { wmsNavigation } from './wms-navigation'

interface WmsShellProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  pageTitle: string
  breadcrumb: string[]
  compactSurface?: boolean
}

export function WmsShell({ children, profile, pageTitle, breadcrumb, compactSurface = false }: WmsShellProps) {
  const permissions = profile.roles?.name === 'SUPER_USUARIO' ? ['usuarios.view', 'roles.view', 'audit.view', 'security.view'] : []

  return (
    <ModuleShell
      identity={{ id: 'logistica', label: 'WMS', subtitle: 'Gestión de Bodega' }}
      navigation={wmsNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle={pageTitle}
      breadcrumb={breadcrumb}
      surfaceMode={compactSurface ? 'compact' : 'standard'}
      showPortalLink
      topbarVariant="module"
    >
      {children}
    </ModuleShell>
  )
}
