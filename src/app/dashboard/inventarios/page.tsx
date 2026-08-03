import Link from 'next/link'
import { ArrowRight, Bell, Boxes, ClipboardList, Eye, History, ListChecks, PlayCircle, Plus } from 'lucide-react'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryKpiCard } from '@/modules/inventarios/components/inventory-kpi-card'
import { InventoryQuickAction } from '@/modules/inventarios/components/inventory-quick-action'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'

export default function InventariosResumenPage() {
  return (
    <div className="space-y-6">
      <InventoryPageHeader
        title="Inventarios"
        description="Gestiona jornadas de inventario: creación, conteo, revisión y resultados."
        breadcrumb={['Inventarios', 'Resumen']}
        action={
          <Link
            href="/dashboard/inventarios/jornadas/nueva"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover"
          >
            <Plus className="h-4 w-4" />
            Nueva jornada
          </Link>
        }
      />

      {/* KPIs */}
      <section aria-label="Indicadores">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InventoryKpiCard
            label="Jornadas activas"
            value={null}
            hint="Jornadas en preparación, conteo o revisión."
            href="/dashboard/inventarios/jornadas"
            icon={<Boxes className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Avance de conteo"
            value={null}
            hint="Progreso de las tareas completadas en jornadas en conteo."
            href="/dashboard/inventarios/operacion"
            icon={<ListChecks className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Pendientes de revisión"
            value={null}
            hint="Jornadas cerradas que esperan validación y aprobación."
            href="/dashboard/inventarios/revision"
            icon={<Eye className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Incidencias bloqueantes"
            value={null}
            hint="Incidencias activas que impiden continuar una jornada."
            href="/dashboard/inventarios/jornadas"
            icon={<Bell className="h-4 w-4" />}
          />
        </div>
      </section>

      {/* Accesos rápidos */}
      <section aria-label="Accesos rápidos">
        <h2 className="mb-2.5 text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Accesos rápidos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InventoryQuickAction
            label="Nueva jornada"
            description="Crea y configura una jornada"
            href="/dashboard/inventarios/jornadas/nueva"
            icon={<Plus className="h-4 w-4" />}
          />
          <InventoryQuickAction
            label="Continuar jornada"
            description="Operación y avance de conteo"
            href="/dashboard/inventarios/operacion"
            icon={<PlayCircle className="h-4 w-4" />}
          />
          <InventoryQuickAction
            label="Revisar resultados"
            description="Validación y aprobación"
            href="/dashboard/inventarios/revision"
            icon={<ClipboardList className="h-4 w-4" />}
          />
          <InventoryQuickAction
            label="Consultar historial"
            description="Jornadas anteriores y resultados"
            href="/dashboard/inventarios/resultados"
            icon={<History className="h-4 w-4" />}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Jornadas que requieren atención */}
        <section aria-label="Jornadas que requieren atención">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Requieren atención</h2>
            <Link href="/dashboard/inventarios/jornadas" className="flex items-center gap-1 text-xs font-medium text-theme-accent hover:underline">
              Ver todas <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
            <InventoryEmptyState
              title="Sin jornadas pendientes"
              description="Las jornadas que necesiten tu atención aparecerán aquí."
              icon={<Bell className="h-5 w-5" />}
            />
          </div>
        </section>

        {/* Alertas y actividad reciente */}
        <section aria-label="Alertas y actividad reciente">
          <h2 className="mb-2.5 text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Alertas recientes</h2>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <InventoryStatusBadge status="DRAFT" />
                <span className="text-sm text-theme-text-muted">Sin actividad reciente aún.</span>
              </div>
              <p className="text-xs text-theme-text-muted/70">
                Esta sección mostrará los últimos eventos de tus jornadas una vez comiences a operar.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
