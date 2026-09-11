'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { setEmployeeStatus } from '@/app/actions/rrhh/employees'

export function EmployeeStatusAction({ id, estado }: { id: string; estado: 'ACTIVO' | 'INACTIVO' }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const nextStatus = estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO'
  async function changeStatus() {
    if (!window.confirm(`¿Confirmas cambiar el estado a ${nextStatus}?`)) return
    setSaving(true)
    const result = await setEmployeeStatus(id, nextStatus)
    setSaving(false)
    if (!result.ok) { toast.error(result.error); return }
    toast.success(`Trabajador ${nextStatus.toLowerCase()}.`)
    router.refresh()
  }
  return <button disabled={saving} onClick={changeStatus} className="h-8 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50">{saving ? 'Actualizando...' : nextStatus === 'ACTIVO' ? 'Activar' : 'Inactivar'}</button>
}
