'use client'

import { useState } from 'react'
import { Check, Edit3, X } from 'lucide-react'
import { toast } from 'sonner'
import { updateEmployeePersonal, updateEmployeeLabor } from '@/app/actions/rrhh/employees'
import { ContractSelect } from './contract-select'
import { TerritorialCombobox } from './territorial-combobox'

type Props = {
  title: string
  accent: 'blue' | 'green'
  canEdit: boolean
  employeeId: string
  initial: Record<string, string>
  communes?: { id: string; name: string }[]
  viewContent: React.ReactNode
}

export function EmployeeEditableSection({ title, accent, canEdit, employeeId, initial, communes = [], viewContent }: Props) {
  const [editing, setEditing] = useState(false)
  const [values, setValues] = useState(initial)
  const [saving, setSaving] = useState(false)
  const isPersonal = 'rut' in initial
  const accentClass = accent === 'green'
    ? 'border-emerald-200/80 bg-emerald-50/40 dark:border-emerald-900/50 dark:bg-emerald-950/15'
    : 'border-sky-200/80 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/15'

  async function save() {
    setSaving(true)
    const result = isPersonal ? await updateEmployeePersonal(employeeId, values) : await updateEmployeeLabor(employeeId, values)
    setSaving(false)
    if (result.error) { toast.error(result.error); return }
    setEditing(false)
    toast.success('Sección actualizada.')
    window.location.reload()
  }

  function update(key: string, value: string) {
    setValues(current => ({ ...current, [key]: value }))
  }

  return <section className={`rounded-xl border p-4 shadow-sm ${accentClass}`}>
    <header className="mb-3 flex items-center justify-between border-b border-current/10 pb-2">
      <h2 className="text-sm font-semibold text-theme-text">{title}</h2>
      {canEdit && !editing && <button type="button" onClick={() => setEditing(true)} aria-label={`Editar ${title}`} className="rounded-md p-1.5 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-accent"><Edit3 className="h-3.5 w-3.5" /></button>}
      {editing && <div className="flex gap-1"><button type="button" disabled={saving} onClick={() => { setValues(initial); setEditing(false) }} className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text-muted"><X className="h-3 w-3" /> Cancelar</button><button type="button" disabled={saving} onClick={save} className="inline-flex h-7 items-center gap-1 rounded-md bg-theme-accent px-2 text-xs font-semibold text-white"><Check className="h-3 w-3" /> Guardar</button></div>}
    </header>
    {editing ? <div className="grid gap-3 sm:grid-cols-2">{Object.entries(values).map(([key, value]) => <label key={key} className="space-y-1 text-xs font-medium text-theme-text-muted"><span>{labelFor(key)}</span>
      {key === 'commune_id' ? <TerritorialCombobox value={value} options={communes} placeholder="Buscar comuna..." onChange={id => { const commune = communes.find(option => option.id === id); setValues(current => ({ ...current, commune_id: id, comuna: commune?.name ?? '', ciudad: '' })) }} />
        : key === 'tipo_contrato' ? <ContractSelect value={value} onChange={contract => update(key, contract)} />
          : key === 'estado' ? <select value={value} onChange={event => update(key, event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-sm text-theme-text"><option>ACTIVO</option><option>INACTIVO</option></select>
            : key === 'observaciones' ? <textarea rows={3} value={value} onChange={event => update(key, event.target.value)} className="w-full rounded-lg border border-theme-border bg-transparent px-2 py-2 text-sm text-theme-text" />
              : <input type={key.includes('fecha') ? 'date' : key.includes('email') ? 'email' : 'text'} value={value} onChange={event => update(key, event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2 text-sm text-theme-text" />}</label>)}</div> : viewContent}
  </section>
}

function labelFor(key: string) {
  return ({ rut: 'RUT', nombres: 'Nombres', apellido_paterno: 'Apellido paterno', apellido_materno: 'Apellido materno', fecha_nacimiento: 'Fecha nacimiento', telefono: 'Teléfono', email_personal: 'Email personal', email_corporativo: 'Email corporativo', direccion: 'Dirección', commune_id: 'Comuna', comuna: 'Comuna', ciudad: 'Ciudad / Localidad', cargo: 'Cargo', area_departamento: 'Área / Departamento', fecha_ingreso: 'Fecha ingreso', tipo_contrato: 'Tipo contrato', estado: 'Estado', observaciones: 'Observaciones' } as Record<string, string>)[key] ?? key
}
