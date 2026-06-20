import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompany } from '@/app/actions/companies'
import { CompanyConfigForm } from './company-config-form'

export default async function ConfigurarEmpresaPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Check role
  const { data: profile } = await supabase
    .from('users')
    .select('role_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) redirect('/login')

  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', profile.role_id)
    .single()

  if (!role || role.name !== 'SUPER_USUARIO') {
    redirect('/dashboard')
  }

  const activeCompany = await getActiveCompany()
  if (!activeCompany) {
    redirect('/dashboard')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-6 rounded-full bg-theme-accent" />
        <div>
          <h1 className="text-xl font-bold text-theme-text">Configurar Datos de la Empresa</h1>
          <p className="text-xs text-theme-text-muted">Edita los datos maestros de la empresa activa para documentos, reportes y PDFs.</p>
        </div>
      </div>
      <CompanyConfigForm company={activeCompany} />
    </div>
  )
}
