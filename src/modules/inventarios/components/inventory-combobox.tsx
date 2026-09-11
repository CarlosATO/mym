'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface InventoryComboboxOption {
  value: string
  label: string
}

interface InventoryComboboxProps {
  options: InventoryComboboxOption[]
  value: string
  onSelect: (value: string) => void
  placeholder: string
  ariaLabel: string
  disabled?: boolean
  emptyText?: string
  size?: 'compact' | 'comfortable'
  className?: string
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function InventoryCombobox({ options, value, onSelect, placeholder, ariaLabel, disabled = false, emptyText = 'Sin resultados', size = 'compact', className }: InventoryComboboxProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const filtered = useMemo(() => {
    const q = normalize(query)
    return q ? options.filter(option => normalize(option.label).includes(q)) : options
  }, [options, query])

  const selected = useMemo(() => options.find(option => option.value === value), [options, value])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  const pick = useCallback((next: string) => {
    onSelect(next)
    setOpen(false)
    setQuery('')
  }, [onSelect])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(index => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      if (open && filtered.length > 0) {
        event.preventDefault()
        pick(filtered[Math.min(activeIndex, filtered.length - 1)].value)
      }
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }, [open, filtered, activeIndex, pick])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
        <div className={cn(
          'flex items-center gap-1 rounded-md border border-theme-border/50 bg-transparent px-1.5 outline-none focus-within:border-theme-border-accent',
          size === 'comfortable' ? 'h-10 text-sm' : 'h-7 text-xs'
        )}>
        <Search className="h-3.5 w-3.5 shrink-0 text-theme-text-muted/50" />
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          value={open ? query : (selected?.label ?? '')}
          placeholder={placeholder}
          onFocus={() => {
            if (disabled) return
            setQuery('')
            setOpen(true)
            setActiveIndex(0)
          }}
          onChange={event => {
            if (disabled) return
            setQuery(event.target.value)
            setOpen(true)
            setActiveIndex(0)
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className={cn(
            'h-full w-full min-w-0 bg-transparent text-theme-text outline-none placeholder:text-theme-text-muted/50 disabled:cursor-not-allowed disabled:opacity-50',
            size === 'comfortable' ? 'text-sm' : 'text-xs'
          )}
        />
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-theme-text-muted/50 transition-transform', open && 'rotate-180')} />
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-theme-border bg-theme-surface py-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-theme-text-muted">{emptyText}</li>
          ) : (
            filtered.map((option, index) => (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => pick(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors',
                    index === activeIndex ? 'bg-theme-text/5 text-theme-text' : 'text-theme-text-muted'
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value && <Check className="h-3 w-3 shrink-0 text-theme-accent" />}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
