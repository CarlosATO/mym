'use client'

import { useState } from 'react'
import { ModuleLayout } from '@/components/modules/module-layout'
import { SuppliersPanel } from '@/modules/adquisiciones/proveedores/suppliers-panel'
import { CatalogPanel } from '@/modules/adquisiciones/catalogo/catalog-panel'
import { WarehousesPanel } from '@/modules/adquisiciones/bodegas/warehouses-panel'
import { PurchaseOrdersPanel } from '@/modules/adquisiciones/ordenes-compra/purchase-orders-panel'

const tabs = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'catalogo', label: 'Catálogo' },
  { id: 'bodegas', label: 'Bodegas' },
  { id: 'ordenes', label: 'Órdenes de Compra' },
  { id: 'recepciones', label: 'Recepciones' },
  { id: 'reportes', label: 'Reportes' },
]

const placeholders: Record<string, { title: string; desc: string }> = {
  inicio: { title: 'Panel de Adquisiciones', desc: 'Resumen general del módulo de compras y abastecimiento.' },
  catalogo: { title: 'Catálogo de Productos', desc: 'Catálogo central de productos y servicios.' },
  recepciones: { title: 'Recepciones', desc: 'Control de recepciones y entrada de mercadería.' },
  reportes: { title: 'Reportes', desc: 'Informes y análisis del módulo de adquisiciones.' },
}

interface AdquisicionesLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function AdquisicionesLayoutClient({ children, profile }: AdquisicionesLayoutClientProps) {
  const [activeTab, setActiveTab] = useState('inicio')

  return (
    <ModuleLayout
      moduleName="Adquisiciones"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      profile={profile}
    >
      {activeTab === 'proveedores' ? (
        <SuppliersPanel />
      ) : activeTab === 'catalogo' ? (
        <CatalogPanel />
      ) : activeTab === 'bodegas' ? (
        <WarehousesPanel />
      ) : activeTab === 'ordenes' ? (
        <PurchaseOrdersPanel />
      ) : (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px]">
          <div className="max-w-xl">
            {(() => {
              const current = placeholders[activeTab]
              if (current) {
                return (
                  <>
                    <h2 className="text-lg font-semibold text-theme-text">{current.title}</h2>
                    <p className="text-sm text-theme-text-muted/60 mt-2">{current.desc}</p>
                    <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg">
                      <span>⏳</span> Próximamente
                    </div>
                  </>
                )
              }
              return (
                <>
                  <h2 className="text-lg font-semibold text-theme-text">Panel de Adquisiciones</h2>
                  <p className="text-sm text-theme-text-muted/60 mt-2">Resumen general del módulo de compras y abastecimiento.</p>
                </>
              )
            })()}
          </div>
          {children}
        </div>
      )}
    </ModuleLayout>
  )
}
