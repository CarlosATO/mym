import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { CompanyLogo } from '@/components/company-logo'
import { logout } from '@/app/actions/auth'
import { AlertTriangle, LogOut } from 'lucide-react'

export default async function SinEmpresaPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Double-check: maybe user now has companies
  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data: companies } = await coreAdmin
    .from('user_company_access')
    .select('id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1)

  if (companies && companies.length > 0) {
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen flex relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end" />
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)`,
        backgroundSize: '60px 60px',
      }} />
      <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-theme-accent-hover/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-theme-accent-hover/10 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4" />

      <div className="flex-1 flex items-center justify-center relative p-8">
        <div className="w-full max-w-md text-center space-y-8">
          <div className="flex justify-center">
            <div className="relative">
              <div className="absolute inset-0 scale-[1.4] rounded-full bg-amber-400/10 blur-2xl" />
              <CompanyLogo size={120} />
            </div>
          </div>

          <div className="space-y-4">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/20 flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-amber-400" />
            </div>
            <h1 className="text-2xl font-bold text-theme-text">Usuario sin empresa asignada</h1>
            <p className="text-theme-text-muted/80 leading-relaxed max-w-sm mx-auto">
              Tu usuario no tiene acceso a ninguna empresa en el sistema.
              Contacta al administrador para que te asigne una empresa.
            </p>
          </div>

          <form action={logout}>
            <button
              type="submit"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-theme-text transition-all text-sm font-semibold"
            >
              <LogOut className="w-4 h-4" />
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
