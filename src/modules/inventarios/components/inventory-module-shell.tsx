'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ModuleShell } from '@/components/layout/module-shell'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import type { Profile } from '@/lib/types'
import { AlertTriangle, LayoutDashboard, Loader2 } from 'lucide-react'
import { InventoryNavigationFeedback } from '@/modules/inventarios/components/inventory-navigation-feedback'
import { getInventoryBreadcrumb, inventoryNavigation } from '@/modules/inventarios/lib/navigation'

interface InventoryModuleShellProps {
  children: React.ReactNode
  profile: Profile & { roles: { name: string } }
  permissions: string[]
}

export function InventoryModuleShell({ children, profile, permissions }: InventoryModuleShellProps) {
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)
  const [initError, setInitError] = useState<string | null>(null)

  const loadCompany = useCallback(() => {
    getActiveCompany()
      .then(company => {
        setActiveCompany(company)
        setLoading(false)
      })
      .catch(err => {
        // La inicialización falló de verdad (red/sesión). Nunca dejar el módulo
        // en loading infinito: pasar a un estado de error recuperable.
        console.error('Inventarios init error:', err)
        setLoading(false)
        setInitError('No fue posible iniciar Inventarios')
      })
  }, [])

  useEffect(() => {
    loadCompany()
  }, [loadCompany])

  const retry = useCallback(() => {
    setInitError(null)
    setLoading(true)
    loadCompany()
  }, [loadCompany])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-theme-bg">
        <div className="text-center space-y-3">
          <Loader2 className="h-8 w-8 animate-spin text-theme-accent mx-auto" />
          <p className="text-sm text-theme-text-muted">Iniciando Inventarios…</p>
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-theme-bg p-4">
        <div className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-sm space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-bold text-theme-text">{initError}</h1>
          <p className="text-sm text-theme-text-muted">
            No se pudo recuperar la empresa activa. Verifica tu conexión y vuelve a intentarlo.
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <button
              type="button"
              onClick={retry}
              className="inline-flex h-9 items-center rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover"
            >
              Reintentar
            </button>
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-4 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              Volver al portal
            </Link>
          </div>
        </div>
      </div>
    )
  }

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
