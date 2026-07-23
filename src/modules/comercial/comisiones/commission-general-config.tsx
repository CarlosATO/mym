'use client'

import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { updateCommissionSettings, type CommissionSettings } from '@/app/actions/comercial/commissions'

export function CommissionGeneralConfig({ settings, onSaved, setError }: { settings: CommissionSettings | null; onSaved: () => Promise<void>; setError: (message: string) => void }) {
  const [value, setValue] = useState(settings?.default_commission_percent || 0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  if (!settings) return null
  const save = async () => {
    setSaving(true); setSaved(false)
    const startedAt = Date.now()
    try { await updateCommissionSettings({ default_commission_percent: value }); await onSaved(); const remaining = 500 - (Date.now() - startedAt); if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining)); setSaved(true); window.setTimeout(() => setSaved(false), 2500) }
    catch (error) { setError(error instanceof Error ? error.message : 'No se pudo guardar la configuración.') } finally { setSaving(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void save() }} className="w-full rounded-xl border border-theme-border bg-theme-bg/30 p-4"><h3 className="font-semibold">Comisión general</h3><p className="mt-1 text-sm text-theme-text-muted">Se utiliza cuando no existe una condición más específica.</p><div className="mt-4 grid gap-3 md:grid-cols-4"><label className="text-sm font-medium">Porcentaje<input className="mt-1" type="number" min="0" max="100" step="0.01" value={value} onChange={event => { setValue(Number(event.target.value)); setSaved(false) }} /></label><p className="text-sm"><b>Base:</b> NET<br /><b>Pago completo:</b> Sí</p><p className="text-sm"><b>Cierre histórico:</b> {settings.historical_cutoff_date}<br /><b>Primer día elegible:</b> {settings.first_eligible_date}</p><button disabled={saving} className="btn-primary self-end">{saving ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Guardando...</> : 'Guardar comisión general'}</button></div>{saved && <p className="mt-3 inline-flex items-center gap-2 rounded-lg bg-theme-accent-muted px-3 py-2 text-sm font-medium text-theme-text"><Check className="h-4 w-4" />Configuración guardada correctamente.</p>}</form>
}
