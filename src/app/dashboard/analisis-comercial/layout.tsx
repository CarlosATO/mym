import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import { AnalisisComercialLayoutClient } from './analisis-comercial-layout-client'

export default async function Layout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const permissionCodes: string[] = (permissions ?? []).map((permission: { permission_code: string }) => permission.permission_code)
  if (!permissionCodes.includes('module.analisis-comercial.view') && !permissionCodes.includes('system.admin')) {
    return <AccessDenied />
  }

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido, email, role_id, roles:role_id(name)')
    .eq('id', user.id)
    .maybeSingle()

  const profileWithRole = profile
    ? { ...profile, roles: { name: (profile.roles as { name?: string } | null)?.name ?? '' } }
    : { nombre: '', apellido: '', email: '', roles: { name: '' } }

  return <AnalisisComercialLayoutClient profile={profileWithRole} permissions={permissionCodes}>{children}</AnalisisComercialLayoutClient>
}
