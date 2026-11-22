'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { Building2, CheckCircle2, Info, Loader2, X } from 'lucide-react'
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

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cxp-quick-supplier-title"
      onClick={e => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className="my-auto w-full max-w-lg overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-5 py-5 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 id="cxp-quick-supplier-title" className="text-base font-bold tracking-tight text-theme-text">
                Nuevo proveedor
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-theme-text-muted">
                Registra los datos del proveedor para asociarlo a la factura.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isPending}
            onClick={handleClose}
            aria-label="Cerrar modal"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/30 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-5 px-5 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text">Datos del proveedor</h3>
            <span className="text-[11px] text-theme-text-muted"><span className="text-red-500">*</span> Obligatorio</span>
          </div>
          <div>
            <label htmlFor="qs-rut" className="mb-1.5 block text-xs font-semibold text-theme-text">
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
                'h-10 w-full px-3 font-mono text-sm hover:border-theme-accent/60',
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
            <label htmlFor="qs-business-name" className="mb-1.5 block text-xs font-semibold text-theme-text">
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
              className={cn(erpInputClass, 'h-10 w-full px-3 text-sm hover:border-theme-accent/60')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="qs-email" className="mb-1.5 block text-xs font-semibold text-theme-text">
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
                className={cn(erpInputClass, 'h-10 w-full px-3 text-sm hover:border-theme-accent/60')}
              />
            </div>

            <div>
              <label htmlFor="qs-phone" className="mb-1.5 block text-xs font-semibold text-theme-text">
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
                className={cn(erpInputClass, 'h-10 w-full px-3 text-sm hover:border-theme-accent/60')}
              />
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-theme-border bg-theme-bg/50 px-3.5 py-3 text-xs leading-relaxed text-theme-text-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-theme-accent" />
            <p>Registro interno en PetGroup (Caylo). No crea ni sincroniza registros en Bsale.</p>
          </div>

          {submitError && (
            <div role="alert" className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {submitError}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-theme-border pt-4">
            <button
              type="button"
              disabled={isPending}
              onClick={handleClose}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-theme-border bg-theme-surface px-4 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {isPending ? 'Guardando…' : 'Guardar proveedor'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
