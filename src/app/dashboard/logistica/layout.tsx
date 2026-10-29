import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import { LogisticaLayoutClient } from './logistica-layout-client'
import { getEffectiveRoleForActiveCompany } from '@/app/actions/logistica/authorization'

export default async function Layout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: hasLogisticaAccess, error: permissionError } = await supabase.rpc('has_permission', {
    p_permission_code: 'module.logistica.view',
  })
  if (permissionError || hasLogisticaAccess !== true) {
    return <AccessDenied />
  }

  const { data: permissions } = await createAdminClient().rpc('get_user_permissions', { p_user_id: user.id })
  const permissionCodes: string[] = (permissions ?? []).map((permission: { permission_code: string }) => permission.permission_code)
  const effectiveRole = await getEffectiveRoleForActiveCompany()
  const canAccessPreparation = permissionCodes.includes('logistica.preparation.manage')
    || (hasLogisticaAccess === true && effectiveRole === 'OPERADOR_BODEGA')

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido, email, role_id, roles:role_id(name)')
    .eq('id', user.id)
    .maybeSingle()

  const profileWithRole = profile
    ? { ...profile, id: user.id, roles: { name: (profile.roles as { name?: string } | null)?.name ?? '' } }
    : { id: user.id, nombre: '', apellido: '', email: '', roles: { name: '' } }

  return (
    <LogisticaLayoutClient profile={profileWithRole} permissions={permissionCodes} canAccessPreparation={canAccessPreparation}>
      {children}
    </LogisticaLayoutClient>
  )
}
