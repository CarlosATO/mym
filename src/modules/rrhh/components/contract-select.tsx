'use client'

import { CONTRACT_TYPES } from '@/modules/rrhh/lib/contract-types'

export function ContractSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={event => onChange(event.target.value)} className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent">
    <option value="">Seleccionar</option>
    {CONTRACT_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}
