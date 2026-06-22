import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ReceiptWorksheet } from '@/modules/logistica/recepciones/receipt-worksheet'

interface PageProps {
  params: Promise<{ poId: string }>
}

export default async function Page({ params }: PageProps) {
  const { poId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

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

  return <ReceiptWorksheet poId={poId} profile={profileWithRole} />
}
