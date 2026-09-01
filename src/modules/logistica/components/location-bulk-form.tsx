'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Info, Loader2, Settings2, Sparkles, X } from 'lucide-react'
import { createLocationsBulk, previewLocationsBulk } from '@/app/actions/logistica/locations'

interface LocationBulkFormProps {
  warehouseId: string
  warehouseName?: string
  warehouseActive?: boolean
  onClose: () => void
  onSuccess: (created?: number) => void
}

type Structure = 'complete' | 'rack' | 'positions' | 'custom'
type Dimension = 'racks' | 'levels' | 'positions'

interface BulkState {
  aisle: string
  rackFrom: string
  rackTo: string
  levelFrom: string
  levelTo: string
  positionFrom: string
  positionTo: string
  prefix: string
  codeFormat: string
}

interface BulkPreview {
  success?: boolean
  error?: string
  requested_count?: number
  valid_count?: number
  existing_count?: number
  duplicate_count?: number
  error_count?: number
  limit_exceeded?: boolean
  codes?: string[]
  conflicts?: { code?: string; reason?: string }[]
}

const formats: Record<Exclude<Structure, 'custom'>, string> = {
  complete: '{prefix}P{aisle}-R{rack}-N{level}-U{position}',
  rack: '{prefix}P{aisle}-R{rack}',
  positions: '{prefix}P{aisle}-U{position}',
}

const structureOptions: { id: Structure; title: string; description: string }[] = [
  { id: 'complete', title: 'Estructura completa', description: 'Pasillo + Rack + Nivel + Posición' },
  { id: 'rack', title: 'Pasillo y Rack', description: 'Pasillo + Rack' },
  { id: 'positions', title: 'Pasillo y Posiciones', description: 'Pasillo + Posición' },
  { id: 'custom', title: 'Personalizada', description: 'Activa solo lo que existe en esta zona' },
]

const emptyPreview: BulkPreview = { requested_count: 0, valid_count: 0, existing_count: 0, duplicate_count: 0, error_count: 0, codes: [], conflicts: [] }
const normalizeAisle = (value: string) => value.trim().toUpperCase()

export function LocationBulkForm({ warehouseId, warehouseName, warehouseActive = true, onClose, onSuccess }: LocationBulkFormProps) {
  const [structure, setStructure] = useState<Structure>('complete')
  const [dimensions, setDimensions] = useState<Record<Dimension, boolean>>({ racks: true, levels: true, positions: true })
  const [form, setForm] = useState<BulkState>({ aisle: 'A', rackFrom: '01', rackTo: '05', levelFrom: '01', levelTo: '04', positionFrom: '01', positionTo: '02', prefix: '', codeFormat: formats.complete })
  const [preview, setPreview] = useState<BulkPreview>(emptyPreview)
  const [previewing, setPreviewing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const enabled = useMemo(() => structure === 'complete' ? { racks: true, levels: true, positions: true } : structure === 'rack' ? { racks: true, levels: false, positions: false } : structure === 'positions' ? { racks: false, levels: false, positions: true } : dimensions, [structure, dimensions])
  const request = useMemo(() => ({
    warehouse_id: warehouseId,
    prefix: form.prefix,
    codeFormat: form.codeFormat,
    aisles: normalizeAisle(form.aisle),
    rackFrom: enabled.racks ? form.rackFrom : '', rackTo: enabled.racks ? form.rackTo : '',
    levelFrom: enabled.levels ? form.levelFrom : '', levelTo: enabled.levels ? form.levelTo : '',
    positionFrom: enabled.positions ? form.positionFrom : '', positionTo: enabled.positions ? form.positionTo : '',
  }), [warehouseId, form, enabled])

  const hasRequiredData = Boolean(normalizeAisle(form.aisle)) && Object.entries(enabled).every(([key, on]) => !on || (form[`${key === 'racks' ? 'rack' : key === 'levels' ? 'level' : 'position'}From` as keyof BulkState] as string).trim())
  const conflictCount = Number(preview.existing_count ?? 0) + Number(preview.duplicate_count ?? 0) + Number(preview.error_count ?? 0)
  const canCreate = warehouseActive && !previewing && !creating && hasRequiredData && Boolean(preview.success) && !preview.limit_exceeded && conflictCount === 0 && Number(preview.valid_count ?? 0) > 0

  useEffect(() => {
    if (!hasRequiredData || !warehouseActive) return
    const timer = window.setTimeout(async () => {
      setPreviewing(true)
      setError(null)
      setShowAll(false)
      const result = await previewLocationsBulk(request)
      setPreview(result as BulkPreview)
      if ((result as BulkPreview).error) setError((result as BulkPreview).error ?? null)
      setPreviewing(false)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [request, hasRequiredData, warehouseActive])

  function update(values: Partial<BulkState>) { setForm(current => ({ ...current, ...values })) }
  function chooseStructure(value: Structure) {
    setStructure(value)
    if (value !== 'custom') setDimensions({ racks: value === 'complete' || value === 'rack', levels: value === 'complete', positions: value === 'complete' || value === 'positions' })
    update({ codeFormat: value === 'custom' ? form.codeFormat : formats[value] })
  }
  function confirmCreate() {
    const count = Number(preview.valid_count ?? 0)
    if (!window.confirm(`Bodega: ${warehouseName ?? 'seleccionada'}\nEstructura: ${structureOptions.find(option => option.id === structure)?.title}\nUbicaciones: ${count}\n\nSe crearán todas las ubicaciones en una sola operación.`)) return
    void submitCreate()
  }
  async function submitCreate() {
    setCreating(true); setError(null)
    const result = await createLocationsBulk(request)
    setCreating(false)
    if (!result.success) { setError(result.error ?? 'No se pudo crear el lote. No se creó ninguna ubicación.'); return }
    const response = result as typeof result & { created?: number; created_count?: number }
    onSuccess(Number(response.created ?? response.created_count ?? 0))
  }

  const codes = preview.codes ?? []
  const shownCodes = showAll ? codes : codes.slice(0, 40)
  const field = (label: string, from: keyof BulkState, to: keyof BulkState, disabled = false) => enabled[from.startsWith('rack') ? 'racks' : from.startsWith('level') ? 'levels' : 'positions'] && <div className="rounded-xl border border-theme-border bg-theme-text/[0.02] p-3">
    <label className="text-xs font-bold text-theme-text">{label}</label><div className="mt-2 flex items-center gap-2"><input value={form[from] as string} onChange={e => update({ [from]: e.target.value })} disabled={disabled} placeholder="Desde" className="h-10 min-w-0 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text" /><span className="text-xs text-theme-text-muted">a</span><input value={form[to] as string} onChange={e => update({ [to]: e.target.value })} disabled={disabled} placeholder="Hasta" className="h-10 min-w-0 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text" /></div>
  </div>

  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-theme-surface">
    <header className="flex shrink-0 items-center justify-between border-b border-theme-border px-5 py-4"><div><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-theme-accent"><Sparkles className="h-4 w-4" /> Creación masiva</p><h2 className="mt-1 text-lg font-bold text-theme-text">Define la estructura de tu zona</h2></div><button onClick={onClose} disabled={creating} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5"><X className="h-5 w-5" /></button></header>
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px]">
      <main className="min-h-0 space-y-5 overflow-y-auto p-5 lg:border-r lg:border-theme-border">
        {!warehouseActive && <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"><AlertTriangle className="h-5 w-5 shrink-0" />La bodega está inactiva. La creación está bloqueada.</div>}
        {error && <div className="flex gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700"><AlertTriangle className="h-5 w-5 shrink-0" />{error}</div>}
        <section><h3 className="mb-3 text-sm font-bold text-theme-text">¿Cómo está organizada esta zona de la bodega?</h3><div className="grid gap-2 sm:grid-cols-2">{structureOptions.map(option => <button key={option.id} type="button" onClick={() => chooseStructure(option.id)} className={`rounded-xl border p-3 text-left transition-colors ${structure === option.id ? 'border-theme-accent bg-theme-accent/10' : 'border-theme-border hover:bg-theme-text/5'}`}><span className="block text-sm font-bold text-theme-text">{option.title}</span><span className="mt-1 block text-xs text-theme-text-muted">{option.description}</span></button>)}</div></section>
        <section className="space-y-3"><div><h3 className="text-sm font-bold text-theme-text">Configuración</h3><p className="mt-1 flex items-center gap-1 text-xs text-theme-text-muted"><Info className="h-3.5 w-3.5" />Puedes usar números o letras en los rangos.</p></div><div className="rounded-xl border border-theme-border p-3"><label className="text-xs font-bold text-theme-text">Pasillo</label><input value={form.aisle} onChange={e => update({ aisle: normalizeAisle(e.target.value) })} placeholder="Ej: A" className="mt-2 h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text" /></div>{structure === 'custom' && <div className="grid gap-2 sm:grid-cols-3">{(['racks', 'levels', 'positions'] as Dimension[]).map(dimension => <label key={dimension} className="flex items-center gap-2 rounded-lg border border-theme-border p-3 text-xs font-semibold text-theme-text"><input type="checkbox" checked={dimensions[dimension]} onChange={e => setDimensions(current => ({ ...current, [dimension]: e.target.checked }))} />{dimension === 'racks' ? 'Racks' : dimension === 'levels' ? 'Niveles' : 'Posiciones'}</label>)}</div>}<div className="grid gap-3 sm:grid-cols-3">{field('Racks', 'rackFrom', 'rackTo')}{field('Niveles', 'levelFrom', 'levelTo')}{field('Posiciones', 'positionFrom', 'positionTo')}</div></section>
        <section className="rounded-xl border border-theme-border p-4"><button type="button" onClick={() => setShowAdvanced(value => !value)} className="flex w-full items-center gap-2 text-sm font-bold text-theme-text"><Settings2 className="h-4 w-4 text-theme-accent" />Formato del código<span className="ml-auto">{showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span></button><p className="mt-2 font-mono text-sm text-theme-accent">{form.codeFormat.replace('{prefix}', form.prefix || '').replace('{aisle}', form.aisle || 'A').replace('{rack}', form.rackFrom || '01').replace('{level}', form.levelFrom || '01').replace('{position}', form.positionFrom || '01')}</p>{showAdvanced && <div className="mt-3 space-y-2"><label className="text-xs font-semibold text-theme-text">Plantilla avanzada</label><input value={form.codeFormat} onChange={e => update({ codeFormat: e.target.value })} className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-mono text-xs text-theme-text" /><input value={form.prefix} onChange={e => update({ prefix: e.target.value })} placeholder="Prefijo opcional" className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text" /><p className="text-[11px] text-theme-text-muted">Variables: {'{prefix}'} {'{aisle}'} {'{rack}'} {'{level}'} {'{position}'}</p></div>}</section>
      </main>
      <aside className="flex min-h-0 flex-col bg-theme-text/[0.02] p-5"><div className="mb-4 flex items-start justify-between"><div><h3 className="text-sm font-bold text-theme-text">Vista previa</h3><p className="mt-1 text-xs text-theme-text-muted">Validada por el backend</p></div>{previewing && <Loader2 className="h-5 w-5 animate-spin text-theme-accent" />}</div><div className="grid grid-cols-2 gap-2 text-center text-xs"><Metric label="Solicitadas" value={preview.requested_count} /><Metric label="Listas para crear" value={preview.valid_count} good /><Metric label="Existentes" value={preview.existing_count} bad={!!preview.existing_count} /><Metric label="Duplicadas" value={preview.duplicate_count} bad={!!preview.duplicate_count} /><Metric label="Errores" value={preview.error_count} bad={!!preview.error_count} /><Metric label="Se crearán" value={preview.valid_count} good /></div>{preview.limit_exceeded && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-xs font-semibold text-red-700">El lote supera el límite de 2.000 ubicaciones.</div>}<div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-xl border border-theme-border bg-theme-surface p-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Códigos resultantes</p>{shownCodes.length ? <div className="space-y-1">{shownCodes.map((code, index) => <div key={`${code}-${index}`} className="rounded bg-theme-text/[0.03] px-2 py-1 font-mono text-xs text-theme-text">{code}</div>)}</div> : <p className="py-8 text-center text-xs text-theme-text-muted">Completa los datos para consultar el preview real.</p>}{codes.length > 40 && <button type="button" onClick={() => setShowAll(value => !value)} className="mt-3 w-full text-xs font-bold text-theme-accent">{showAll ? 'Ver menos' : `Ver todas (${codes.length})`}</button>}</div>{conflictCount > 0 && <div className="mt-3 max-h-32 overflow-y-auto rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-700"><p className="mb-1 font-bold">Corrige estos conflictos</p>{(preview.conflicts ?? []).slice(0, 20).map((conflict, index) => <p key={`${conflict.code}-${index}`}>{conflict.code}: {conflict.reason}</p>)}</div>}<div className="mt-4 space-y-2"><button type="button" onClick={confirmCreate} disabled={!canCreate} className="flex w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{creating ? <><Loader2 className="h-4 w-4 animate-spin" />Creando ubicaciones...</> : <>Crear {Number(preview.valid_count ?? 0)} ubicaciones</>}</button><button type="button" onClick={onClose} disabled={creating} className="w-full rounded-xl border border-theme-border px-4 py-3 text-sm font-semibold text-theme-text">Cancelar</button></div></aside>
    </div>
  </div>
}

function Metric({ label, value, good, bad }: { label: string; value?: number; good?: boolean; bad?: boolean }) { return <div className={`rounded-lg border p-2 ${bad ? 'border-red-300 bg-red-50 text-red-700' : good ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-theme-border bg-theme-surface text-theme-text'}`}><div className="text-[10px] opacity-70">{label}</div><strong className="text-base">{value ?? 0}</strong></div> }
