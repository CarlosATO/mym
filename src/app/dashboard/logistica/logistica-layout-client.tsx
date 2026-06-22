'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { ModuleLayout } from '@/components/modules/module-layout'
import { RecepcionesPanel } from '@/modules/logistica/recepciones/recepciones-panel'
import { LocationsPanel } from '@/modules/logistica/ubicaciones/locations-panel'
import { KardexPanel } from '@/modules/logistica/kardex/kardex-panel'
import { StockPanel } from '@/modules/logistica/stock/stock-panel'
import type { RibbonAction } from '@/components/layout/module-ribbon'

const tabs = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'catalogos', label: 'Catálogos' },
  { id: 'movimientos', label: 'Movimientos' },
  { id: 'consultas', label: 'Consultas' },
  { id: 'reportes', label: 'Reportes' },
]

interface LogisticaLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function LogisticaLayoutClient({ children, profile }: LogisticaLayoutClientProps) {
  const pathname = usePathname()
  const isReceiptRoute = pathname.startsWith('/dashboard/logistica/recepciones/')

  const [activeTab, setActiveTab] = useState('inicio')
  const [activeActionId, setActiveActionId] = useState('resumen')

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (tabId === 'inicio') setActiveActionId('resumen')
    else if (tabId === 'catalogos') setActiveActionId('ubicaciones')
    else if (tabId === 'movimientos') setActiveActionId('recepciones')
    else if (tabId === 'consultas') setActiveActionId('stock')
    else if (tabId === 'reportes') setActiveActionId('reportes_log')
  }

  const ribbonActions: RibbonAction[] = []

  if (activeTab === 'catalogos') {
    ribbonActions.push(
      { id: 'ubicaciones', label: 'Ubicaciones', icon: 'MapPin', onClick: () => setActiveActionId('ubicaciones') },
      { id: 'bodegas', label: 'Bodegas', icon: 'Home', upcoming: true },
      { id: 'productos', label: 'Productos', icon: 'Box', upcoming: true }
    )
  } else if (activeTab === 'movimientos') {
    ribbonActions.push(
      { id: 'recepciones', label: 'Recepciones', icon: 'PackageOpen', onClick: () => setActiveActionId('recepciones') },
      { id: 'traspasos', label: 'Traspasos', icon: 'ArrowLeftRight', upcoming: true },
      { id: 'ajustes', label: 'Ajustes', icon: 'Sliders', upcoming: true },
      { id: 'egresos', label: 'Egresos', icon: 'LogOut', upcoming: true },
      { id: 'devoluciones', label: 'Devoluciones', icon: 'RotateCcw', upcoming: true }
    )
  } else if (activeTab === 'consultas') {
    ribbonActions.push(
      { id: 'stock', label: 'Stock', icon: 'Layers', onClick: () => setActiveActionId('stock') },
      { id: 'kardex', label: 'Kardex', icon: 'History', onClick: () => setActiveActionId('kardex') },
      { id: 'trazabilidad', label: 'Trazabilidad', icon: 'GitMerge', upcoming: true }
    )
  } else if (activeTab === 'reportes') {
    ribbonActions.push(
      { id: 'reportes_log', label: 'Reportes de Almacén', icon: 'BarChart3', upcoming: true }
    )
  }

  let content = null

  if (activeTab === 'inicio') {
    content = (
      <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px]">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-theme-text">Panel de Logística</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">
            Bienvenido al módulo de control de almacén. Gestione recepciones de compras, ubicaciones físicas, movimientos de Kardex y niveles de stock.
          </p>
        </div>
        {children}
      </div>
    )
  } else if (activeTab === 'catalogos') {
    if (activeActionId === 'ubicaciones') {
      content = <LocationsPanel />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Mantenedor de Almacén</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Gestión y mantenedores del módulo de Logística.</p>
          </div>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      )
    }
  } else if (activeTab === 'movimientos') {
    if (activeActionId === 'recepciones') {
      content = <RecepcionesPanel />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Movimientos de Inventario</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Acción de movimiento físico de mercadería.</p>
          </div>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      )
    }
  } else if (activeTab === 'consultas') {
    if (activeActionId === 'stock') {
      content = <StockPanel />
    } else if (activeActionId === 'kardex') {
      content = <KardexPanel />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Consulta de Trazabilidad</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Trazabilidad histórica de stock.</p>
          </div>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      )
    }
  } else {
    content = (
      <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
        <div>
          <h2 className="text-lg font-semibold text-theme-text">Módulo de Logística</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">Sección en desarrollo.</p>
        </div>
        <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
          <span>⏳</span> Próximamente
        </div>
      </div>
    )
  }

  if (isReceiptRoute) {
    return (
      <ModuleLayout
        moduleName="Logística"
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
        ribbonActions={[]}
        profile={profile}
      >
        {children}
      </ModuleLayout>
    )
  }

  // Workspace mode for panels that need full-height, full-width layout.
  // Extend this list when new operational panels are added.
  const workspaceActionIds = ['recepciones', 'stock', 'kardex']
  const layoutMode = workspaceActionIds.includes(activeActionId) ? 'workspace' : 'contained'

  return (
    <ModuleLayout
      moduleName="Logística"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      ribbonActions={ribbonActions}
      activeActionId={activeActionId}
      layoutMode={layoutMode}
      profile={profile}
    >
      {content}
    </ModuleLayout>
  )
}


