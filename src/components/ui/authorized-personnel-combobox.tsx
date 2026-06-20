'use client'

import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface Personnel {
  id: string
  full_name: string
  position: string | null
  email: string | null
}

interface AuthorizedPersonnelComboboxProps {
  value: string
  onChange: (value: string) => void
  items: Personnel[]
  label: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
  onCreateNew: (name: string) => void
}

function normalize(s: string) { return s.toUpperCase().trim().replace(/\s+/g, ' ') }

export function AuthorizedPersonnelCombobox({
  value, onChange, items, label, placeholder, required, disabled, onCreateNew,
}: AuthorizedPersonnelComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const selected = items.find(i => i.id === value)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => { if (selected) setSearch('') }, [selected])

  const normalizedSearch = normalize(search)
  const filtered = items.filter(i =>
    !normalizedSearch ||
    normalize(i.full_name).includes(normalizedSearch) ||
    (i.position && normalize(i.position).includes(normalizedSearch)) ||
    (i.email && normalize(i.email).includes(normalizedSearch))
  ).slice(0, 20)

  const exactMatch = filtered.some(i => normalize(i.full_name) === normalizedSearch)
  const showCreate = normalizedSearch && !exactMatch && !disabled

  return (
    <div ref={ref} className="relative space-y-1">
      <label className="text-xs text-theme-text-muted/70">{label}{required && ' *'}</label>
      <input
        type="text"
        value={selected ? selected.full_name : search}
        onChange={e => { setSearch(e.target.value); setOpen(true); if (value) onChange('') }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? 'Buscar autorizador...'}
        disabled={disabled}
        className="w-full h-9 rounded-lg border border-theme-border bg-theme-text/5 px-3 text-xs text-theme-text disabled:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 w-full max-h-48 overflow-y-auto bg-theme-surface border border-theme-border rounded-xl shadow-xl z-50 p-1 space-y-0.5">
            {filtered.length === 0 && !showCreate && (
              <p className="px-3 py-2 text-xs text-theme-text-muted/50">Sin resultados</p>
            )}
            {filtered.map(item => (
              <button
                key={item.id}
                onClick={() => { onChange(item.id); setSearch(''); setOpen(false) }}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs rounded-lg transition-colors',
                  item.id === value ? 'bg-theme-text/10 text-theme-text font-medium' : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                )}
              >
                <span className="font-medium">{item.full_name}</span>
                {item.position && <span className="text-theme-text-muted/50 ml-2">{item.position}</span>}
              </button>
            ))}
            {showCreate && (
              <button
                onClick={() => { setOpen(false); onCreateNew(normalizedSearch) }}
                className="w-full text-left px-3 py-2 text-xs text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors border-t border-theme-border mt-1 pt-2"
              >
                + Crear "{normalizedSearch}"
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
