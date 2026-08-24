import { createClient } from '@/lib/supabase/server'
import { ComisionesV2Inspection } from '@/modules/comercial/comisiones-v2/comisiones-v2-inspection'

export default async function ComercialComisionesV2Page() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const { data: profile } = user
    ? await supabase.from('users').select('roles:role_id(name)').eq('id', user.id).maybeSingle()
    : { data: null }
  const roleName = (profile?.roles as { name?: string } | null)?.name

  return <ComisionesV2Inspection isSuperUser={roleName === 'SUPER_USUARIO'} />
}
