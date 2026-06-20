'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
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
