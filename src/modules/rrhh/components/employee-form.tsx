'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Save } from 'lucide-react'
import { createEmployee, updateEmployee, prepareEmployeePhotoUpload, saveEmployeePhoto, type Employee, type EmployeePayload } from '@/app/actions/rrhh/employees'
import { createClient } from '@/lib/supabase/client'
import { formatRut, isValidRut } from '@/modules/rrhh/lib/rut'
import { EmployeeIdentityCard } from '@/modules/rrhh/components/employee-identity-card'
import { EmployeeSection } from '@/modules/rrhh/components/employee-sections'
import { TerritorialCombobox } from '@/modules/rrhh/components/territorial-combobox'
import { ContractSelect } from '@/modules/rrhh/components/contract-select'

const fields = [
  ['rut', 'RUT *', 'text'], ['nombres', 'Nombres *', 'text'], ['apellido_paterno', 'Apellido paterno *', 'text'],
  ['apellido_materno', 'Apellido materno', 'text'], ['fecha_nacimiento', 'Fecha nacimiento', 'date'], ['telefono', 'Teléfono', 'text'],
  ['email_personal', 'Email personal', 'email'], ['email_corporativo', 'Email corporativo', 'email'], ['direccion', 'Dirección', 'text'],
] as const

type FormState = Record<keyof EmployeePayload, string>

function initialState(employee?: Employee): FormState {
  return {
    rut: employee?.rut ?? '', nombres: employee?.nombres ?? '', apellido_paterno: employee?.apellido_paterno ?? '', apellido_materno: employee?.apellido_materno ?? '',
    fecha_nacimiento: employee?.fecha_nacimiento ?? '', telefono: employee?.telefono ?? '', email_personal: employee?.email_personal ?? '', email_corporativo: employee?.email_corporativo ?? '',
    direccion: employee?.direccion ?? '', comuna: employee?.comuna ?? '', commune_id: employee?.commune_id ?? '', ciudad: employee?.ciudad ?? '', cargo: employee?.cargo ?? '', area_departamento: employee?.area_departamento ?? '',
    fecha_ingreso: employee?.fecha_ingreso ?? '', tipo_contrato: employee?.tipo_contrato ?? '', estado: employee?.estado ?? 'ACTIVO', observaciones: employee?.observaciones ?? '',
  }
}

export function EmployeeForm({ employee, communes }: { employee?: Employee; communes: { id: string; name: string }[] }) {
  const router = useRouter()
  const [form, setForm] = useState<FormState>(() => initialState(employee))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const isEditing = Boolean(employee)

  function update(key: keyof EmployeePayload, value: string) {
    setForm(current => ({ ...current, [key]: value }))
    if (key === 'rut') setError('')
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!isValidRut(form.rut)) { setError('Ingresa un RUT chileno válido, incluyendo su dígito verificador.'); return }
    setSaving(true)
    setError('')
    const payload: EmployeePayload = { ...form, estado: form.estado === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO' }
    const result = isEditing ? await updateEmployee(employee!.id, payload) : await createEmployee(payload)
    setSaving(false)
    if (!result.ok) { setError(result.error); return }
    if (photoFile) {
      const prepared = await prepareEmployeePhotoUpload(result.employee.id, photoFile.type, photoFile.size)
      if (prepared.path && prepared.token) {
        const upload = await createClient().storage.from('rrhh-profile-photos').uploadToSignedUrl(prepared.path, prepared.token, photoFile, { contentType: photoFile.type })
        if (!upload.error) await saveEmployeePhoto(result.employee.id, prepared.path, photoFile.type, photoFile.size)
      }
    }
    toast.success(isEditing ? 'Trabajador actualizado.' : 'Trabajador creado correctamente.')
    router.push(`/dashboard/rrhh/personal/${result.employee.id}`)
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border px-5 py-4">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-theme-text-muted">RRHH / Personal</p><h1 className="mt-1 text-xl font-semibold text-theme-text">{isEditing ? 'Editar trabajador' : 'Nuevo trabajador'}</h1></div>
        <div className="flex gap-2"><button type="button" onClick={() => router.back()} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"><ArrowLeft className="h-3.5 w-3.5" /> Cancelar</button><button disabled={saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"><Save className="h-3.5 w-3.5" /> {saving ? 'Guardando...' : 'Guardar'}</button></div>
      </div>
      {error && <p className="mx-5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-600 dark:text-red-300">{error}</p>}
      <div className="grid gap-5 px-5 pb-6 lg:grid-cols-[220px_minmax(0,1fr)]"><EmployeeIdentityCard name={`${form.nombres} ${form.apellido_paterno} ${form.apellido_materno}`} rut={form.rut} cargo={form.cargo} estado={form.estado === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO'} photoUrl={photoUrl} canEdit onPhotoSelected={file => { if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('La foto debe ser JPG, PNG o WebP y pesar hasta 5 MB.'); return } setPhotoFile(file); setPhotoUrl(URL.createObjectURL(file)); setError('') }} /><div className="space-y-5">
        <EmployeeSection title="Información personal" className="border-sky-200/80 border-t-4 border-t-sky-400 bg-sky-50/55 dark:border-sky-900/50 dark:bg-sky-950/20"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {fields.map(([key, label, type]) => <label key={key} className="space-y-1 text-xs font-medium text-theme-text-muted"><span>{label}</span><input required={label.endsWith('*')} type={type} value={form[key]} onChange={event => update(key, event.target.value)} onBlur={key === 'rut' ? () => { if (form.rut && !isValidRut(form.rut)) setError('El RUT no es válido.') } : undefined} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent" placeholder={key === 'rut' ? '12.345.678-5' : undefined} /></label>)}
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Comuna *</span><TerritorialCombobox value={form.commune_id} options={communes} placeholder="Buscar comuna..." onChange={id => { const commune = communes.find(option => option.id === id); setForm(current => ({ ...current, commune_id: id, comuna: commune?.name ?? '', ciudad: '' })) }} /></label>
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Ciudad / Localidad</span><input value={form.ciudad} onChange={event => update('ciudad', event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent" placeholder="Ciudad o localidad (opcional)" /></label>
        </div></EmployeeSection>
        <EmployeeSection title="Información laboral" className="border-emerald-200/80 border-t-4 border-t-emerald-400 bg-emerald-50/55 dark:border-emerald-900/50 dark:bg-emerald-950/20"><div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Cargo *</span><input required value={form.cargo} onChange={event => update('cargo', event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Área / Departamento *</span><input required value={form.area_departamento} onChange={event => update('area_departamento', event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Fecha ingreso *</span><input required type="date" value={form.fecha_ingreso} onChange={event => update('fecha_ingreso', event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
           <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Tipo contrato</span><ContractSelect value={form.tipo_contrato} onChange={value => update('tipo_contrato', value)} /></label>
          <label className="space-y-1 text-xs font-medium text-theme-text-muted"><span>Estado</span><select value={form.estado} onChange={event => update('estado', event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent"><option value="ACTIVO">ACTIVO</option><option value="INACTIVO">INACTIVO</option></select></label>
          <label className="space-y-1 text-xs font-medium text-theme-text-muted sm:col-span-2"><span>Observaciones</span><textarea rows={4} value={form.observaciones} onChange={event => update('observaciones', event.target.value)} className="w-full rounded-lg border border-theme-border bg-transparent px-2.5 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
        </div></EmployeeSection>
      </div></div>
      <span className="sr-only">RUT presentado: {formatRut(form.rut)}</span>
    </form>
  )
}
