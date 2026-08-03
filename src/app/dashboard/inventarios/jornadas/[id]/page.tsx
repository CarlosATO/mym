import { notFound } from 'next/navigation'
import { ClipboardList, FileCheck2, Settings2 } from 'lucide-react'
import { getActiveCompanySessionDetail, getActiveCompanySessionReview, getInventorySessionCatalogs, type CatalogUserOption } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyResults } from '@/app/actions/inventarios/results'
import { InventorySessionHeader } from '@/modules/inventarios/components/inventory-session-header'
import { InventorySessionTabs, type InventoryTab } from '@/modules/inventarios/components/inventory-session-tabs'
import { InventorySessionOverview } from '@/modules/inventarios/components/inventory-session-overview'
import { InventoryParticipantsPanel } from '@/modules/inventarios/components/inventory-participants-panel'
import { InventoryParticipantsStep } from '@/modules/inventarios/components/inventory-participants-step'
import { InventoryZonesStep } from '@/modules/inventarios/components/inventory-zones-step'
import { InventoryTasksStep } from '@/modules/inventarios/components/inventory-tasks-step'
import { InventoryReviewStep } from '@/modules/inventarios/components/inventory-review-step'
import { InventoryOperationPanel } from '@/modules/inventarios/components/inventory-operation-panel'
import { InventoryZonesPanel } from '@/modules/inventarios/components/inventory-zones-panel'
import { InventoryTasksPanel } from '@/modules/inventarios/components/inventory-tasks-panel'
import { InventoryReviewDashboard } from '@/modules/inventarios/components/inventory-review-dashboard'
import { InventoryResultsPanel } from '@/modules/inventarios/components/inventory-results-panel'
import { InventoryCancellationPanel } from '@/modules/inventarios/components/inventory-cancellation-panel'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { inventoryStatusLabel } from '@/modules/inventarios/lib/states'
import { formatDateChile } from '@/modules/inventarios/lib/format'

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function getTabsForStatus(status: string): InventoryTab[] {
  const tabs: InventoryTab[] = [{ id: 'resumen', label: 'Resumen' }]
  if (status === 'DRAFT' || status === 'PREPARED') {
    tabs.push({ id: 'configuracion', label: 'Configuración' })
  }
  if (status === 'PREPARED' || status === 'COUNTING') {
    tabs.push({ id: 'operacion', label: 'Operación' })
  }
  if (status === 'UNDER_REVIEW') {
    tabs.push({ id: 'revision', label: 'Revisión' })
  }
  if (status === 'APPROVED' || status === 'EXPORTED' || status === 'RECONCILED' || status === 'CANCELLED') {
    tabs.push({ id: 'resultados', label: 'Resultados' })
  }
  return tabs
}

export default async function InventariosJornadaDetallePage({ params, searchParams }: PageProps) {
  const { id } = await params
  const sp = await searchParams
  const activeTab = typeof sp.tab === 'string' ? sp.tab : 'resumen'
  const activeStep = typeof sp.step === 'string' ? Number.parseInt(sp.step, 10) || 1 : 1

  const { data: detail, error, companyId } = await getActiveCompanySessionDetail(id)

  if (!companyId) {
    return (
      <div className="space-y-5">
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<ClipboardList className="h-5 w-5" />}
        />
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={error} />
      </div>
    )
  }

  if (!detail) {
    notFound()
  }

  const status = detail.session.status
  const tabs = getTabsForStatus(status)
  const safeTab = tabs.some(t => t.id === activeTab) ? activeTab : tabs[0].id

  let review = null
  if (status === 'UNDER_REVIEW' && (safeTab === 'revision' || safeTab === 'resumen')) {
    const reviewResult = await getActiveCompanySessionReview(id)
    if (reviewResult.data) review = reviewResult.data
  }

  let results = null
  let resultsError = null
  const resultStatuses = ['APPROVED', 'EXPORTED', 'RECONCILED']
  if (resultStatuses.includes(status) && safeTab === 'resultados') {
    const resultsResult = await getActiveCompanyResults(id, {
      search: typeof sp.q === 'string' ? sp.q : '',
      difference_type: typeof sp.dif === 'string' ? sp.dif : '',
      page: Math.max(1, Number.parseInt(typeof sp.page === 'string' ? sp.page : '1', 10) || 1),
      page_size: 50,
    })
    if (resultsResult.data) results = resultsResult.data
    else if (resultsResult.error) resultsError = resultsResult.error
  }

  let eligibleUsers: CatalogUserOption[] = []
  let catalogLocations: Array<{ id: string; warehouse_id: string; code: string; name: string | null }> = []
  if (status === 'DRAFT' && safeTab === 'configuracion' && (activeStep === 3 || activeStep === 4 || activeStep === 5) && companyId) {
    const catalogs = await getInventorySessionCatalogs(companyId)
    eligibleUsers = catalogs.data?.users ?? []
    catalogLocations = catalogs.data?.locations ?? []
  }

  const isCancelled = status === 'CANCELLED'

  return (
    <div className="space-y-5">
      <InventorySessionHeader detail={detail} />

      <InventorySessionTabs tabs={tabs} />

      {safeTab === 'resumen' && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-theme-text-muted">
              Estado: <span className="font-semibold text-theme-text">{inventoryStatusLabel(status)}</span>
            </p>
            {isCancelled ? (
              <span className="text-sm text-theme-text-muted">
                Cancelada el {formatDateChile(detail.session.cancelled_at)}
              </span>
            ) : status === 'UNDER_REVIEW' ? (
              <span className="text-sm text-theme-text-muted">En revisión por el supervisor.</span>
            ) : status === 'APPROVED' ? (
              <span className="text-sm text-theme-text-muted">
                Aprobada el {formatDateChile(detail.session.approved_at)}
              </span>
            ) : null}
          </div>
          <InventorySessionOverview detail={detail} />
          {isCancelled && <InventoryCancellationPanel detail={detail} />}
        </div>
      )}

      {safeTab === 'configuracion' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-theme-text-muted">
            <Settings2 className="h-4 w-4" />
            {status === 'DRAFT' ? 'Configuración en edición.' : 'Configuración congelada.'}
          </div>
          {status === 'DRAFT' && activeStep === 3 ? (
            <InventoryParticipantsStep
              companyId={companyId}
              sessionId={id}
              users={eligibleUsers}
            />
          ) : status === 'DRAFT' && activeStep === 4 ? (
            <InventoryZonesStep
              companyId={companyId}
              sessionId={id}
              sessionWarehouseId={detail.session.warehouse_id}
              catalogs={{
                warehouses: [],
                offices: [],
                users: [],
                locations: catalogLocations,
              }}
            />
          ) : status === 'DRAFT' && activeStep === 5 ? (
            <InventoryTasksStep
              companyId={companyId}
              sessionId={id}
              users={eligibleUsers}
            />
          ) : status === 'DRAFT' && activeStep === 6 ? (
            <InventoryReviewStep companyId={companyId} sessionId={id} />
          ) : (
            <>
              <InventoryParticipantsPanel detail={detail} />
              <InventoryZonesPanel detail={detail} />
              <InventoryTasksPanel detail={detail} />
            </>
          )}
        </div>
      )}

      {safeTab === 'operacion' && (
        <InventoryOperationPanel companyId={companyId} sessionId={id} initialDetail={detail} />
      )}

      {safeTab === 'revision' && (
        <InventoryReviewDashboard companyId={companyId} sessionId={id} initialReview={review} />
      )}

      {safeTab === 'resultados' && (
        <div className="space-y-4">
          {isCancelled ? (
            <InventoryCancellationPanel detail={detail} />
          ) : status === 'APPROVED' || status === 'EXPORTED' || status === 'RECONCILED' ? (
            results ? (
              <InventoryResultsPanel
                sessionId={id}
                results={results}
                search={typeof sp.q === 'string' ? sp.q : ''}
                differenceType={typeof sp.dif === 'string' ? sp.dif : ''}
              />
            ) : resultsError ? (
              <InventoryErrorState description={resultsError} />
            ) : (
              <div className="rounded-xl border border-theme-border bg-theme-surface p-8 text-center text-sm text-theme-text-muted">
                Cargando resultados…
              </div>
            )
          ) : (
            <InventoryEmptyState
              title="Resultados oficiales"
              description="Los resultados oficiales se publican una vez aprobada la jornada."
              icon={<FileCheck2 className="h-5 w-5" />}
            />
          )}
        </div>
      )}
    </div>
  )
}
