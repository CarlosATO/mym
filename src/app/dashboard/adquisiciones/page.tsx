import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import AdquisicionesShell from '@/modules/adquisiciones/components/adquisiciones-shell'

export default async function AdquisicionesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const perms: string[] = (permissions ?? []).map((p: { permission_code: string }) => p.permission_code)

  const hasView = perms.includes('module.adquisiciones.view') || perms.includes('system.admin')
  if (!hasView) return <AccessDenied />

  return <AdquisicionesShell />
}
