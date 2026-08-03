'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppTopbar } from '@/components/layout/app-topbar'
import { InventorySidebar } from '@/modules/inventarios/components/inventory-sidebar'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import type { Profile } from '@/lib/types'
import { LayoutDashboard, Loader2 } from 'lucide-react'

interface InventoryModuleShellProps {
  children: React.ReactNode
  profile: Profile & { roles: { name: string } }
  permissions: string[]
}

export function InventoryModuleShell({ children, profile, permissions }: InventoryModuleShellProps) {
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    getActiveCompany().then(company => {
      setActiveCompany(company)
      setLoading(false)
    })
  }, [])

  const closeMobile = useCallback(() => setMobileOpen(false), [])
  const openMobile = useCallback(() => setMobileOpen(true), [])

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

  if (!activeCompany) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-theme-bg p-4">
        <div className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-sm space-y-3">
          <h1 className="text-lg font-bold text-theme-text">Selección de empresa requerida</h1>
          <p className="text-sm text-theme-text-muted">
            No tienes una empresa activa seleccionada. Selecciona una para continuar.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-theme-bg text-theme-text">
      <AppTopbar
        profile={profile}
        activeCompany={activeCompany}
        permissions={permissions}
        moduleName="Inventarios"
      />

      <div className="flex flex-1 pt-12">
        <InventorySidebar mobileOpen={mobileOpen} onMobileOpen={openMobile} onMobileClose={closeMobile} />

        <main className="min-w-0 flex-1">
          {/* Volver al portal: extremo superior derecho del área del módulo */}
          <div className="flex justify-end px-4 pt-3 lg:px-6">
            <Link
              href="/dashboard"
              aria-label="Volver al portal"
              title="Volver al portal"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted shadow-sm transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Volver al portal</span>
            </Link>
          </div>

          <div className="mx-auto max-w-7xl p-4 lg:p-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
