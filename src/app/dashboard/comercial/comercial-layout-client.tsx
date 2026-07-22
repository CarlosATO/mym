'use client'

import { useState } from 'react'
import { ModuleLayout } from '@/components/modules/module-layout'
import { CustomersPanel } from '@/modules/comercial/clientes/customers-panel'
import { ReceivablesPanel } from '@/modules/comercial/cobranza/receivables-panel'
import { CommissionsPanel } from '@/modules/comercial/comisiones/commissions-panel'
import type { RibbonAction } from '@/components/layout/module-ribbon'

const tabs = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'maestros', label: 'Maestros' },
  { id: 'transacciones', label: 'Transacciones' },
  { id: 'consultas', label: 'Consultas' },
  { id: 'reportes', label: 'Reportes' },
]

interface ComercialLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function ComercialLayoutClient({ profile }: ComercialLayoutClientProps) {
  const [activeTab, setActiveTab] = useState('inicio')
  const [activeActionId, setActiveActionId] = useState('resumen')

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId)
    if (tabId === 'inicio') setActiveActionId('resumen')
    else if (tabId === 'maestros') setActiveActionId('clientes')
  }

  const ribbonActions: RibbonAction[] = []

  if (activeTab === 'maestros') {
    ribbonActions.push(
      { id: 'clientes', label: 'Clientes', icon: 'Users', onClick: () => setActiveActionId('clientes') },
      { id: 'analisis-clientes', label: 'Análisis de clientes', icon: 'LineChart', onClick: () => setActiveActionId('analisis-clientes') },
      { id: 'comisiones', label: 'Comisiones', icon: 'BadgeDollarSign', onClick: () => setActiveActionId('comisiones') }
    )
  }

  let content = null

  if (activeTab === 'inicio') {
    content = (
      <div className="p-6 lg:p-8">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-theme-text font-accent">Panel Comercial</h2>
          <p className="text-sm text-theme-text-muted/60 mt-2">
            Resumen general del módulo Comercial. Use las pestañas superiores para navegar.
          </p>
        </div>
      </div>
    )
  } else if (activeTab === 'maestros') {
    if (activeActionId === 'clientes') {
      content = <CustomersPanel />
    } else if (activeActionId === 'analisis-clientes') {
      content = <ReceivablesPanel />
    } else if (activeActionId === 'comisiones') {
      content = <CommissionsPanel />
    }
  } else {
    content = (
      <div className="p-6 lg:p-8">
        <div className="max-w-xl">
          <h2 className="text-lg font-semibold text-theme-text">Sección en desarrollo</h2>
          <div className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-theme-accent/70 uppercase tracking-wider border border-theme-accent/20 bg-theme-accent-hover/8 px-3 py-1.5 rounded-lg w-fit">
            <span>⏳</span> Próximamente
          </div>
        </div>
      </div>
    )
  }

  // Always use workspace mode so ModuleLayout never applies max-w-7xl mx-auto.
  // Each panel manages its own internal layout/padding.
  return (
    <ModuleLayout
      moduleName="Comercial"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      ribbonActions={ribbonActions}
      activeActionId={activeActionId}
      layoutMode="workspace"
      profile={profile}
    >
      {content}
    </ModuleLayout>
  )
}
