'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Building2, CheckCircle2, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createQuickServiceSupplier } from '@/app/actions/cuentas-por-pagar'
import { erpErrorInputClass, erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import {
  formatChileanRut,
  isValidChileanRut,
  validateQuickSupplierDraft,
} from './service-rules'
import type { ServiceSupplierOption } from './types'

interface QuickSupplierModalProps {
  open: boolean
  onClose: () => void
  onCreated: (supplier: ServiceSupplierOption) => void
}

export function QuickSupplierModal({ open, onClose, onCreated }: QuickSupplierModalProps) {
  const [rut, setRut] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isPending) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, isPending, onClose])

  const errors = useMemo(
    () => validateQuickSupplierDraft({ rut, businessName, contactEmail, contactPhone }),
    [rut, businessName, contactEmail, contactPhone],
  )

  if (!open) return null

  const showRutError = rut.trim().length > 0 && !isValidChileanRut(rut)
  const canSave = !isPending && errors.length === 0

  function handleClose() {
    if (isPending) return
    setSubmitError(null)
    onClose()
  }

  function handleSave(event: React.FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    setSubmitError(null)
    if (!canSave) {
      setSubmitError(errors[0] || 'Revise los datos obligatorios del proveedor.')
      return
    }

    startTransition(async () => {
      const result = await createQuickServiceSupplier({
        rut,
        businessName,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
      })

      if (!result.ok) {
        setSubmitError(result.error)
        return
      }

      toast.success(`Proveedor ${result.data.business_name} creado y seleccionado.`)
      setRut('')
      setBusinessName('')
      setContactEmail('')
      setContactPhone('')
      setSubmitError(null)
      onCreated(result.data)
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cxp-quick-supplier-title"
      onClick={e => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="h-4 w-4 shrink-0 text-theme-accent" />
            <h2 id="cxp-quick-supplier-title" className="text-sm font-bold text-theme-text truncate">
              Nuevo proveedor
            </h2>
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={handleClose}
            aria-label="Cerrar modal"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-theme-text-muted hover:bg-theme-surface-hover hover:text-theme-text disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-3 p-4">
          <div>
            <label htmlFor="qs-rut" className="mb-1 block text-xs font-semibold text-theme-text">
              RUT <span className="text-red-500">*</span>
            </label>
            <input
              id="qs-rut"
              type="text"
              autoFocus
              disabled={isPending}
              value={rut}
              onChange={e => {
                setRut(e.target.value)
                setSubmitError(null)
              }}
              onBlur={() => {
                if (isValidChileanRut(rut)) setRut(formatChileanRut(rut))
              }}
              placeholder="Ej: 76.123.456-7"
              className={cn(
                erpInputClass,
                'h-8.5 w-full px-2.5 font-mono text-xs',
                showRutError && erpErrorInputClass,
              )}
            />
            {showRutError && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                RUT inválido. Verifique formato y dígito verificador.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="qs-business-name" className="mb-1 block text-xs font-semibold text-theme-text">
              Razón social <span className="text-red-500">*</span>
            </label>
            <input
              id="qs-business-name"
              type="text"
              maxLength={200}
              disabled={isPending}
              value={businessName}
              onChange={e => {
                setBusinessName(e.target.value)
                setSubmitError(null)
              }}
              placeholder="Ej: Servicios Logísticos SpA"
              className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs')}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="qs-email" className="mb-1 block text-xs font-medium text-theme-text">
                Correo <span className="text-theme-text-muted font-normal">(opcional)</span>
              </label>
              <input
                id="qs-email"
                type="email"
                maxLength={150}
                disabled={isPending}
                value={contactEmail}
                onChange={e => {
                  setContactEmail(e.target.value)
                  setSubmitError(null)
                }}
                placeholder="contacto@proveedor.cl"
                className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs')}
              />
            </div>

            <div>
              <label htmlFor="qs-phone" className="mb-1 block text-xs font-medium text-theme-text">
                Teléfono <span className="text-theme-text-muted font-normal">(opcional)</span>
              </label>
              <input
                id="qs-phone"
                type="tel"
                maxLength={50}
                disabled={isPending}
                value={contactPhone}
                onChange={e => {
                  setContactPhone(e.target.value)
                  setSubmitError(null)
                }}
                placeholder="+56 9 1234 5678"
                className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs')}
              />
            </div>
          </div>

          <p className="rounded-lg border border-theme-border bg-theme-bg/50 px-2.5 py-2 text-[11px] text-theme-text-muted">
            Registro interno en PetGroup (Caylo). No crea ni sincroniza registros en Bsale.
          </p>

          {submitError && (
            <div role="alert" className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {submitError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-theme-border pt-3">
            <button
              type="button"
              disabled={isPending}
              onClick={handleClose}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-3.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {isPending ? 'Guardando…' : 'Guardar proveedor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
