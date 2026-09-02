import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { createInventariosClient } from '@/lib/supabase/inventarios'
import { getActiveCompany } from '@/app/actions/companies'
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

  const cookieStore = await cookies()
  const companyId = cookieStore.get('active_company_id')?.value
  if (!companyId) redirect('/dashboard')

  const db = await createInventariosClient()
  const { data: permissions } = await db.rpc('get_company_permissions', {
    p_user_id: user.id,
    p_company_id: companyId,
  })
  const permissionCodes: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  if (!permissionCodes.includes(MODULE_VIEW_PERMISSION)) {
    redirect('/dashboard')
  }

  const profileWithRole = { ...profile, roles: { name: role?.name ?? '' } }
  const activeCompany = await getActiveCompany()

  return (
    <InventoryModuleShell activeCompany={activeCompany} profile={profileWithRole} permissions={permissionCodes}>
      {children}
    </InventoryModuleShell>
  )
}
