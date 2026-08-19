import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SuppliersPanel } from '@/modules/adquisiciones/proveedores/suppliers-panel'

export default async function ProveedoresPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = createAdminClient()
  const { data: permissions } = user ? await admin.rpc('get_user_permissions', { p_user_id: user.id }) : { data: [] }
  const permissionCodes = (permissions ?? []).map((permission: { permission_code: string }) => permission.permission_code)
  const canManageBsale = permissionCodes.includes('system.admin') || permissionCodes.includes('adquisiciones.suppliers.update')
  return <SuppliersPanel canManageBsale={canManageBsale} />
}
