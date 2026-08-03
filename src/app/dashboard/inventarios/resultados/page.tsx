import { FileCheck2 } from 'lucide-react'
import { InventorySectionPage } from '@/modules/inventarios/components/inventory-section-page'

export default function InventariosResultadosPage() {
  return (
    <InventorySectionPage
      title="Resultados"
      description="Consulta los resultados oficiales, diferencias y estado de exportación."
      breadcrumb={['Inventarios', 'Resultados']}
      emptyTitle="Sin resultados aún"
      emptyDescription="Las jornadas aprobadas, exportadas, conciliadas o canceladas aparecerán aquí."
      icon={<FileCheck2 className="h-5 w-5" />}
    />
  )
}
