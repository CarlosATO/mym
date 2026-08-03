import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { InventoryModuleShell } from '@/modules/inventarios/components/inventory-module-shell'

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

  const profileWithRole = { ...profile, roles: { name: role?.name ?? '' } }

  return (
    <InventoryModuleShell profile={profileWithRole} permissions={[]}>
      {children}
    </InventoryModuleShell>
  )
}
