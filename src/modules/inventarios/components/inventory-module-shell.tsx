'use client'

import Link from 'next/link'
import { ModuleShell } from '@/components/layout/module-shell'
import type { Company } from '@/app/actions/companies'
import type { Profile } from '@/lib/types'
import { LayoutDashboard } from 'lucide-react'
import { InventoryNavigationFeedback } from '@/modules/inventarios/components/inventory-navigation-feedback'
import { getInventoryBreadcrumb, inventoryNavigation } from '@/modules/inventarios/lib/navigation'

interface InventoryModuleShellProps {
  children: React.ReactNode
  activeCompany: Company | null
  profile: Profile & { roles: { name: string } }
  permissions: string[]
}

export function InventoryModuleShell({ children, activeCompany, profile, permissions }: InventoryModuleShellProps) {
  if (!activeCompany) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-theme-bg p-4">
        <div className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-sm space-y-3">
          <h1 className="text-lg font-bold text-theme-text">Selección de empresa requerida</h1>
          <p className="text-sm text-theme-text-muted">
            No tienes una empresa activa seleccionada. Selecciona una para continuar.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-4 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            Volver al portal
          </Link>
        </div>
      </div>
    )
  }

  return (
    <ModuleShell
      activeCompany={activeCompany}
      legacySidebarStorageKey="mym.inventory.sidebarCollapsed"
      identity={{ id: 'inventarios', label: 'Inventarios', subtitle: 'Control de Inventario', icon: LayoutDashboard }}
      navigation={inventoryNavigation}
      profile={profile}
      permissions={permissions}
      pageTitle="Inventarios"
      breadcrumb={getInventoryBreadcrumb}
      topbarVariant="module"
      showPortalLink
    >
      <InventoryNavigationFeedback />
      <div className="mx-auto max-w-7xl p-4 lg:p-6">
        {children}
      </div>
    </ModuleShell>
  )
}
