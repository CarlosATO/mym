import { createClient } from '@/lib/supabase/server'

export async function requirePortalSystemAdmin() {
  const supabase = await createClient()
  const { data: allowed, error } = await supabase.rpc('has_permission', {
    p_permission_code: 'system.admin',
  })

  if (error || allowed !== true) {
    throw new Error('No tienes autorización para consultar los indicadores del Portal.')
  }
}
