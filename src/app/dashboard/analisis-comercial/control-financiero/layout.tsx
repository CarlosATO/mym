import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AccessDenied } from '@/components/access-denied'
import { getActiveCompany } from '@/app/actions/companies'
import { ControlFinancieroShell } from '@/modules/analisis-comercial/control-financiero/components/control-financiero-shell'

export default async function ControlFinancieroLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const admin = createAdminClient()
  const { data: permissions } = await admin.rpc('get_user_permissions', { p_user_id: user.id })
  const permissionCodes: string[] = (permissions ?? []).map((permission: { permission_code: string }) => permission.permission_code)
  if (!permissionCodes.includes('analisis_comercial.control_financiero.view') && !permissionCodes.includes('system.admin')) {
    return <AccessDenied />
  }

  const activeCompany = await getActiveCompany()

  return (
    <ControlFinancieroShell activeCompany={activeCompany}>
      {children}
    </ControlFinancieroShell>
  )
}
