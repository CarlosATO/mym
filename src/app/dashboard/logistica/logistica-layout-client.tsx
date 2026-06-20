'use client'

import { useState } from 'react'
import { ModuleLayout } from '@/components/modules/module-layout'
import { RecepcionesPanel } from '@/modules/logistica/recepciones/recepciones-panel'
import { LocationsPanel } from '@/modules/logistica/ubicaciones/locations-panel'
import { KardexPanel } from '@/modules/logistica/kardex/kardex-panel'
import { StockPanel } from '@/modules/logistica/stock/stock-panel'

const tabs = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'recepciones', label: 'Recepciones' },
  { id: 'ubicaciones', label: 'Ubicaciones' },
  { id: 'kardex', label: 'Kardex' },
  { id: 'stock', label: 'Stock' },
]

interface LogisticaLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function LogisticaLayoutClient({ children, profile }: LogisticaLayoutClientProps) {
  const [activeTab, setActiveTab] = useState('inicio')

  return (
    <ModuleLayout
      moduleName="Logística"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      profile={profile}
    >
      {activeTab === 'recepciones' ? (
        <RecepcionesPanel />
      ) : activeTab === 'ubicaciones' ? (
        <LocationsPanel />
      ) : activeTab === 'kardex' ? (
        <KardexPanel />
      ) : activeTab === 'stock' ? (
        <StockPanel />
      ) : (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-6 lg:p-8 min-h-[300px]">
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold text-theme-text">Panel de Logística</h2>
            <p className="text-sm text-theme-text-muted/60 mt-2">
              Bienvenido al módulo de control de almacén. Gestione recepciones de compras, ubicaciones físicas, movimientos de Kardex y niveles de stock.
            </p>
          </div>
          {children}
        </div>
      )}
    </ModuleLayout>
  )
}
