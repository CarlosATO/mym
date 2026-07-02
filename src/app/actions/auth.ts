'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export async function login(formData: FormData) {
  const supabase = await createClient()

  const email = formData.get('email') as string
  const password = formData.get('password') as string

  const { error, data } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    const admin = createAdminClient()
    await admin.rpc('log_security_event', {
      p_event_type: 'LOGIN_FAILED',
      p_success: false,
      p_email: email,
    })
    return { error: 'Credenciales inválidas' }
  }

  const admin = createAdminClient()
  await admin.rpc('log_security_event', {
    p_event_type: 'LOGIN_SUCCESS',
    p_success: true,
    p_user_id: data.user.id,
    p_email: email,
  })

  const { data: profile } = await supabase
    .from('users')
    .select('must_change_password')
    .eq('id', data.user.id)
    .maybeSingle()

  if (profile?.must_change_password) {
    redirect('/change-password')
  }

  // Check user's company access
  const coreAdmin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'core' }, auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: companies } = await coreAdmin
    .from('user_company_access')
    .select('company_id, is_default')
    .eq('user_id', data.user.id)
    .eq('is_active', true)

  if (!companies || companies.length === 0) {
    redirect('/sin-empresa')
  }

  if (companies.length === 1) {
    // Auto-set active company cookie
    const cookieStore = await cookies()
    cookieStore.set('active_company_id', companies[0].company_id, {
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })
  }

  // If 2+ companies, no cookie set yet — dashboard layout will show CompanySwitcher

  redirect('/dashboard')
}

export async function changePassword(formData: FormData) {
  const supabase = await createClient()

  const password = formData.get('password') as string
  const confirmPassword = formData.get('confirmPassword') as string

  if (password !== confirmPassword) {
    return { error: 'Las contraseñas no coinciden' }
  }

  if (password.length < 6) {
    return { error: 'La contraseña debe tener al menos 6 caracteres' }
  }

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Sesión no encontrada' }

  const { error } = await supabase.auth.updateUser({ password })

  if (error) return { error: error.message }

  const admin = createAdminClient()
  await admin.rpc('log_security_event', {
    p_event_type: 'PASSWORD_CHANGE_FORCED',
    p_success: true,
    p_user_id: user.id,
  })

  await supabase
    .from('users')
    .update({ must_change_password: false })
    .eq('id', user.id)

  redirect('/dashboard')
}

export async function logout() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    const admin = createAdminClient()
    await admin.rpc('log_security_event', {
      p_event_type: 'LOGOUT',
      p_success: true,
      p_user_id: user.id,
    })
  }

  await supabase.auth.signOut()
  redirect('/login')
}
