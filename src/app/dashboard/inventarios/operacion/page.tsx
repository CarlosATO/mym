import { PlayCircle } from 'lucide-react'
import { InventorySectionPage } from '@/modules/inventarios/components/inventory-section-page'

export default function InventariosOperacionPage() {
  return (
    <InventorySectionPage
      title="Operación"
      description="Abre jornadas, inicia tareas y sigue el avance del conteo."
      breadcrumb={['Inventarios', 'Operación']}
      emptyTitle="Sin jornadas en operación"
      emptyDescription="Las jornadas en preparación o conteo aparecerán aquí."
      icon={<PlayCircle className="h-5 w-5" />}
    />
  )
}
