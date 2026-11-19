'use client'

import { ModuleShell } from '@/components/layout/module-shell'
import { getWmsNavigation } from './wms-navigation'
import { usePathname, useSearchParams } from 'next/navigation'

interface WmsShellProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  pageTitle: string
  breadcrumb: string[]
  permissions: string[]
  canAccessPreparation: boolean
}

export function WmsShell({ children, profile, permissions, pageTitle, breadcrumb, canAccessPreparation }: WmsShellProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tab = searchParams.get('tab')
  const action = searchParams.get('action')
  const hasPreparationAccess = canAccessPreparation
    || permissions.includes('system.admin')
    || permissions.includes('logistica.preparation.manage')
  const isDefaultPreparationLanding = pathname === '/dashboard/logistica' && !tab && !action && hasPreparationAccess
  const isPreparationView = pathname === '/dashboard/logistica' && (
    (tab === 'preparacion_pedidos' && action === 'preparacion_pedidos')
    || isDefaultPreparationLanding
  )
  const isMermasContext = pathname.startsWith('/dashboard/logistica/mermas')
  const navigationPermissions = canAccessPreparation
    ? [...permissions, 'logistica.preparation.access']
    : permissions

  return (
    <ModuleShell
      identity={isMermasContext ? { id: 'mermas', label: 'MERMAS' } : { id: 'logistica', label: 'WMS', subtitle: 'Gestión de Bodega' }}
      navigation={getWmsNavigation(pathname)}
      profile={profile}
      permissions={navigationPermissions}
      pageTitle={pageTitle}
      breadcrumb={breadcrumb}
      surfaceMode="none"
      showPortalLink
      topbarVariant="module"
      sidebarVariant="financial"
      themeVariant="financial"
      breadcrumbAccessoryId={isPreparationView ? 'preparation-breadcrumb-kpis' : undefined}
    >
      {children}
    </ModuleShell>
  )
}
