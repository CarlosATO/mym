import { createClient } from '@/lib/supabase/server'
import { ModuleCard } from '@/components/module-card'
import { LatestRouteGuides } from '@/components/portal/latest-route-guides'
import type { Modulo } from '@/lib/types'
import { getPortalLatestRouteGuides } from '@/app/actions/logistica/guias-ruta'
import { getPortalSales } from '@/app/actions/portal/sales'
import { getPortalCollections } from '@/app/actions/portal/collections'
import { getPortalAmimascota } from '@/app/actions/portal/amimascota'
import { PortalFinancialCard } from '@/components/portal/portal-financial-cards'
import { AmimascotaCard } from '@/components/portal/amimascota-card'
import { getPortalTopProducts } from '@/app/actions/portal/top-products'
import { TopProductsCard } from '@/components/portal/top-products-card'

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

  const allModules: Modulo[] = modules ?? []
  const operationalModules = allModules.filter(m => !adminCodes.includes(m.code))
  
  if (!operationalModules.find(m => m.code === 'comercial')) {
    operationalModules.push({
      id: 'mock-comercial-id',
      code: 'comercial',
      name: 'Clientes y Ventas',
      description: 'Gestión comercial, clientes, documentos y análisis de ventas.',
      icon: 'Briefcase',
      route: '/dashboard/comercial',
      sort_order: 30
    })
  }

  if (!operationalModules.find(m => m.code === 'analisis-comercial')) {
    operationalModules.push({
      id: 'mock-analisis-comercial-id',
      code: 'analisis-comercial',
      name: 'Análisis Comercial',
      description: 'Análisis amplio por proveedor real, producto, ventas, stock, clientes y recepción vs venta.',
      icon: 'BarChart3',
      route: '/dashboard/analisis-comercial',
      sort_order: 25
    })
  }

  operationalModules.sort((a, b) => {
    const aHasRoute = typeof a.route === 'string' && a.route.trim().length > 0
    const bHasRoute = typeof b.route === 'string' && b.route.trim().length > 0
    return Number(bHasRoute) - Number(aHasRoute)
  })

  const [guidesResult, salesResult, collectionsResult, amimascotaResult, topProductsResult] = await Promise.allSettled([
    getPortalLatestRouteGuides(),
    getPortalSales(),
    getPortalCollections(),
    getPortalAmimascota(),
    getPortalTopProducts(),
  ])
  const latestRouteGuides = guidesResult.status === 'fulfilled' ? guidesResult.value : []
  const sales = salesResult.status === 'fulfilled' ? salesResult.value : null
  const collections = collectionsResult.status === 'fulfilled' ? collectionsResult.value : null
  const amimascota = amimascotaResult.status === 'fulfilled' ? amimascotaResult.value : null
  const topProducts = topProductsResult.status === 'fulfilled' ? topProductsResult.value : []

  return (
    <>
      <div className="pb-8 xl:grid xl:grid-cols-[minmax(0,1.55fr)_minmax(500px,1fr)] xl:items-start xl:gap-6">
        <div className="space-y-6">
        <section className="overflow-hidden rounded-2xl border border-sky-500/20 bg-sky-700 px-5 py-4 text-white shadow-sm shadow-sky-950/10 sm:px-6">
          <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-sky-100/75">Portal de Gestión MYM</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Bienvenido {profile?.nombre ?? 'Usuario'}</h1>
            <p className="text-xs text-sky-100/85 sm:text-sm">Todo lo operativo, en un solo lugar.</p>
          </div>
        </section>

        <div className="space-y-5">
            {operationalModules.length > 0 ? (
              <section className="space-y-3">
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
            <AmimascotaCard data={amimascota} error={amimascotaResult.status === 'rejected'} />
        </div>
        </div>

        <div className="space-y-4">
          <LatestRouteGuides guides={latestRouteGuides} />
          <TopProductsCard products={topProducts} error={topProductsResult.status === 'rejected'} />
        </div>
      </div>
      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PortalFinancialCard
          kind="sales"
          data={sales}
          error={salesResult.status === 'rejected' ? 'sales' : null}
        />
        <PortalFinancialCard
          kind="collections"
          data={collections}
          error={collectionsResult.status === 'rejected' ? 'collections' : null}
        />
      </section>
    </>
  )
}
