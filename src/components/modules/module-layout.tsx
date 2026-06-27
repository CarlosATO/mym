'use client'

import { useState, useEffect } from 'react'
import * as LucideIcons from 'lucide-react'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { cn } from '@/lib/utils'
import { AppTopbar } from '@/components/layout/app-topbar'
import { ModuleTabs } from '@/components/layout/module-tabs'
import { ModuleRibbon, type RibbonAction } from '@/components/layout/module-ribbon'
import { ModulePageHeader, type ModulePageHeaderProps } from '@/components/layout/module-page-header'

interface Tab {
  id: string
  label: string
}

interface ModuleLayoutProps {
  moduleName: string
  tabs: Tab[]
  activeTab: string
  onTabChange: (tabId: string) => void
  ribbonActions?: RibbonAction[]
  activeActionId?: string
  /** 'contained' = max-w-7xl centrado (default). 'workspace' = ancho completo, altura útil fija. */
  layoutMode?: 'contained' | 'workspace'
  pageHeader?: ModulePageHeaderProps
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function ModuleLayout({
  moduleName,
  tabs,
  activeTab,
  onTabChange,
  ribbonActions = [],
  activeActionId,
  layoutMode = 'contained',
  pageHeader,
  children,
  profile
}: ModuleLayoutProps) {
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getActiveCompany().then(company => {
      setActiveCompany(company)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen relative dark text-foreground flex items-center justify-center">
        <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
        <div className="text-center space-y-4">
          <LucideIcons.Loader2 className="h-8 w-8 animate-spin text-theme-accent mx-auto" />
          <p className="text-sm text-theme-text-muted">Iniciando módulo...</p>
        </div>
      </div>
    )
  }

  if (!activeCompany) {
    return (
      <div className="min-h-screen relative dark text-foreground flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
        <div className="w-full max-w-md bg-theme-surface/90 border border-white/10 backdrop-blur-md rounded-2xl p-6 shadow-2xl text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-theme-accent/20 flex items-center justify-center text-theme-accent shadow-lg shadow-theme-accent/10">
            <LucideIcons.Building className="h-8 w-8" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-theme-text">Selección de Empresa Requerida</h1>
            <p className="text-sm text-theme-text-muted">No tienes una empresa activa seleccionada en el sistema. Selecciona una para continuar.</p>
          </div>
          <div className="border-t border-theme-border pt-4">
            <p className="text-xs text-theme-text-muted">Seleccione una empresa en el portal operacional.</p>
          </div>
        </div>
      </div>
    )
  }

  // Generamos permisos ficticios vacíos ya que en el módulo no cargamos roles específicos cliente-side,
  // pero el UserMenu leerá el rol de SUPER_USUARIO del profile.
  const permissions: string[] = profile.roles?.name === 'SUPER_USUARIO' ? ['usuarios.view', 'roles.view', 'audit.view', 'security.view'] : []

  return (
    <div className="flex flex-col min-h-screen">
      {/* Fila 1: Topbar Global */}
      <AppTopbar
        profile={profile as any}
        activeCompany={activeCompany}
        permissions={permissions}
        moduleName={moduleName}
      />

      {/* Fila 2: Pestañas */}
      <ModuleTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
      />

      {/* Fila 3: Ribbon */}
      <ModuleRibbon
        actions={ribbonActions}
        activeActionId={activeActionId}
      />

      {/* Main Content */}
      {layoutMode === 'workspace' ? (
        // Workspace mode: full-width, fixed height, no centering, no lateral padding.
        // Topbar=48 + Tabs=36 + Ribbon=40 → 124px fixed headers.
        // With ribbon: main pt=132px + pb=8px = 140px consumed.
        // Without ribbon: main pt=92px + pb=8px = 100px consumed.
        // NOTE: ModulePageHeader is intentionally suppressed in workspace mode.
        // Operational panels (Recepciones, Traspasos, Stock, Kardex, Bodegas,
        // Ubicaciones, Productos) manage their own compact headers internally.
        <main className={cn("flex-1 w-full", ribbonActions.length > 0 ? "pt-[132px]" : "pt-[92px]")}
              data-layout="workspace">
          <div
            className="w-full pb-2 flex flex-col min-h-0"
            style={{ height: ribbonActions.length > 0 ? 'calc(100vh - 140px)' : 'calc(100vh - 100px)' }}
          >
            <div className="flex-1 min-h-0 overflow-hidden">
              {children}
            </div>
          </div>
        </main>
      ) : (
        // Contained mode: centered, max-width, default padding.
        <main className={cn("flex-1 w-full", ribbonActions.length > 0 ? "pt-[132px]" : "pt-[92px]")}>
          <div className="max-w-7xl mx-auto p-4 lg:p-6">
            {pageHeader && <div className="mb-4 overflow-hidden rounded-2xl border border-theme-border/70"><ModulePageHeader {...pageHeader} /></div>}
            {children}
          </div>
        </main>
      )}
    </div>

  )
}
