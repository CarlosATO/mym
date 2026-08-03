import { Eye } from 'lucide-react'
import { InventorySectionPage } from '@/modules/inventarios/components/inventory-section-page'

export default function InventariosRevisionPage() {
  return (
    <InventorySectionPage
      title="Revisión"
      description="Valida tareas, revisa recuentos y prepara la aprobación de resultados."
      breadcrumb={['Inventarios', 'Revisión']}
      emptyTitle="Sin jornadas en revisión"
      emptyDescription="Las jornadas cerradas que esperan validación aparecerán aquí."
      icon={<Eye className="h-5 w-5" />}
    />
  )
}
