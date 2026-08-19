import { createClient } from '@/lib/supabase/server'
import { CommissionsPanel } from '@/modules/comercial/comisiones/commissions-panel'

export default async function ComercialComisionesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = user
    ? await supabase.from('users').select('roles:role_id(name)').eq('id', user.id).maybeSingle()
    : { data: null }
  const roleName = (profile?.roles as { name?: string } | null)?.name

  return <CommissionsPanel isSuperUser={roleName === 'SUPER_USUARIO'} />
}
