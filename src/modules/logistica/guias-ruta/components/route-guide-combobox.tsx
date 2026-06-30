'use client'

import React, { useCallback, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { ChevronDown, Plus, Search } from 'lucide-react'

export interface ComboboxOption {
  value: string
  label: string
}

interface RouteGuideComboboxProps {
  value: string
  onChange: (value: string) => void
  options: ComboboxOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  onCreateNew?: (name: string) => Promise<void>
  hasError?: boolean
  entityName?: string // e.g. "Ruta", "Vehículo" para el texto de "Crear nuevo..."
}

export function RouteGuideCombobox({
  value,
  onChange,
  options,
  placeholder = 'Seleccionar...',
  disabled,
  className,
  onCreateNew,
  hasError,
  entityName = 'elemento'
}: RouteGuideComboboxProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayValue = open ? search : (selectedOption?.label || '')

  const updateDropdownRect = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const gap = 8
    const minHeight = 120
    const preferredHeight = 300
    const viewportPadding = 16
    
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    
    // Open upwards if there's not enough space below, but plenty above
    const openUp = spaceBelow < preferredHeight && spaceAbove > spaceBelow
    const availableSpace = Math.max(minHeight, openUp ? spaceAbove - gap : spaceBelow - gap)
    const availableHeight = Math.min(preferredHeight, availableSpace)
    
    // Ancho mínimo para que se vea premium
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
    window.addEventListener('scroll', updateDropdownRect, true) // true para capturar eventos de scroll de contenedores con overflow
    return () => {
      window.removeEventListener('resize', updateDropdownRect)
      window.removeEventListener('scroll', updateDropdownRect, true)
    }
  }, [open, updateDropdownRect])

  const filtered = options.filter(o => 
    o.label.toLowerCase().includes(search.toLowerCase()) || o.value.toLowerCase().includes(search.toLowerCase())
  )

  const isExactMatch = options.some(o => o.label.trim().toLowerCase() === search.trim().toLowerCase())
  const showCreateOption = onCreateNew && search.trim().length > 0 && !isExactMatch

  const handleSelect = (val: string) => {
    onChange(val)
    setOpen(false)
    setSearch('')
  }

  const handleCreate = async () => {
    if (!onCreateNew || !search.trim()) return
    const newName = search.trim().toUpperCase() // Regla: normalizar a MAYÚSCULAS
    await onCreateNew(newName)
    setOpen(false)
    setSearch('')
  }

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      <div 
        className={cn(
          "flex items-center w-full min-h-[42px] px-3 py-2 rounded-xl transition-all duration-200 cursor-text",
          "bg-theme-surface border",
          disabled ? "opacity-60 cursor-not-allowed bg-theme-text/5 border-theme-border/50" : "hover:border-theme-border-hover",
          open && !disabled ? "border-theme-accent ring-2 ring-theme-accent/20" : "border-theme-border",
          hasError && !open ? "border-red-500 ring-1 ring-red-500" : ""
        )}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        <div className="flex-1 min-w-0 flex items-center">
          {open && <Search className="w-4 h-4 mr-2 text-theme-text-muted shrink-0" />}
          <input
            ref={inputRef}
            type="text"
            value={displayValue}
            onChange={e => { setSearch(e.target.value); updateDropdownRect(); setOpen(true) }}
            onFocus={() => { updateDropdownRect(); setOpen(true); setSearch('') }}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full bg-transparent focus:outline-none text-sm font-medium text-theme-text placeholder:text-theme-text-muted/60 placeholder:font-normal truncate"
          />
        </div>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            if (open) {
              setOpen(false);
              setSearch('');
            } else {
              setOpen(true);
              inputRef.current?.focus();
            }
          }}
          className="ml-2 p-1 rounded-md text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors shrink-0"
        >
          <ChevronDown className={cn("w-4 h-4 transition-transform duration-200", open && "rotate-180")} />
        </button>
      </div>

      {/* Dropdown Menu Portal */}
      {open && !disabled && createPortal(
        <>
          {/* Backgrop invisible para cerrar al hacer click afuera en el portal */}
          <div className="fixed inset-0 z-[9998]" onClick={() => { setOpen(false); setSearch(''); }} />
          
          <div
            className={cn(
              "fixed z-[9999] flex flex-col bg-theme-surface text-theme-text border border-theme-border rounded-xl shadow-2xl shadow-black/10 overflow-hidden",
              "animate-in fade-in-0 zoom-in-95 duration-200"
            )}
            onMouseDown={e => e.stopPropagation()}
            style={{
              top: dropdownRect?.top ?? 0,
              left: dropdownRect?.left ?? 0,
              width: dropdownRect?.width ?? 260,
              maxHeight: dropdownRect?.maxHeight ?? 300,
            }}
          >
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 custom-scrollbar">
              {filtered.length === 0 && !showCreateOption && (
                <div className="px-3 py-4 text-center text-sm text-theme-text-muted">
                  No se encontraron resultados
                </div>
              )}
              
              {filtered.map(opt => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelect(opt.value)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-between",
                      isSelected 
                        ? "bg-theme-accent/10 text-theme-accent" 
                        : "hover:bg-theme-text/5 text-theme-text"
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-theme-accent shrink-0 ml-3" />}
                  </button>
                )
              })}

              {showCreateOption && (
                <>
                  {filtered.length > 0 && <div className="h-px bg-theme-border my-2 mx-1" />}
                  <button
                    type="button"
                    onClick={handleCreate}
                    className="w-full text-left px-3 py-3 rounded-lg text-sm font-bold bg-theme-accent/5 hover:bg-theme-accent/15 text-theme-accent transition-colors flex items-center gap-2 group border border-theme-accent/10"
                  >
                    <div className="w-6 h-6 rounded-md bg-theme-accent/10 flex items-center justify-center shrink-0 group-hover:bg-theme-accent/20 transition-colors">
                      <Plus className="w-4 h-4" />
                    </div>
                    <span className="truncate">Crear nuev{entityName.endsWith('a') ? 'a' : 'o'} <span className="font-black underline decoration-theme-accent/30 underline-offset-2">{entityName.toLowerCase()}</span>: <span className="uppercase">{search}</span></span>
                  </button>
                </>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
