'use client'

import { useCallback, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  label: string
}

interface LocalComboboxProps {
  value: string
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  onCreateNew?: (name: string) => Promise<void>
}

export function LocalCombobox({ value, onChange, options, placeholder = "Seleccionar...", disabled, className, onCreateNew }: LocalComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayValue = open ? search : (selectedOption?.label || '')

  const updateDropdownRect = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const gap = 6
    const minHeight = 96
    const preferredHeight = 256
    const viewportPadding = 12
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openUp = spaceBelow < preferredHeight && spaceAbove > spaceBelow
    const availableSpace = Math.max(minHeight, openUp ? spaceAbove - gap : spaceBelow - gap)
    const availableHeight = Math.min(preferredHeight, availableSpace)
    const width = Math.max(rect.width, 320)

    setDropdownRect({
      top: openUp ? Math.max(viewportPadding, rect.top - availableHeight - gap) : rect.bottom + gap,
      left: Math.min(rect.left, window.innerWidth - width - viewportPadding),
      width,
      maxHeight: availableHeight,
    })
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (!open) return
    updateDropdownRect()
    window.addEventListener('resize', updateDropdownRect)
    window.addEventListener('scroll', updateDropdownRect, true)
    return () => {
      window.removeEventListener('resize', updateDropdownRect)
      window.removeEventListener('scroll', updateDropdownRect, true)
    }
  }, [open, updateDropdownRect])

  const filtered = options.filter(o => 
    o.label.toLowerCase().includes(search.toLowerCase()) || o.value.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div ref={ref} className="relative w-full">
      <input
        type="text"
        value={displayValue}
        onChange={e => { setSearch(e.target.value); updateDropdownRect(); setOpen(true) }}
        onFocus={() => { updateDropdownRect(); setOpen(true); setSearch('') }}
        placeholder={placeholder}
        disabled={disabled}
        className={cn("w-full focus:outline-none text-theme-text placeholder:text-theme-text-muted/60", className)}
      />
      {open && !disabled && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => { setOpen(false); setSearch(''); }} />
          <div
            className="fixed overflow-y-auto bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl ring-1 ring-black/5 dark:ring-white/10 z-[9999] p-1.5 space-y-0.5 text-left"
            onMouseDown={e => e.stopPropagation()}
            style={{
              top: dropdownRect?.top ?? 0,
              left: dropdownRect?.left ?? 0,
              width: dropdownRect?.width ?? 260,
              maxHeight: dropdownRect?.maxHeight ?? 256,
            }}
          >
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[11px] font-medium text-slate-500 dark:text-slate-400 flex justify-between items-center">
                <span>Sin resultados</span>
                {onCreateNew && search.trim() && (
                  <button
                    onClick={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      await onCreateNew(search.trim())
                      setSearch('')
                      setOpen(false)
                    }}
                    className="text-theme-accent hover:underline ml-2"
                  >
                    Crear "{search.trim()}"
                  </button>
                )}
              </div>
            )}
            {filtered.map(opt => (
              <button
                key={opt.value}
                onClick={(e) => { 
                  e.preventDefault()
                  e.stopPropagation()
                  onChange(opt.value)
                  setSearch('')
                  setOpen(false) 
                }}
                className={cn(
                  'w-full text-left px-2.5 py-2 text-[11px] rounded-lg transition-colors truncate',
                  opt.value === value
                    ? 'bg-theme-accent text-white font-bold shadow-sm'
                    : 'text-slate-800 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-white font-semibold'
                )}
                title={opt.label}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
