import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AccessDenied } from '@/components/access-denied'
import { ReceiptWorksheet } from '@/modules/logistica/recepciones/receipt-worksheet'
import { hasWmsPermission, requireWmsPermission } from '@/app/actions/logistica/authorization'

interface PageProps {
  params: Promise<{ poId: string }>
}

export default async function Page({ params }: PageProps) {
  const { poId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  try {
    await requireWmsPermission('logistica.receptions.create')
  } catch {
    return <AccessDenied />
  }
  const canViewEconomics = await hasWmsPermission(user.id, 'adquisiciones.po.view')
  const canViewReceiptAmounts = canViewEconomics || await hasWmsPermission(user.id, 'logistica.receptions.amounts.view')

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido, email, role_id')
    .eq('id', user.id)
    .maybeSingle()

  let roleName = ''
  if (profile?.role_id) {
    const { data: role } = await supabase
      .from('roles')
      .select('name')
      .eq('id', profile.role_id)
      .single()
    roleName = role?.name ?? ''
  }

  const profileWithRole = profile
    ? { ...profile, roles: { name: roleName } }
    : { nombre: '', apellido: '', email: '', roles: { name: '' } }

  return <ReceiptWorksheet poId={poId} profile={profileWithRole} canViewEconomics={canViewEconomics} canViewReceiptAmounts={canViewReceiptAmounts} />
}
