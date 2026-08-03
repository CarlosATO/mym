import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { InventoryModuleShell } from '@/modules/inventarios/components/inventory-module-shell'

const MODULE_VIEW_PERMISSION = 'module.inventarios.view'

export default async function InventariosLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) redirect('/login')

  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', profile.role_id)
    .single()

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const permissionCodes: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  if (!permissionCodes.includes(MODULE_VIEW_PERMISSION)) {
    redirect('/dashboard')
  }

  const profileWithRole = { ...profile, roles: { name: role?.name ?? '' } }

  return (
    <InventoryModuleShell profile={profileWithRole} permissions={permissionCodes}>
      {children}
    </InventoryModuleShell>
  )
}
