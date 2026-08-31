import Link from 'next/link'
import { ArrowRight, Bell, Boxes, ClipboardList, Eye, History, ListChecks, PlayCircle, Plus, ShieldAlert } from 'lucide-react'
import { getActiveCompanyDashboardSummary } from '@/app/actions/inventarios/summary'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryKpiCard } from '@/modules/inventarios/components/inventory-kpi-card'
import { InventoryQuickAction } from '@/modules/inventarios/components/inventory-quick-action'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'
import { canPublishMobileApp, getActiveMobileRelease } from '@/app/actions/inventarios/mobile-app'
import { getCampaignSessionCreatePermission } from '@/app/actions/inventarios/campaigns'
import { InventoryMobileAppCard } from '@/modules/inventarios/components/inventory-mobile-app-card'

function kpiPercent(value: number): string {
  return `${Math.round(value)}%`
}

export default async function InventariosResumenPage() {
  const { data, error, companyId } = await getActiveCompanyDashboardSummary()
  const mobileRelease = await getActiveMobileRelease()
  const canPublishMobile = await canPublishMobileApp()
  const { canCreate } = await getCampaignSessionCreatePermission()

  const kpis = data?.kpis
  const attention = data?.attention_sessions ?? []
  const alerts = data?.recent_alerts ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Inventarios"
        description="Gestiona secciones de conteo: creación, conteo, revisión y resultados."
        breadcrumb={['Inventarios', 'Resumen']}
        action={canCreate ? (
          <Link
            href="/dashboard/inventarios/jornadas/nueva"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover"
          >
            <Plus className="h-4 w-4" />
            Nueva sección de conteo
          </Link>
        ) : undefined}
      />

      {/* KPIs */}
      <section aria-label="Indicadores">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InventoryKpiCard
            label="Secciones activas"
            value={kpis?.active_count ?? null}
            hint="Secciones en preparación o en conteo."
            href="/dashboard/inventarios/operacion"
            icon={<Boxes className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Avance de conteo"
            value={kpis ? kpiPercent(kpis.average_progress) : null}
            hint="Tareas completadas en secciones en conteo."
            href="/dashboard/inventarios/operacion"
            icon={<ListChecks className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Pendientes de revisión"
            value={kpis?.review_count ?? null}
            hint="Secciones cerradas que esperan validación y aprobación."
            href="/dashboard/inventarios/revision"
            icon={<Eye className="h-4 w-4" />}
          />
          <InventoryKpiCard
            label="Incidencias bloqueantes"
            value={kpis?.blocking_count ?? null}
            hint="Incidencias activas que impiden continuar una sección de conteo."
            href="/dashboard/inventarios/jornadas"
            icon={<Bell className="h-4 w-4" />}
          />
        </div>
      </section>

      {/* Accesos rápidos */}
      <section aria-label="Accesos rápidos">
        <h2 className="mb-2.5 text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Accesos rápidos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {canCreate && (
            <InventoryQuickAction
              label="Nueva sección de conteo"
              description="Crea y configura una sección de conteo"
              href="/dashboard/inventarios/jornadas/nueva"
              icon={<Plus className="h-4 w-4" />}
            />
          )}
          <InventoryQuickAction
            label="Continuar sección"
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
            description="Secciones anteriores y resultados"
            href="/dashboard/inventarios/resultados"
            icon={<History className="h-4 w-4" />}
          />
        </div>
      </section>

      <InventoryMobileAppCard release={mobileRelease} canPublish={canPublishMobile} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Secciones que requieren atención */}
        <section aria-label="Secciones que requieren atención">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Requieren atención</h2>
            <Link href="/dashboard/inventarios/jornadas" className="flex items-center gap-1 text-xs font-medium text-theme-accent hover:underline">
              Ver todas <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
            {error && !companyId ? (
              <InventoryErrorState description={error} />
            ) : attention.length === 0 ? (
              <InventoryEmptyState
                title="Sin secciones pendientes"
                description="Las secciones que necesiten tu atención aparecerán aquí."
                icon={<Bell className="h-5 w-5" />}
              />
            ) : (
              <ul className="space-y-2">
                {attention.map(session => (
                  <li key={session.id}>
                    <Link
                      href={
                        session.status === 'UNDER_REVIEW'
                          ? `/dashboard/inventarios/jornadas/${session.id}?tab=revision`
                          : `/dashboard/inventarios/jornadas/${session.id}`
                      }
                      className="flex items-center justify-between gap-2 rounded-lg border border-theme-border/50 bg-theme-text/2 px-3 py-2 transition-colors hover:bg-theme-text/5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-theme-text">
                          #{session.session_number} {session.name}
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-xs text-theme-text-muted">
                          <span>{session.warehouse_name ?? '—'}</span>
                          {session.blocking_incident_count > 0 && (
                            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                              <ShieldAlert className="h-3 w-3" />
                              {session.blocking_incident_count} bloqueante(s)
                            </span>
                          )}
                        </p>
                      </div>
                      <InventoryStatusBadge status={session.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Alertas y actividad reciente */}
        <section aria-label="Alertas y actividad reciente">
          <h2 className="mb-2.5 text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Alertas recientes</h2>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
            {error && !companyId ? (
              <InventoryErrorState description={error} />
            ) : alerts.length === 0 ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <InventoryStatusBadge status="UNDER_REVIEW" />
                  <span className="text-sm text-theme-text-muted">Sin alertas activas.</span>
                </div>
                <p className="text-xs text-theme-text-muted/70">
                  Las incidencias abiertas de tus secciones aparecerán aquí.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {alerts.map(alert => (
                  <li key={alert.id}>
                    <Link
                      href={`/dashboard/inventarios/jornadas/${alert.session_id}?tab=revision`}
                      className="flex items-start justify-between gap-2 rounded-lg border border-theme-border/50 bg-theme-text/2 px-3 py-2 transition-colors hover:bg-theme-text/5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-theme-text">
                          <span className="font-semibold">#{alert.session_number}</span> {alert.session_name}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-theme-text-muted">{alert.description}</p>
                        <p className="mt-0.5 text-[11px] text-theme-text-muted/70">
                          {alert.reported_by_name ?? '—'} · {formatDateChile(alert.reported_at)}
                        </p>
                      </div>
                      {alert.is_blocking && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                          <ShieldAlert className="h-3 w-3" /> Bloqueante
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
