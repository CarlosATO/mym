'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { WmsShell } from './wms-shell'
import { RecepcionesPanel } from '@/modules/logistica/recepciones/recepciones-panel'
import { LocationsPanel } from '@/modules/logistica/ubicaciones/locations-panel'
import { KardexPanel } from '@/modules/logistica/kardex/kardex-panel'
import { StockPanel } from '@/modules/logistica/stock/stock-panel'
import { WarehousesPanel } from '@/modules/logistica/bodegas/warehouses-panel'
import { ProductsPanel } from '@/modules/logistica/productos/products-panel'
import { TransfersPanel } from '@/modules/logistica/traspasos/transfers-panel'
import { AdjustmentsPanel } from '@/modules/logistica/ajustes/adjustments-panel'
import { SalesOrderPreparationPanel } from '@/modules/logistica/preparacion-pedidos/sales-order-preparation-panel'
import { RouteGuidesPanel } from '@/modules/logistica/guias-ruta/route-guides-panel'
import { DispatchCalendarSettings } from '@/modules/logistica/parametros/dispatch-calendar-settings'

// pageHeaders are only used in 'contained' mode views (e.g. Inicio).
// Workspace/operational panels do NOT render these headers — they manage their own title area.
const pageHeaders: Record<string, { title: string; breadcrumb: string[]; description: string }> = {
  resumen: {
    title: 'WMS · Warehouse Management System',
    breadcrumb: ['WMS', 'Inicio'],
    description: 'Gestión de bodegas, rutas, despachos, movimientos e inventario.',
  },
  ubicaciones: {
    title: 'Ubicaciones',
    breadcrumb: ['WMS', 'Parámetros', 'Ubicaciones'],
    description: 'Administración de posiciones físicas por bodega, pasillo, rack, nivel y posición.',
  },
  bodegas: {
    title: 'Bodegas',
    breadcrumb: ['WMS', 'Parámetros', 'Bodegas'],
    description: 'Administración de bodegas operativas.',
  },
  productos: {
    title: 'Productos',
    breadcrumb: ['WMS', 'Parámetros', 'Productos'],
    description: 'Catálogo logístico de productos y atributos operacionales.',
  },
  calendario_despacho: {
    title: 'Calendario de Despacho',
    breadcrumb: ['WMS', 'Parámetros', 'Calendario de Despacho'],
    description: 'Configuración de calendarios de despacho.',
  },
  preparacion_pedidos: {
    title: 'Preparación de Pedidos',
    breadcrumb: ['WMS', 'Preparación de Pedidos'],
    description: 'Preparación operativa de pedidos para despacho.',
  },
  recepciones: {
    title: 'Recepciones',
    breadcrumb: ['WMS', 'Movimientos', 'Recepciones'],
    description: 'Registro y consulta de recepciones contra órdenes de compra.',
  },
  traspasos: {
    title: 'Traspasos internos',
    breadcrumb: ['WMS', 'Movimientos', 'Traspasos'],
    description: 'Movimiento de stock entre bodegas y ubicaciones con trazabilidad por lote.',
  },
  ajustes: {
    title: 'Ajustes',
    breadcrumb: ['WMS', 'Movimientos', 'Ajustes'],
    description: 'Ajustes operativos de inventario.',
  },
  guias_ruta: {
    title: 'Guías de Ruta',
    breadcrumb: ['WMS', 'Movimientos', 'Guías de Ruta'],
    description: 'Gestión y control de despachos en ruta.',
  },
  stock: {
    title: 'Stock por ubicación',
    breadcrumb: ['WMS', 'Consultas', 'Stock'],
    description: 'Existencias agrupadas por producto, bodega, ubicación, lote y vencimiento.',
  },
  kardex: {
    title: 'Kardex de movimientos',
    breadcrumb: ['WMS', 'Consultas', 'Kardex'],
    description: 'Consulta cronológica de entradas, salidas, ajustes y traspasos de inventario.',
  },
  trazabilidad: {
    title: 'Trazabilidad',
    breadcrumb: ['WMS', 'Consultas', 'Trazabilidad'],
    description: 'Seguimiento histórico de movimientos y lotes.',
  },
  reportes_log: {
    title: 'Reportes de Almacén',
    breadcrumb: ['WMS', 'Reportes'],
    description: 'Reportería operacional del módulo de logística.',
  },
}

interface LogisticaLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  permissions: string[]
}

export function LogisticaLayoutClient({ children, profile, permissions }: LogisticaLayoutClientProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isReceiptRoute = pathname.startsWith('/dashboard/logistica/recepciones/')
  const isRouteGuidesRoute = pathname === '/dashboard/logistica/guias-ruta'

  const activeTab = searchParams.get('tab') ?? 'inicio'
  const activeActionId = searchParams.get('action') ?? 'resumen'

  let content = null

  if (activeTab === 'inicio') {
    content = (
      <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px]">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-theme-text">WMS · Warehouse Management System</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">
            Gestión de bodegas, rutas, despachos, movimientos e inventario.
          </p>
        </div>
        {children}
      </div>
    )
  } else if (activeTab === 'catalogos') {
    if (activeActionId === 'ubicaciones') {
      content = <LocationsPanel permissions={permissions} />
    } else if (activeActionId === 'bodegas') {
      content = <WarehousesPanel permissions={permissions} />
    } else if (activeActionId === 'productos') {
      content = <ProductsPanel />
    } else if (activeActionId === 'calendario_despacho') {
      content = <DispatchCalendarSettings isSuperUser={profile.roles?.name === 'SUPER_USUARIO'} />
    } else {
      content = (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px] flex flex-col justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text">Parámetros Operativos</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">Gestión y configuración base del módulo WMS.</p>
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
    } else if (activeActionId === 'traspasos') {
      content = <TransfersPanel />
    } else if (activeActionId === 'ajustes') {
      content = <AdjustmentsPanel />
    } else if (activeActionId === 'guias_ruta') {
      content = <RouteGuidesPanel />
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
  } else if (activeTab === 'preparacion_pedidos') {
    content = <SalesOrderPreparationPanel />
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
          <h2 className="text-lg font-semibold text-theme-text">Módulo WMS</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">Sección en desarrollo.</p>
        </div>
        <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
          <span>⏳</span> Próximamente
        </div>
      </div>
    )
  }

  if (isReceiptRoute || isRouteGuidesRoute) {
    return (
      <WmsShell
        pageTitle={isReceiptRoute ? 'Recepción' : 'Guías de Ruta'}
        breadcrumb={isReceiptRoute ? ['WMS', 'Movimientos', 'Recepciones'] : ['WMS', 'Movimientos', 'Guías de Ruta']}
        profile={profile}
        permissions={permissions}
      >
        {children}
      </WmsShell>
    )
  }

  const currentPage = pageHeaders[activeActionId] ?? pageHeaders.resumen

  return (
    <WmsShell pageTitle={currentPage.title} breadcrumb={currentPage.breadcrumb} profile={profile} permissions={permissions} compactSurface={activeActionId === 'calendario_despacho'}>
      {content}
    </WmsShell>
  )
}
