'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Loader2, Save } from 'lucide-react'
import type { WizardCatalogs, WizardData } from '@/modules/inventarios/lib/wizard'
import {
  EMPTY_WIZARD_DATA,
  loadWizardDraft,
  saveWizardDraft,
  clearWizardDraft,
  ensureDraftIdempotencyKey,
} from '@/modules/inventarios/lib/wizard'
import {
  createInventoryDraftSession,
  setInventoryProductScope,
} from '@/app/actions/inventarios/sessions'
import { InventoryWizardStepper, type WizardStep } from '@/modules/inventarios/components/inventory-wizard-stepper'
import { InventoryGeneralStep } from '@/modules/inventarios/components/inventory-general-step'
import { InventoryScopeStep } from '@/modules/inventarios/components/inventory-scope-step'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

const STEPS: WizardStep[] = [
  { id: 1, label: 'Datos generales' },
  { id: 2, label: 'Alcance' },
  { id: 3, label: 'Participantes' },
  { id: 4, label: 'Zonas y ubicaciones' },
  { id: 5, label: 'Tareas y asignaciones' },
  { id: 6, label: 'Revisión y preparación' },
]

interface InventorySessionWizardProps {
  companyId: string
  catalogs: WizardCatalogs
}

export function InventorySessionWizard({ companyId, catalogs }: InventorySessionWizardProps) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [data, setData] = useState<WizardData>(() => loadWizardDraft() ?? EMPTY_WIZARD_DATA)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const markDirty = useCallback((next: WizardData) => {
    setData(next)
    setDirty(true)
    saveWizardDraft(next)
  }, [])

  const generalValid = data.general.name.trim().length > 0
    && data.general.inventory_type !== ''
    && data.general.warehouse_id !== ''
    && data.general.bsale_office_id !== ''
    && data.general.responsible_user_id !== ''

  const scopeValid = data.general.scope_mode === 'GENERAL' || data.scope.variant_ids.length > 0

  const canContinue = step === 1 ? generalValid : step === 2 ? scopeValid : true

  const performCreate = useCallback(async () => {
    setSaving(true)
    setError(null)
    const key = ensureDraftIdempotencyKey(companyId, data.sessionId)
    const general = data.general

    const created = await createInventoryDraftSession(companyId, {
      name: general.name,
      inventory_type: general.inventory_type,
      warehouse_id: general.warehouse_id,
      bsale_office_id: Number(general.bsale_office_id),
      scope_mode: general.scope_mode,
      responsible_user_id: general.responsible_user_id,
      notes: undefined,
      idempotency_key: key,
    })

    if (created.error || !created.data) {
      setSaving(false)
      setError(created.error ?? 'No se pudo crear la sección de conteo.')
      return
    }

    const sessionId = created.data.session_id
    const withSession = { ...data, sessionId }
    saveWizardDraft(withSession)

    if (general.scope_mode === 'PARTIAL') {
      const scope = await setInventoryProductScope(companyId, sessionId, data.scope.variant_ids, key)
      if (scope.error) {
        setSaving(false)
        setError(`${scope.error} La sección de conteo fue creada en borrador; podrás reintentar guardar el alcance.`)
        return
      }
    }

    setSaving(false)
    clearWizardDraft()
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion&step=3`)
  }, [companyId, data, router])

  const handleContinue = useCallback(() => {
    if (step === 2) {
      void performCreate()
      return
    }
    setStep(prev => Math.min(prev + 1, 6))
  }, [step, performCreate])

  const handleExit = useCallback(() => {
    if (dirty && !window.confirm('Tienes cambios sin guardar. ¿Deseas salir del asistente?')) return
    router.push('/dashboard/inventarios/jornadas')
  }, [dirty, router])

  const hasPendingStep = (stepId: number) => stepId > 2

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-theme-text">Nueva sección de conteo</h1>
        <button
          type="button"
          onClick={handleExit}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Salir
        </button>
      </div>

      <InventoryWizardStepper steps={STEPS} current={step} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        {/* Tarjeta principal */}
        <div className="rounded-xl border border-theme-border bg-theme-surface p-5 shadow-sm">
          <h2 className="mb-4 text-base font-semibold text-theme-text">{STEPS[step - 1].label}</h2>

          {step === 1 && (
            <InventoryGeneralStep data={data.general} catalogs={catalogs} onChange={next => markDirty({ ...data, general: next })} />
          )}
          {step === 2 && (
            <InventoryScopeStep companyId={companyId} scopeMode={data.general.scope_mode} data={data.scope} onChange={scope => markDirty({ ...data, scope })} />
          )}
          {hasPendingStep(step) && (
            <InventoryLoadingState label="Este paso estará disponible en una próxima fase." />
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between border-t border-theme-border/60 pt-4">
            <button
              type="button"
              onClick={() => setStep(prev => Math.max(prev - 1, 1))}
              disabled={step === 1}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 disabled:opacity-40"
            >
              <ArrowLeft className="h-4 w-4" />
              Anterior
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => markDirty({ ...data })}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5"
              >
                <Save className="h-4 w-4" />
                Guardar borrador
              </button>
              {step <= 2 && (
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={!canContinue || saving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : step === 2 ? 'Crear sección de conteo' : 'Continuar'}
                  {!saving && <ArrowRight className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Resumen lateral */}
        <aside className="h-fit rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-theme-text">Resumen</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-theme-text-muted">Nombre</dt>
              <dd className="truncate font-medium text-theme-text">{data.general.name || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-theme-text-muted">Tipo</dt>
              <dd className="font-medium text-theme-text">{data.general.inventory_type || '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-theme-text-muted">Alcance</dt>
              <dd className="font-medium text-theme-text">{data.general.scope_mode === 'PARTIAL' ? 'Parcial' : 'General'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-theme-text-muted">Productos</dt>
              <dd className="font-medium text-theme-text">
                {data.general.scope_mode === 'GENERAL' ? 'Todos' : String(data.scope.variant_ids.length)}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  )
}
