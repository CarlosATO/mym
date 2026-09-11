import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Edit3 } from 'lucide-react'
import { getCommunesCatalog, getEmployee, getRrhhPermissions, getEmployeePhotoUrl } from '@/app/actions/rrhh/employees'
import { EmployeeStatusAction } from '@/modules/rrhh/components/employee-status-action'
import { EmployeeDetails } from '@/modules/rrhh/components/employee-sections'
import { EmployeeEditableSection } from '@/modules/rrhh/components/employee-editable-section'
import { EmployeePhotoUploader } from '@/modules/rrhh/components/employee-photo-uploader'
import { contractTypeLabel } from '@/modules/rrhh/lib/contract-types'

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [employee, { canManage }, communes] = await Promise.all([getEmployee(id), getRrhhPermissions(), getCommunesCatalog()])
  if (!employee) notFound()
  const photoUrl = await getEmployeePhotoUrl(employee.profile_photo_path)
  const personal = { rut: employee.rut, nombres: employee.nombres, apellido_paterno: employee.apellido_paterno, apellido_materno: employee.apellido_materno ?? '', fecha_nacimiento: employee.fecha_nacimiento ?? '', telefono: employee.telefono ?? '', email_personal: employee.email_personal ?? '', email_corporativo: employee.email_corporativo ?? '', direccion: employee.direccion ?? '', commune_id: employee.commune_id ?? '', comuna: employee.comuna ?? '', ciudad: employee.ciudad ?? '' }
  const labor = { cargo: employee.cargo, area_departamento: employee.area_departamento, fecha_ingreso: employee.fecha_ingreso, tipo_contrato: employee.tipo_contrato ?? '', estado: employee.estado, observaciones: employee.observaciones ?? '' }
  return <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-theme-border px-5 py-3"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-theme-text-muted">RRHH / Personal</p><h1 className="mt-1 text-lg font-semibold text-theme-text">Ficha de trabajador</h1></div><div className="flex gap-2"><Link href="/dashboard/rrhh/personal" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"><ArrowLeft className="h-3.5 w-3.5" /> Volver</Link>{canManage && <><Link href={`/dashboard/rrhh/personal/${employee.id}/editar`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover"><Edit3 className="h-3.5 w-3.5" /> Editar</Link><EmployeeStatusAction id={employee.id} estado={employee.estado} /></>}</div></header>
    <div className="grid gap-5 p-5 lg:grid-cols-[220px_minmax(0,1fr)]"><EmployeePhotoUploader employee={employee} canEdit={canManage} photoUrl={photoUrl} /><div className="space-y-5"><EmployeeEditableSection title="Información personal" accent="blue" canEdit={canManage} employeeId={employee.id} communes={communes} initial={personal} viewContent={<EmployeeDetails rows={[["RUT", employee.rut], ["Nombres", employee.nombres], ["Apellido paterno", employee.apellido_paterno], ["Apellido materno", employee.apellido_materno], ["Fecha nacimiento", employee.fecha_nacimiento], ["Teléfono", employee.telefono], ["Email personal", employee.email_personal], ["Email corporativo", employee.email_corporativo], ["Dirección", employee.direccion], ["Comuna", employee.comuna], ["Ciudad", employee.ciudad]]} />} /><EmployeeEditableSection title="Información laboral" accent="green" canEdit={canManage} employeeId={employee.id} initial={labor} viewContent={<EmployeeDetails rows={[["Cargo", employee.cargo], ["Área / Departamento", employee.area_departamento], ["Fecha ingreso", employee.fecha_ingreso], ["Tipo contrato", contractTypeLabel(employee.tipo_contrato)], ["Estado", employee.estado], ["Observaciones", employee.observaciones]]} />} /></div></div>
  </section>
}
