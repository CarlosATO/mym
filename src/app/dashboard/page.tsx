import { createClient } from '@/lib/supabase/server'
import type { Modulo } from '@/lib/types'
import { getPortalLatestRouteGuides } from '@/app/actions/logistica/guias-ruta'
import { getPortalSales, type PortalSales } from '@/app/actions/portal/sales'
import { getPortalCollectionsByMode } from '@/app/actions/portal/collections'
import { getPortalAmimascota } from '@/app/actions/portal/amimascota'
import { getPortalTopProducts } from '@/app/actions/portal/top-products'
import type { PortalPeriodMode } from '@/app/actions/portal/periods'
import { PortalHomeClient } from '@/components/portal/portal-home-client'

const adminCodes = ['dashboard', 'usuarios', 'roles', 'auditoria', 'seguridad']

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido, email, role_id')
    .eq('id', user.id)
    .maybeSingle()

  const { data: role } = profile?.role_id
    ? await supabase
        .from('roles')
        .select('name')
        .eq('id', profile.role_id)
        .maybeSingle()
    : { data: null }

  const { data: modules } = await supabase.rpc('get_visible_modules', {
    p_user_id: user.id,
  })
  const { data: isSystemAdmin } = await supabase.rpc('has_permission', {
    p_permission_code: 'system.admin',
  })

  const allModules: Modulo[] = modules ?? []
  const operationalModules = allModules.filter(
    (m) => !adminCodes.includes(m.code)
  )

  operationalModules.sort((a, b) => {
    const aHasRoute = typeof a.route === 'string' && a.route.trim().length > 0
    const bHasRoute = typeof b.route === 'string' && b.route.trim().length > 0
    return Number(bHasRoute) - Number(aHasRoute)
  })

  const kpiResults =
    isSystemAdmin === true
      ? await Promise.allSettled([
          getPortalLatestRouteGuides(),
          getPortalSales('CALENDAR_MONTH'),
          getPortalSales('COMMISSIONABLE'),
          getPortalCollectionsByMode(),
          getPortalAmimascota(),
          getPortalTopProducts(),
        ])
      : null

  const guidesResult = kpiResults?.[0]
  const salesCalendarResult = kpiResults?.[1]
  const salesCommissionableResult = kpiResults?.[2]
  const collectionsResult = kpiResults?.[3]
  const amimascotaResult = kpiResults?.[4]
  const topProductsResult = kpiResults?.[5]

  const latestRouteGuides =
    guidesResult?.status === 'fulfilled' ? guidesResult.value : []
  const sales: Record<PortalPeriodMode, PortalSales | null> = {
    CALENDAR_MONTH:
      salesCalendarResult?.status === 'fulfilled'
        ? salesCalendarResult.value
        : null,
    COMMISSIONABLE:
      salesCommissionableResult?.status === 'fulfilled'
        ? salesCommissionableResult.value
        : null,
  }
  const amimascota =
    amimascotaResult?.status === 'fulfilled' ? amimascotaResult.value : null
  const topProducts =
    topProductsResult?.status === 'fulfilled' ? topProductsResult.value : []

  const fullName =
    `${profile?.nombre ?? ''} ${profile?.apellido ?? ''}`.trim() || 'Usuario'

  return (
    <PortalHomeClient
      userId={user.id}
      fullName={fullName}
      email={profile?.email ?? user.email ?? ''}
      roleName={role?.name ?? ''}
      operationalModules={operationalModules}
      isSystemAdmin={isSystemAdmin === true}
      executiveData={
        isSystemAdmin === true
          ? {
              latestRouteGuides,
              sales,
              collections:
                collectionsResult?.status === 'fulfilled'
                  ? collectionsResult.value
                  : { CALENDAR_MONTH: null, COMMISSIONABLE: null },
              salesError:
                salesCalendarResult?.status === 'rejected' ||
                salesCommissionableResult?.status === 'rejected',
              collectionsError: collectionsResult?.status === 'rejected',
              amimascota,
              amimascotaError: amimascotaResult?.status === 'rejected',
              topProducts,
              topProductsError: topProductsResult?.status === 'rejected',
            }
          : null
      }
    />
  )
}
