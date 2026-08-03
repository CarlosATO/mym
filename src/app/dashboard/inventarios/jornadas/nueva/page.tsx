import { Plus } from 'lucide-react'
import { InventorySectionPage } from '@/modules/inventarios/components/inventory-section-page'

export default function InventariosNuevaJornadaPage() {
  return (
    <InventorySectionPage
      title="Nueva jornada"
      description="El asistente de creación y configuración de jornadas estará disponible próximamente."
      breadcrumb={['Inventarios', 'Jornadas', 'Nueva']}
      emptyTitle="Asistente en construcción"
      emptyDescription="Podrás crear y configurar jornadas en pocos pasos desde aquí."
      icon={<Plus className="h-5 w-5" />}
    />
  )
}
