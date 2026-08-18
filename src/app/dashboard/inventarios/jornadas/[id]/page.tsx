import { notFound } from 'next/navigation'
import { ClipboardList, FileCheck2, Settings2 } from 'lucide-react'
import { listInventoryCampaignParticipants } from '@/app/actions/inventarios/campaigns'
import { listInventorySessionScopes } from '@/app/actions/inventarios/counting-zones'
import { getActiveCompanySessionDetail, getActiveCompanySessionReview, getInventorySessionCatalogs, getInventorySessionImportContext, type CatalogUserOption } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyResults } from '@/app/actions/inventarios/results'
import { InventorySessionHeader } from '@/modules/inventarios/components/inventory-session-header'
import { InventorySessionTabs, type InventoryTab } from '@/modules/inventarios/components/inventory-session-tabs'
import { InventorySessionOverview } from '@/modules/inventarios/components/inventory-session-overview'
import { InventoryParticipantsPanel } from '@/modules/inventarios/components/inventory-participants-panel'
import { InventoryParticipantsStep } from '@/modules/inventarios/components/inventory-participants-step'
import { InventoryZonesStep } from '@/modules/inventarios/components/inventory-zones-step'
import { InventoryTasksStep } from '@/modules/inventarios/components/inventory-tasks-step'
import { InventoryReviewStep } from '@/modules/inventarios/components/inventory-review-step'
import { InventoryPrepareSection } from '@/modules/inventarios/components/inventory-prepare-section'
import { InventoryImportReviewStep } from '@/modules/inventarios/components/inventory-import-review-step'
import { InventoryOperationPanel } from '@/modules/inventarios/components/inventory-operation-panel'
import { InventoryZonesPanel } from '@/modules/inventarios/components/inventory-zones-panel'
import { InventoryOperationalSetup } from '@/modules/inventarios/components/inventory-operational-setup'
import { InventoryTasksPanel } from '@/modules/inventarios/components/inventory-tasks-panel'
import { InventoryReviewDashboard } from '@/modules/inventarios/components/inventory-review-dashboard'
import { InventoryResultsPanel } from '@/modules/inventarios/components/inventory-results-panel'
import { InventoryCancellationPanel } from '@/modules/inventarios/components/inventory-cancellation-panel'
import { InventoryCancelSessionPanel } from '@/modules/inventarios/components/inventory-cancel-session-panel'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function getTabsForStatus(status: string, hasPendingLocations: boolean): InventoryTab[] {
  const tabs: InventoryTab[] = [{ id: 'resumen', label: 'Resumen' }]
  if (status === 'DRAFT' || ((status === 'PREPARED' || status === 'COUNTING') && hasPendingLocations)) {
    tabs.push({ id: 'configuracion', label: 'Asignación de zonas' })
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
  const importContextResult = await getInventorySessionImportContext(id)
  const importContext = importContextResult.data
  const scopesResult = status === 'PREPARED' || status === 'COUNTING'
    ? await listInventorySessionScopes(companyId, id)
    : null
  const tabs = getTabsForStatus(status, (scopesResult?.data?.pending_locations ?? 0) > 0)
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

  const campaignParticipantsResult = companyId && importContext?.campaign_id
    ? await listInventoryCampaignParticipants(companyId, importContext.campaign_id)
    : { data: null }
  const campaignParticipants = campaignParticipantsResult.data?.participants ?? []
  const isExcelImport = importContext?.stock_source === 'EXCEL_IMPORT'

  const isCancelled = status === 'CANCELLED'

  return (
    <div className="space-y-4">
      <InventorySessionHeader
        detail={detail}
        campaign={
          importContext?.campaign_id
            ? {
                id: importContext.campaign_id,
                name: importContext.campaign_name,
                siteName: importContext.site_name,
              }
            : undefined
        }
        action={
          ['DRAFT', 'PREPARED', 'COUNTING', 'UNDER_REVIEW'].includes(status) ? (
            <InventoryCancelSessionPanel companyId={companyId} sessionId={id} />
          ) : undefined
        }
      />

      <InventorySessionTabs tabs={tabs} />

      {safeTab === 'resumen' && (
        <div className="space-y-4">
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
          {isExcelImport ? (
            status === 'DRAFT' ? (
              <InventoryImportReviewStep
                companyId={companyId}
                sessionId={id}
                setup={{
                  session: {
                    name: detail.session.name,
                    site_name: importContext?.site_name ?? null,
                    site_type: importContext?.site_type ?? null,
                    stock_source: importContext?.stock_source ?? null,
                    stock_import_id: importContext?.stock_import_id ?? null,
                    scope_mode: detail.session.scope_mode,
                  },
                }}
              />
             ) : (status === 'PREPARED' || status === 'COUNTING') && importContext?.campaign_id ? (
               <InventoryOperationalSetup companyId={companyId} sessionId={id} campaignId={importContext.campaign_id} />
             ) : (
               <div className="space-y-4">
                <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
                  <h3 className="mb-2 text-sm font-semibold text-theme-text">Importación asociada (solo lectura)</h3>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div>
                      <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Archivo</p>
                      <p className="truncate font-medium text-theme-text">{importContext?.import_filename ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Modalidad</p>
                      <p className="font-medium text-theme-text">{importContext?.import_modality ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Corte</p>
                      <p className="font-medium text-theme-text">{importContext?.import_cutoff_at ? formatDateChile(importContext.import_cutoff_at) : '—'}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Estado importación</p>
                      <p className="font-medium text-theme-text">{importContext?.import_status ?? '—'}</p>
                    </div>
                  </div>
                </div>
                <InventoryParticipantsPanel detail={detail} campaignParticipants={campaignParticipants} />
                <InventoryZonesPanel detail={detail} />
                <InventoryTasksPanel detail={detail} />
              </div>
            )
           ) : status === 'DRAFT' && activeStep === 3 ? (
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
           ) : (status === 'PREPARED' || status === 'COUNTING') && importContext?.campaign_id ? (
             <InventoryOperationalSetup companyId={companyId} sessionId={id} campaignId={importContext.campaign_id} />
           ) : (
            <>
                <InventoryParticipantsPanel detail={detail} campaignParticipants={campaignParticipants} />
              <InventoryZonesPanel detail={detail} />
              <InventoryTasksPanel detail={detail} />
            </>
          )}

          {status === 'DRAFT' && !isExcelImport && activeStep !== 6 && (
            <InventoryPrepareSection companyId={companyId} sessionId={id} />
          )}
        </div>
      )}

      {safeTab === 'operacion' && (
        <InventoryOperationPanel
          key={`op-${status}-${detail.session.updated_at}`}
          companyId={companyId}
          sessionId={id}
          initialDetail={detail}
        />
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
              <>
                <InventoryResultsPanel
                  sessionId={id}
                  results={results}
                  search={typeof sp.q === 'string' ? sp.q : ''}
                  differenceType={typeof sp.dif === 'string' ? sp.dif : ''}
                />
              </>
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
              description="Los resultados oficiales se publican una vez aprobada la sección de conteo."
              icon={<FileCheck2 className="h-5 w-5" />}
            />
          )}
        </div>
      )}
    </div>
  )
}
