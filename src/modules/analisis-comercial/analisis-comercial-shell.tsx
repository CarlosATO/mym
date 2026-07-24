'use client'

import { useSidebarSection } from './hooks/use-sidebar-section'
import { VistaGeneral } from './views/vista-general'
import { Proveedor360 } from './views/proveedor-360'
import { Producto360 } from './views/producto-360'
import { RecepcionVsVenta } from './views/recepcion-vs-venta'
import { Predictivo } from './views/predictivo'

export function AnalisisComercialShell() {
  const { activeSection } = useSidebarSection()

  switch (activeSection) {
    case 'vista-general':
      return <VistaGeneral />
    case 'proveedor-360':
      return <Proveedor360 />
    case 'producto-360':
      return <Producto360 />
    case 'clientes':
      return <div className="p-6"><span className="text-theme-text-muted text-sm">Próximamente: Vista de Clientes</span></div>
    case 'recepcion-vs-venta':
      return <RecepcionVsVenta />
    case 'predictivo':
      return <Predictivo />
    default:
      return <VistaGeneral />
  }
}
