'use client'

import { useState, useTransition } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Save } from 'lucide-react'
import { changeOwnPassword } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword'

const initialValues = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
}

const initialVisibility = {
  currentPassword: false,
  newPassword: false,
  confirmPassword: false,
}

const fieldLabels: Record<PasswordField, string> = {
  currentPassword: 'Contraseña actual',
  newPassword: 'Nueva contraseña',
  confirmPassword: 'Confirmar nueva contraseña',
}

export function ProfileSecurity() {
  const [values, setValues] = useState(initialValues)
  const [visibility, setVisibility] = useState(initialVisibility)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  function updateValue(field: PasswordField, value: string) {
    setValues(current => ({ ...current, [field]: value }))
    setMessage(null)
  }

  function toggleVisibility(field: PasswordField) {
    setVisibility(current => ({ ...current, [field]: !current[field] }))
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)

    if (!values.currentPassword || !values.newPassword || !values.confirmPassword) {
      setMessage({ type: 'error', text: 'Completa todos los campos de contraseña.' })
      return
    }
    if (values.newPassword.length < 6) {
      setMessage({ type: 'error', text: 'La nueva contraseña debe tener al menos 6 caracteres.' })
      return
    }
    if (values.newPassword !== values.confirmPassword) {
      setMessage({ type: 'error', text: 'Las contraseñas nuevas no coinciden.' })
      return
    }
    if (values.newPassword === values.currentPassword) {
      setMessage({ type: 'error', text: 'La nueva contraseña debe ser diferente a la actual.' })
      return
    }

    const formData = new FormData()
    formData.set('currentPassword', values.currentPassword)
    formData.set('newPassword', values.newPassword)
    formData.set('confirmPassword', values.confirmPassword)

    startTransition(async () => {
      try {
        const result = await changeOwnPassword(formData)
        if (result.error) {
          setMessage({ type: 'error', text: result.error })
          return
        }

        setValues(initialValues)
        setVisibility(initialVisibility)
        setMessage({ type: 'success', text: 'Contraseña cambiada correctamente.' })
      } catch {
        setMessage({ type: 'error', text: 'Ocurrió un error inesperado. Inténtalo nuevamente.' })
      }
    })
  }

  return (
    <section id="seguridad" className="scroll-mt-4 rounded-2xl border border-theme-border bg-theme-surface/60 p-4 shadow-xl shadow-black/10 sm:p-5">
      <div className="mb-3.5 flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
          <KeyRound className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-theme-text">Seguridad</h2>
          <p className="text-xs text-theme-text-muted/60">Administra la contraseña de tu cuenta</p>
        </div>
      </div>

      <form className="max-w-xl space-y-3" onSubmit={handleSubmit}>
        {(Object.keys(fieldLabels) as PasswordField[]).map(field => (
          <label key={field} className="block space-y-1 text-xs font-semibold text-theme-text-muted">
            <span>{fieldLabels[field]}</span>
            <div className="relative">
              <Input
                required
                type={visibility[field] ? 'text' : 'password'}
                autoComplete={field === 'currentPassword' ? 'current-password' : 'new-password'}
                value={values[field]}
                onChange={event => updateValue(field, event.target.value)}
                disabled={pending}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-theme-text-muted/70 hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/50"
                onClick={() => toggleVisibility(field)}
                aria-label={`${visibility[field] ? 'Ocultar' : 'Mostrar'} ${fieldLabels[field].toLowerCase()}`}
                disabled={pending}
              >
                {visibility[field] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>
        ))}

        <p className="text-xs text-theme-text-muted/60">La nueva contraseña debe tener al menos 6 caracteres.</p>

        {message && (
          <p role={message.type === 'error' ? 'alert' : 'status'} className={`flex items-center gap-1.5 text-xs font-medium ${message.type === 'error' ? 'text-red-400' : 'text-emerald-500'}`}>
            {message.type === 'error' ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {message.text}
          </p>
        )}

        <Button type="submit" size="sm" disabled={pending}>
          <Save />
          {pending ? 'Cambiando...' : 'Cambiar contraseña'}
        </Button>
      </form>
    </section>
  )
}
