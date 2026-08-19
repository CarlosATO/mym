import { createClient } from '@/lib/supabase/server'
import { ModuleCard } from '@/components/module-card'
import { OperationalAgenda } from '@/components/operational-agenda'
import type { Modulo } from '@/lib/types'
import Image from 'next/image'
import { getDispatchCalendarCities, getDispatchCalendars } from '@/app/actions/logistica/dispatch-calendar'
import { todayInSantiago } from '@/lib/datetime'

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

  const dispatchCalendarsResult = await getDispatchCalendars()
  const dispatchCalendar = dispatchCalendarsResult.data?.find(calendar => calendar.active) ?? dispatchCalendarsResult.data?.[0] ?? null
  const dispatchCitiesResult = dispatchCalendar ? await getDispatchCalendarCities(dispatchCalendar.id) : null
  const dispatchSummary = dispatchCalendar && dispatchCitiesResult?.data
    ? {
        name: dispatchCalendar.name,
        cutoffTime: dispatchCalendar.default_cutoff_time.slice(0, 5),
        assignments: dispatchCitiesResult.data.map(city => ({ weekday: city.weekday, normalized_city: city.normalized_city })),
      }
    : null

  return (
    <div className="pb-8 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6">
      <div className="space-y-7">
        <section className="relative isolate overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/65 shadow-sm">
          <div className="pointer-events-none absolute -right-20 -top-24 -z-10 h-56 w-56 rounded-full bg-theme-accent/10 blur-3xl" />
          <div className="grid items-center gap-3 px-5 py-4 sm:px-7 sm:py-5 lg:grid-cols-[1fr_150px] lg:px-8">
            <div className="max-w-2xl">
              <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.22em] text-theme-text-accent">Portal de Gestión MYM</p>
              <h1 className="text-2xl font-semibold tracking-tight text-theme-text sm:text-3xl">
                Bienvenido {profile?.nombre ?? 'Usuario'}
              </h1>
              <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-theme-text-muted/75 sm:text-sm">
                Accede a las herramientas operativas de Distribuidora MYM desde un solo lugar.
              </p>
            </div>
            <div className="flex items-center justify-center lg:justify-self-end">
              <Image src="/logo.png" alt="Mascota MYM" width={132} height={120} priority className="h-24 w-32 rounded-lg object-contain drop-shadow-sm sm:h-28 sm:w-36" />
            </div>
          </div>
        </section>

        {operationalModules.length > 0 ? (
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3 px-1">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-theme-text">Módulos disponibles</h2>
              </div>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {operationalModules.map((mod) => (
                <div key={mod.id} className="w-full sm:w-[calc(50%-0.375rem)] lg:w-[calc(33.333333%-0.5rem)]">
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
      </div>

      <OperationalAgenda today={todayInSantiago()} dispatch={dispatchSummary} dispatchRoute="/dashboard/logistica?tab=catalogos&action=calendario_despacho" />
    </div>
  )
}
