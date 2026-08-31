import { createClient } from '@/lib/supabase/server'
import { ModuleCard } from '@/components/module-card'
import { LatestRouteGuides } from '@/components/portal/latest-route-guides'
import type { Modulo } from '@/lib/types'
import { getPortalLatestRouteGuides } from '@/app/actions/logistica/guias-ruta'
import { getPortalSales, type PortalSales } from '@/app/actions/portal/sales'
import { getPortalCollectionsByMode } from '@/app/actions/portal/collections'
import { getPortalAmimascota } from '@/app/actions/portal/amimascota'
import { PortalFinancialSection } from '@/components/portal/portal-financial-section'
import { AmimascotaCard } from '@/components/portal/amimascota-card'
import { getPortalTopProducts } from '@/app/actions/portal/top-products'
import { TopProductsCard } from '@/components/portal/top-products-card'
import type { PortalPeriodMode } from '@/app/actions/portal/periods'

const adminCodes = ['dashboard', 'usuarios', 'roles', 'auditoria', 'seguridad']

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido')
    .eq('id', user.id)
    .maybeSingle()

  const { data: modules } = await supabase.rpc('get_visible_modules', { p_user_id: user.id })
  const { data: isSystemAdmin } = await supabase.rpc('has_permission', {
    p_permission_code: 'system.admin',
  })

  const allModules: Modulo[] = modules ?? []
  const operationalModules = allModules.filter(m => !adminCodes.includes(m.code))

  operationalModules.sort((a, b) => {
    const aHasRoute = typeof a.route === 'string' && a.route.trim().length > 0
    const bHasRoute = typeof b.route === 'string' && b.route.trim().length > 0
    return Number(bHasRoute) - Number(aHasRoute)
  })

  const kpiResults = isSystemAdmin === true ? await Promise.allSettled([
    getPortalLatestRouteGuides(),
    getPortalSales('CALENDAR_MONTH'),
    getPortalSales('COMMISSIONABLE'),
    getPortalCollectionsByMode(),
    getPortalAmimascota(),
    getPortalTopProducts(),
  ]) : null
  const guidesResult = kpiResults?.[0]
  const salesCalendarResult = kpiResults?.[1]
  const salesCommissionableResult = kpiResults?.[2]
  const collectionsResult = kpiResults?.[3]
  const amimascotaResult = kpiResults?.[4]
  const topProductsResult = kpiResults?.[5]
  const latestRouteGuides = guidesResult?.status === 'fulfilled' ? guidesResult.value : []
  const sales: Record<PortalPeriodMode, PortalSales | null> = {
    CALENDAR_MONTH: salesCalendarResult?.status === 'fulfilled' ? salesCalendarResult.value : null,
    COMMISSIONABLE: salesCommissionableResult?.status === 'fulfilled' ? salesCommissionableResult.value : null,
  }
  const amimascota = amimascotaResult?.status === 'fulfilled' ? amimascotaResult.value : null
  const topProducts = topProductsResult?.status === 'fulfilled' ? topProductsResult.value : []

  return (
    <>
      {/* Columna izquierda + columna derecha: flujo vertical independiente */}
      <div className="grid gap-4 pb-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(500px,1fr)]">
        {/* ── COLUMNA IZQUIERDA ── */}
        <div className="flex flex-col gap-4">
          {/* Bienvenido */}
          <section className="overflow-hidden rounded-2xl border border-sky-500/20 bg-sky-700 px-5 py-3 text-white shadow-sm shadow-sky-950/10 sm:px-6">
            <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-sky-100/75">Portal de Gestión MYM</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Bienvenido {profile?.nombre ?? 'Usuario'}</h1>
              <p className="text-xs text-sky-100/85 sm:text-sm">Sistema unificado</p>
            </div>
          </section>

          {/* Módulos disponibles */}
          {operationalModules.length > 0 ? (
            <section className="space-y-2">
              <div className="flex items-end justify-between gap-3 px-1">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight text-theme-text">Módulos disponibles</h2>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {operationalModules.map((mod) => (
                  <div key={mod.id} className="h-full">
                    <ModuleCard module={mod} />
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-theme-text">Módulos disponibles</h2>
              </div>
              <div className="rounded-2xl border border-dashed border-theme-border bg-theme-surface/60 p-10 text-center">
                <p className="text-theme-text-muted/50 text-sm">No hay módulos operativos disponibles para tu usuario.</p>
              </div>
            </div>
          )}

          {isSystemAdmin === true && (
            <AmimascotaCard data={amimascota} error={amimascotaResult?.status === 'rejected'} />
          )}
        </div>

        {/* ── COLUMNA DERECHA ── */}
        {isSystemAdmin === true && <div className="flex flex-col gap-4">
          {/* Últimas Guías de Ruta */}
          <LatestRouteGuides guides={latestRouteGuides} />

          {/* Top 5 productos */}
          <TopProductsCard products={topProducts} error={topProductsResult?.status === 'rejected'} />
        </div>}
      </div>

      {/* ── FILA INFERIOR: Ventas y Cobranzas ── */}
      {isSystemAdmin === true && <div className="grid gap-4 pb-4 sm:grid-cols-2">
        <PortalFinancialSection
          sales={sales}
          collections={collectionsResult?.status === 'fulfilled' ? collectionsResult.value : { CALENDAR_MONTH: null, COMMISSIONABLE: null }}
          salesError={salesCalendarResult?.status === 'rejected' || salesCommissionableResult?.status === 'rejected'}
          collectionsError={collectionsResult?.status === 'rejected'}
        />
      </div>}
    </>
  )
}
