import { ClipboardList } from 'lucide-react'
import { InventorySectionPage } from '@/modules/inventarios/components/inventory-section-page'

export default function InventariosJornadasPage() {
  return (
    <InventorySectionPage
      title="Jornadas"
      description="Consulta y gestiona todas las jornadas de inventario de la empresa."
      breadcrumb={['Inventarios', 'Jornadas']}
      emptyTitle="Aún no hay jornadas"
      emptyDescription="Crea tu primera jornada de inventario para comenzar."
      icon={<ClipboardList className="h-5 w-5" />}
    />
  )
}
