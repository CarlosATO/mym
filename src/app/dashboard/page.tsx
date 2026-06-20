import { createClient } from '@/lib/supabase/server'
import { ModuleCard } from '@/components/module-card'
import type { Modulo } from '@/lib/types'

const adminCodes = ['dashboard', 'usuarios', 'roles', 'auditoria', 'seguridad']

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('users')
    .select('nombre, apellido')
    .eq('id', user.id)
    .maybeSingle()

  const { data: modules } = await supabase.rpc('get_visible_modules', { p_user_id: user.id })

  const allModules: Modulo[] = modules ?? []
  const operationalModules = allModules.filter(m => !adminCodes.includes(m.code))

  return (
    <div className="space-y-10">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-bold text-theme-text">
          Bienvenido {profile?.nombre ?? 'Usuario'}
        </h1>
        <p className="text-sm text-theme-text-muted/70">
          Portal Operacional Distribuidora MYM
        </p>
      </div>

      {operationalModules.length > 0 ? (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-1 h-5 rounded-full bg-theme-accent-hover" />
            <h2 className="text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Módulos Disponibles</h2>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {operationalModules.map((mod) => (
              <ModuleCard key={mod.id} module={mod} />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-1 h-5 rounded-full bg-theme-accent-hover" />
            <h2 className="text-sm font-semibold text-theme-text-muted uppercase tracking-wider">Módulos Disponibles</h2>
          </div>
          <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
            <p className="text-theme-text-muted/50 text-sm">No hay módulos operativos disponibles para tu usuario.</p>
          </div>
        </div>
      )}
    </div>
  )
}
