import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { RouteSettlementsPanel } from '@/modules/adquisiciones/rendicion-rutas/route-settlements-panel'

export default async function RendicionRutasPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = createAdminClient()
  const { data: permissions } = user
    ? await admin.rpc('get_user_permissions', { p_user_id: user.id })
    : { data: null }
  const permissionCodes = (permissions ?? []).map((permission: { permission_code: string }) => permission.permission_code)

  return (
    <RouteSettlementsPanel
      canCreateSettlement={permissionCodes.includes('adquisiciones.route_settlements.create')}
    />
  )
}
