import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import { UsersManagement } from './users-management'

export default async function UsuariosPage() {
  const supabase = await createClient()

  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const perms: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  const hasView = perms.includes('usuarios.view') || perms.includes('system.admin')
  if (!hasView) return <AccessDenied />

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('*, roles!role_id(name, description)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (usersError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-theme-text">Usuarios</h1>
          <p className="text-sm text-theme-text-muted/70">Gestión de usuarios del sistema</p>
        </div>
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center">
          <p className="text-red-500 text-sm">Error al cargar usuarios: {usersError.message}</p>
        </div>
      </div>
    )
  }

  const { data: roles } = await supabase
    .from('roles')
    .select('*')
    .eq('is_active', true)
    .order('name')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-theme-text">Usuarios</h1>
        <p className="text-sm text-theme-text-muted/70">Gestión de usuarios del sistema</p>
      </div>
      <UsersManagement users={users ?? []} roles={roles ?? []} />
    </div>
  )
}
