'use client'

import { useActionState } from 'react'
import { changePassword } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PawLogo } from '@/components/paw-logo'

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(
    async (_prev: { error: string }, formData: FormData) => changePassword(formData),
    { error: '' }
  )

  return (
    <div className="w-full max-w-md mx-auto bg-theme-surface/95 backdrop-blur-xl rounded-3xl shadow-2xl shadow-theme-bg/40 p-8 sm:p-10 space-y-7 border border-theme-border-accent/50">
      <div className="text-center space-y-2">
        <div className="flex justify-center mb-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center shadow-lg shadow-amber-600/30">
            <PawLogo className="w-8 h-8 text-white" />
          </div>
        </div>
        <h1 className="text-xl font-semibold text-theme-text">Cambio de Contraseña</h1>
        <p className="text-sm text-theme-text-muted">Debes cambiar tu contraseña para continuar</p>
      </div>

      <form action={action} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-theme-text-muted uppercase tracking-wider">Nueva contraseña</label>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder="••••••••"
            required
            className="h-11 rounded-xl border-theme-border-accent/50 bg-theme-bg/50 focus:bg-theme-bg text-theme-text transition-colors placeholder:text-theme-text-muted/40"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="confirmPassword" className="text-xs font-medium text-theme-text-muted uppercase tracking-wider">Confirmar contraseña</label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            placeholder="••••••••"
            required
            className="h-11 rounded-xl border-theme-border-accent/50 bg-theme-bg/50 focus:bg-theme-bg text-theme-text transition-colors placeholder:text-theme-text-muted/40"
          />
        </div>
        {state?.error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            <p className="text-sm text-red-500 text-center font-medium">{state.error}</p>
          </div>
        )}
        <Button type="submit" disabled={pending} className="w-full h-11 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white shadow-lg shadow-amber-600/25 hover:shadow-amber-600/40 transition-all duration-200 text-sm font-semibold">
          {pending ? 'Cambiando...' : 'Cambiar contraseña'}
        </Button>
      </form>
    </div>
  )
}
