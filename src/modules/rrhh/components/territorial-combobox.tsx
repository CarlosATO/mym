'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

type Option = { id: string; name: string }

function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim() }

export function TerritorialCombobox({ value, options, onChange, placeholder, disabled = false }: { value: string; options: Option[]; onChange: (id: string) => void; placeholder: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.id === value)
  const filtered = options.filter(option => normalize(option.name).includes(normalize(search)))
  useEffect(() => { const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }, [])
   // Reset the keyboard cursor when the filtered list changes.
   // eslint-disable-next-line react-hooks/set-state-in-effect
   useEffect(() => { setActiveIndex(0) }, [search])
  function choose(option: Option) { onChange(option.id); setSearch(''); setOpen(false) }
  return <div ref={ref} className="relative"><input value={open ? search : selected?.name ?? ''} placeholder={placeholder} disabled={disabled} onFocus={() => { setOpen(true); setSearch('') }} onChange={event => { setSearch(event.target.value); setOpen(true) }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, filtered.length - 1)) } else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => Math.max(index - 1, 0)) } else if (event.key === 'Enter' && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]) } else if (event.key === 'Escape') setOpen(false) }} className="h-8 w-full rounded-lg border border-theme-border bg-transparent px-2.5 text-sm text-theme-text outline-none focus:border-theme-accent disabled:cursor-not-allowed disabled:opacity-50" /><ChevronDown className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-theme-text-muted" />{open && <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-theme-border bg-theme-surface p-1 shadow-xl">{filtered.length ? filtered.map((option, index) => <button type="button" key={option.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)} className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs ${index === activeIndex ? 'bg-theme-accent/10 text-theme-text' : 'text-theme-text-muted hover:bg-theme-text/5'}`}>{option.name}{option.id === value && <Check className="h-3.5 w-3.5 text-theme-accent" />}</button>) : <p className="px-2.5 py-2 text-xs text-theme-text-muted">Sin resultados</p>}</div>}</div>
}
