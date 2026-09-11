'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Search } from 'lucide-react'
import type { Employee } from '@/app/actions/rrhh/employees'
import { contractTypeLabel } from '@/modules/rrhh/lib/contract-types'
import { formatRut } from '@/modules/rrhh/lib/rut'

type SortKey = 'rut' | 'name' | 'cargo' | 'area_departamento' | 'fecha_ingreso' | 'tipo_contrato' | 'estado'

export function EmployeesList({ employees, canManage }: { employees: Employee[]; canManage: boolean }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'name', ascending: true })
  const filtered = employees.filter(employee => [employee.rut, employee.rut_normalized, employee.nombres, employee.apellido_paterno, employee.apellido_materno, employee.cargo, employee.area_departamento].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase().trim()))
  const sorted = [...filtered].sort((a, b) => {
    const left = sort.key === 'name' ? `${a.nombres} ${a.apellido_paterno} ${a.apellido_materno ?? ''}` : sort.key === 'rut' ? a.rut_normalized : a[sort.key]
    const right = sort.key === 'name' ? `${b.nombres} ${b.apellido_paterno} ${b.apellido_materno ?? ''}` : sort.key === 'rut' ? b.rut_normalized : b[sort.key]
    return String(left ?? '').localeCompare(String(right ?? ''), 'es', { numeric: true }) * (sort.ascending ? 1 : -1)
  })
  function sortBy(key: SortKey) { setSort(current => ({ key, ascending: current.key === key ? !current.ascending : true })) }
  const headers: [SortKey, string][] = [['rut', 'RUT'], ['name', 'Nombre completo'], ['cargo', 'Cargo'], ['area_departamento', 'Área / Departamento'], ['fecha_ingreso', 'Fecha ingreso'], ['tipo_contrato', 'Tipo contrato'], ['estado', 'Estado']]

  return <section className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-theme-border px-4 py-3"><div><h1 className="text-lg font-semibold text-theme-text">Personal</h1><p className="text-xs text-theme-text-muted">{sorted.length} de {employees.length} trabajadores</p></div>{canManage && <Link href="/dashboard/rrhh/personal/nuevo" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover"><Plus className="h-3.5 w-3.5" /> Nuevo trabajador</Link>}</div>
    <div className="border-b border-theme-border px-4 py-3"><label className="relative block max-w-md"><Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-theme-text-muted" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por RUT, nombre, cargo o área..." className="h-8 w-full rounded-lg border border-theme-border bg-transparent pl-8 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent" /></label></div>
    <div className="overflow-x-auto"><table className="w-full min-w-[880px] text-left text-xs"><thead className="bg-theme-text/5 text-[10px] uppercase tracking-wider text-theme-text-muted"><tr>{headers.map(([key, label]) => <th key={key} className="px-3 py-2 font-bold"><button onClick={() => sortBy(key)} className="inline-flex items-center gap-1 hover:text-theme-text">{label}{sort.key === key ? (sort.ascending ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}</button></th>)}<th className="px-3 py-2 font-bold">Acción</th></tr></thead><tbody>{sorted.map(employee => <tr key={employee.id} onClick={() => { window.location.href = `/dashboard/rrhh/personal/${employee.id}` }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') window.location.href = `/dashboard/rrhh/personal/${employee.id}` }} tabIndex={0} className="cursor-pointer border-t border-theme-border/70 text-theme-text hover:bg-theme-text/5"><td className="px-3 py-2 font-mono">{formatRut(employee.rut)}</td><td className="px-3 py-2 font-semibold">{employee.nombres} {employee.apellido_paterno} {employee.apellido_materno ?? ''}</td><td className="px-3 py-2">{employee.cargo}</td><td className="px-3 py-2">{employee.area_departamento}</td><td className="px-3 py-2">{employee.fecha_ingreso}</td><td className="px-3 py-2">{contractTypeLabel(employee.tipo_contrato)}</td><td className="px-3 py-2"><span className={employee.estado === 'ACTIVO' ? 'rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300' : 'rounded-full bg-red-500/10 px-2 py-1 text-red-700 dark:text-red-300'}>{employee.estado}</span></td><td className="px-3 py-2"><Link href={`/dashboard/rrhh/personal/${employee.id}`} onClick={event => event.stopPropagation()} className="font-semibold text-theme-accent hover:underline">Abrir ficha</Link></td></tr>)}</tbody></table>{sorted.length === 0 && <p className="px-4 py-12 text-center text-sm text-theme-text-muted">{employees.length === 0 ? 'Aún no hay trabajadores registrados.' : 'No hay resultados para esta búsqueda.'}</p>}</div>
  </section>
}
