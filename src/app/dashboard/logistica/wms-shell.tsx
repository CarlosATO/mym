'use client'

import { ModuleShell } from '@/components/layout/module-shell'
import { getWmsNavigation } from './wms-navigation'
import { usePathname } from 'next/navigation'

interface WmsShellProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  pageTitle: string
  breadcrumb: string[]
  permissions: string[]
}

export function WmsShell({ children, profile, permissions, pageTitle, breadcrumb }: WmsShellProps) {
  const pathname = usePathname()
  const isMermasContext = pathname.startsWith('/dashboard/logistica/mermas')

  return (
    <ModuleShell
      identity={isMermasContext ? { id: 'mermas', label: 'MERMAS' } : { id: 'logistica', label: 'WMS', subtitle: 'Gestión de Bodega' }}
      navigation={getWmsNavigation(pathname)}
      profile={profile}
      permissions={permissions}
      pageTitle={pageTitle}
      breadcrumb={breadcrumb}
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
