'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface ClassifierComboboxProps {
  type: string
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
}

interface Classifier {
  id: string
  name: string
  normalized_name: string
}

export function ClassifierCombobox({ type, value, onChange, label, placeholder, required, disabled }: ClassifierComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(value)
  const [items, setItems] = useState<Classifier[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const loadItems = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/classifiers?type=${type}&search=${encodeURIComponent(search || '')}`)
      const data = await res.json()
      setItems(data ?? [])
    } catch { setItems([]) }
    setLoading(false)
  }, [type, search])

  useEffect(() => { if (open) loadItems() }, [open, loadItems])

  useEffect(() => { setSearch(value) }, [value])

  function normalize(s: string) { return s.toUpperCase().trim().replace(/\s+/g, ' ') }

  const filtered = items.filter(i => !search || i.normalized_name.includes(normalize(search)))
  const exactMatch = filtered.some(i => i.normalized_name === normalize(search))
  const showCreate = search && !exactMatch && !disabled

  async function handleCreate() {
    if (!search || disabled) return
    setCreating(true)
    try {
      const res = await fetch('/api/classifiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classifier_type: type, name: search }),
      })
      const data = await res.json()
      if (data.error) { alert(data.error); return }
      onChange(data.name)
      setSearch(data.name)
      setOpen(false)
    } catch (e) { alert('Error al crear') }
    setCreating(false)
  }

  return (
    <div ref={ref} className="relative space-y-1">
      <label className="text-xs text-theme-text-muted/70">{label}{required && ' *'}</label>
      <input
        type="text"
        value={search}
        onChange={e => { setSearch(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? `Buscar ${label.toLowerCase()}...`}
        disabled={disabled}
        className="w-full h-9 rounded-lg border border-theme-border bg-theme-text/5 px-3 text-xs text-theme-text disabled:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 w-full max-h-48 overflow-y-auto bg-theme-surface border border-theme-border rounded-xl shadow-xl z-50 p-1 space-y-0.5">
            {loading && <p className="px-3 py-2 text-xs text-theme-text-muted/50">Cargando...</p>}
            {!loading && filtered.length === 0 && !showCreate && (
              <p className="px-3 py-2 text-xs text-theme-text-muted/50">Sin resultados</p>
            )}
            {filtered.map(item => (
              <button
                key={item.id}
                onClick={() => { onChange(item.name); setSearch(item.name); setOpen(false) }}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs rounded-lg transition-colors',
                  item.name === value ? 'bg-theme-text/10 text-theme-text font-medium' : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                )}
              >
                {item.name}
              </button>
            ))}
            {showCreate && (
              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full text-left px-3 py-2 text-xs text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors border-t border-theme-border mt-1 pt-2"
              >
                {creating ? 'Creando...' : `+ Crear "${search.toUpperCase().trim()}"`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
