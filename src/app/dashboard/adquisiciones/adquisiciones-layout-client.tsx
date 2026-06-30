'use client'

import { useState } from 'react'
import { ModuleLayout } from '@/components/modules/module-layout'
import { SuppliersPanel } from '@/modules/adquisiciones/proveedores/suppliers-panel'
import { CatalogPanel } from '@/modules/adquisiciones/catalogo/catalog-panel'
import { WarehousesPanel } from '@/modules/adquisiciones/bodegas/warehouses-panel'
import { PurchaseOrdersPanel } from '@/modules/adquisiciones/ordenes-compra/purchase-orders-panel'
import { RouteSettlementsPanel } from '@/modules/adquisiciones/rendicion-rutas/route-settlements-panel'
import type { RibbonAction } from '@/components/layout/module-ribbon'

const tabs = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'catalogos', label: 'Catálogos' },
  { id: 'transacciones', label: 'Transacciones' },
  { id: 'recepcion', label: 'Recepción' },
  { id: 'reportes', label: 'Reportes' },
]

const pageHeaders: Record<string, { title: string; breadcrumb: string[]; description: string }> = {
  resumen: {
    title: 'Panel de Adquisiciones',
    breadcrumb: ['Adquisiciones', 'Inicio'],
    description: 'Resumen general del módulo de compras y abastecimiento.',
  },
  proveedores: {
    title: 'Proveedores',
    breadcrumb: ['Adquisiciones', 'Catálogos', 'Proveedores'],
    description: 'Administración de proveedores y condiciones comerciales.',
  },
  catalogo: {
    title: 'Catálogo de Productos',
    breadcrumb: ['Adquisiciones', 'Catálogos', 'Catálogo de Productos'],
    description: 'Mantenimiento del catálogo base para compras.',
  },
  bodegas: {
    title: 'Bodegas',
    breadcrumb: ['Adquisiciones', 'Catálogos', 'Bodegas'],
    description: 'Consulta de bodegas disponibles para órdenes de compra.',
  },
  autorizadores: {
    title: 'Autorizadores de Compra',
    breadcrumb: ['Adquisiciones', 'Catálogos', 'Autorizadores'],
    description: 'Gestión y control de autorizaciones de montos y presupuestos.',
  },
  ordenes: {
    title: 'Órdenes de Compra',
    breadcrumb: ['Adquisiciones', 'Compras', 'Órdenes de Compra'],
    description: 'Emisión, seguimiento y control de órdenes de compra.',
  },
  nueva_orden: {
    title: 'Nueva Orden',
    breadcrumb: ['Adquisiciones', 'Compras', 'Nueva Orden'],
    description: 'Creación de nuevas solicitudes de compra.',
  },
  historial: {
    title: 'Historial de Compras',
    breadcrumb: ['Adquisiciones', 'Transacciones', 'Historial'],
    description: 'Consulta histórica de compras realizadas.',
  },
  rendicion_rutas: {
    title: 'Rendición de Rutas',
    breadcrumb: ['Adquisiciones', 'Transacciones', 'Rendición de Rutas'],
    description: 'Control administrativo de efectivo, transferencias, cheques, créditos y pendientes asociados a guías despachadas.',
  },
  recepciones_p: {
    title: 'Recepciones',
    breadcrumb: ['Adquisiciones', 'Recepción', 'Recepciones'],
    description: 'Seguimiento de recepciones asociadas a compras.',
  },
  reporte_gral: {
    title: 'Reporte General',
    breadcrumb: ['Adquisiciones', 'Reportes'],
    description: 'Indicadores y reportes generales de compras.',
  },
}

interface AdquisicionesLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function AdquisicionesLayoutClient({ children, profile }: AdquisicionesLayoutClientProps) {
  const [activeTab, setActiveTab] = useState('inicio')
  const [activeActionId, setActiveActionId] = useState('resumen')

  // Cuando cambia la pestaña principal, re-establecer la acción seleccionada por defecto
  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (tabId === 'inicio') setActiveActionId('resumen')
    else if (tabId === 'catalogos') setActiveActionId('proveedores')
    else if (tabId === 'transacciones') setActiveActionId('ordenes')
    else if (tabId === 'recepcion') setActiveActionId('recepciones_p')
    else if (tabId === 'reportes') setActiveActionId('reporte_gral')
  }

  // Generación de acciones de Ribbon
  const ribbonActions: RibbonAction[] = []

  if (activeTab === 'catalogos') {
    ribbonActions.push(
      { id: 'proveedores', label: 'Proveedores', icon: 'Users', onClick: () => setActiveActionId('proveedores') },
      { id: 'catalogo', label: 'Catálogo', icon: 'FileText', onClick: () => setActiveActionId('catalogo') },
      { id: 'bodegas', label: 'Bodegas', icon: 'Home', onClick: () => setActiveActionId('bodegas') },
      { id: 'autorizadores', label: 'Autorizadores', icon: 'CheckSquare', upcoming: true }
    )
  } else if (activeTab === 'transacciones') {
    ribbonActions.push(
      { id: 'ordenes', label: 'Órdenes de Compra', icon: 'FileCheck', onClick: () => {
        if (process.env.NODE_ENV === 'development') console.log(`[RendicionRutas:UI] ribbon clicked: ordenes`)
        setActiveActionId('ordenes')
      }},
      { id: 'rendicion_rutas', label: 'Rendición de Rutas', icon: 'ClipboardCheck', onClick: () => {
        if (process.env.NODE_ENV === 'development') console.log(`[RendicionRutas:UI] ribbon clicked: rendicion_rutas`)
        setActiveActionId('rendicion_rutas')
      }},
      { id: 'nueva_orden', label: 'Nueva Orden', icon: 'PlusCircle', upcoming: true },
      { id: 'historial', label: 'Historial', icon: 'History', upcoming: true }
    )
  } else if (activeTab === 'recepcion') {
    ribbonActions.push(
      { id: 'recepciones_p', label: 'Recepciones', icon: 'PackageOpen', upcoming: true }
    )
  } else if (activeTab === 'reportes') {
    ribbonActions.push(
      { id: 'reporte_gral', label: 'Reporte General', icon: 'BarChart3', upcoming: true }
    )
  }

  // Panel a renderizar según el estado de la acción del Ribbon seleccionada
  let content = null

  if (activeTab === 'inicio') {
    content = (
      <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px]">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-theme-text font-accent">Panel de Adquisiciones</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">
            Resumen general del módulo de compras y abastecimiento de MYM Distribuidora. Use las pestañas superiores para navegar.
          </p>
        </div>
        {children}
      </div>
    )
  } else if (activeTab === 'catalogos') {
    if (activeActionId === 'proveedores') {
      content = <SuppliersPanel />
    } else if (activeActionId === 'catalogo') {
      content = <CatalogPanel />
    } else if (activeActionId === 'bodegas') {
      content = <WarehousesPanel />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Autorizadores de Compra</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Gestión y control de autorizaciones de montos y presupuestos.</p>
          </div>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      )
    }
  } else if (activeTab === 'transacciones') {
    if (activeActionId === 'ordenes') {
      content = <PurchaseOrdersPanel />
    } else if (activeActionId === 'rendicion_rutas') {
      content = <RouteSettlementsPanel />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Acción de Transacciones</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Esta sección está actualmente planificada en nuestro flujo de trabajo.</p>
          </div>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      )
    }
  } else {
    // Para recepcion y reportes (todos placeholders por ahora)
    content = (
      <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
        <div>
          <h2 className="text-lg font-semibold text-theme-text">Módulo de Adquisiciones</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">Sección en desarrollo.</p>
        </div>
        <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
          <span>⏳</span> Próximamente
        </div>
      </div>
    )
  }

  const workspaceActionIds = ['ordenes', 'proveedores', 'catalogo', 'bodegas', 'recepciones_p', 'rendicion_rutas']
  const layoutMode = workspaceActionIds.includes(activeActionId) ? 'workspace' : 'contained'

  return (
    <ModuleLayout
      moduleName="Adquisiciones"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      ribbonActions={ribbonActions}
      activeActionId={activeActionId}
      layoutMode={layoutMode}
      pageHeader={pageHeaders[activeActionId] ?? pageHeaders.resumen}
      profile={profile}
    >
      {content}
    </ModuleLayout>
  )
}


