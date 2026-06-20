'use client'

import { useActionState } from 'react'
import { login } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CompanyLogo } from '@/components/company-logo'

export function LoginForm() {
  const [state, action, pending] = useActionState(
    async (_prev: { error: string }, formData: FormData) => login(formData),
    { error: '' }
  )

  return (
    <div className="bg-theme-surface/95 backdrop-blur-xl rounded-3xl shadow-2xl shadow-theme-bg/40 p-8 sm:p-10 space-y-7 border border-theme-border-accent/50">
      <div className="text-center space-y-2">
        <div className="flex justify-center mb-4">
          <CompanyLogo size={80} />
        </div>
        <h1 className="text-xl font-semibold text-theme-text">Bienvenido</h1>
        <p className="text-sm text-theme-text-muted">Ingresa tus credenciales para acceder</p>
      </div>

      <form action={action} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-xs font-medium text-theme-text-muted uppercase tracking-wider">Correo electrónico</label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="admin@mym.cl"
            required
            className="h-11 rounded-xl border-theme-border-accent/50 bg-theme-bg/50 focus:bg-theme-bg text-theme-text transition-colors placeholder:text-theme-text-muted/40"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-theme-text-muted uppercase tracking-wider">Contraseña</label>
          <Input
            id="password"
            name="password"
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
        <Button type="submit" disabled={pending} className="w-full h-11 rounded-xl bg-gradient-to-r from-theme-accent to-theme-accent hover:from-theme-accent hover:to-theme-bg-gradient-mid text-white shadow-lg shadow-theme-accent/25 hover:shadow-theme-accent/40 transition-all duration-200 text-sm font-semibold">
          {pending ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              Ingresando...
            </span>
          ) : 'Ingresar'}
        </Button>
      </form>
    </div>
  )
}
