import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AdquisicionesLayoutClient } from './adquisiciones-layout-client'

export default async function Layout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido, email, role_id, roles:role_id(name)')
    .eq('id', user.id)
    .maybeSingle()

  const profileWithRole = profile
    ? { ...profile, roles: { name: (profile.roles as { name?: string } | null)?.name ?? '' } }
    : { nombre: '', apellido: '', email: '', roles: { name: '' } }

  return (
    <AdquisicionesLayoutClient profile={profileWithRole}>
      {children}
    </AdquisicionesLayoutClient>
  )
}
