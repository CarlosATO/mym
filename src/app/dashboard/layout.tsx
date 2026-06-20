import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { DashboardLayoutClient } from '@/components/dashboard-layout-client'
import { getActiveCompany } from '@/app/actions/companies'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) redirect('/login')
  if (profile.must_change_password) redirect('/change-password')

  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', profile.role_id)
    .single()

  const profileWithRole = { ...profile, roles: { name: role?.name ?? '' } }

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const permissionCodes: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  const activeCompany = await getActiveCompany()

  return (
    <DashboardLayoutClient profile={profileWithRole} permissions={permissionCodes} activeCompany={activeCompany}>
      {children}
    </DashboardLayoutClient>
  )
}
