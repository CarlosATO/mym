import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import { RolesView } from './roles-view'

export default async function RolesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const perms: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  const hasView = perms.includes('roles.view') || perms.includes('system.admin')
  if (!hasView) return <AccessDenied />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-theme-text">Roles</h1>
        <p className="text-sm text-theme-text-muted/70 mt-1">Gestión de roles y permisos del sistema</p>
      </div>
      <RolesView userPermissions={perms} />
    </div>
  )
}
