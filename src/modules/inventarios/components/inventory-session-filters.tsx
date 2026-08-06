'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import type { WarehouseOption } from '@/app/actions/inventarios/sessions'
import { InventoryCombobox, type InventoryComboboxOption } from '@/modules/inventarios/components/inventory-combobox'

const STATUS_OPTIONS: InventoryComboboxOption[] = [
  { value: '', label: 'Todos los estados' },
  { value: 'DRAFT', label: 'Borrador' },
  { value: 'PREPARED', label: 'Preparada' },
  { value: 'COUNTING', label: 'En conteo' },
  { value: 'UNDER_REVIEW', label: 'En revisión' },
  { value: 'APPROVED', label: 'Aprobada' },
  { value: 'EXPORTED', label: 'Exportada' },
  { value: 'RECONCILED', label: 'Conciliada' },
  { value: 'CANCELLED', label: 'Cancelada' },
]

interface InventorySessionFiltersProps {
  warehouses: WarehouseOption[]
}

export function InventorySessionFilters({ warehouses }: InventorySessionFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [text, setText] = useState(searchParams.get('q') ?? '')
  const [status, setStatus] = useState(searchParams.get('status') ?? '')
  const [warehouse, setWarehouse] = useState(searchParams.get('warehouse') ?? '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('from') ?? '')
  const [dateTo, setDateTo] = useState(searchParams.get('to') ?? '')

  const applyFilters = useCallback(() => {
    const params = new URLSearchParams()
    if (text.trim()) params.set('q', text.trim())
    if (status) params.set('status', status)
    if (warehouse) params.set('warehouse', warehouse)
    if (dateFrom) params.set('from', dateFrom)
    if (dateTo) params.set('to', dateTo)
    params.set('page', '1')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }, [text, status, warehouse, dateFrom, dateTo, router, pathname])

  const clearFilters = useCallback(() => {
    setText('')
    setStatus('')
    setWarehouse('')
    setDateFrom('')
    setDateTo('')
    router.push(pathname)
  }, [router, pathname])

  const hasActiveFilters = Boolean(text || status || warehouse || dateFrom || dateTo)

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 py-1.5 shadow-sm" role="search">
      <div className="relative min-w-[170px] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyFilters()}
          placeholder="Buscar por nombre o número"
          aria-label="Buscar secciones de conteo"
          className="h-7 w-full rounded-md border border-theme-border/50 bg-transparent pl-7 pr-2 text-xs text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
        />
      </div>

      <InventoryCombobox
        options={STATUS_OPTIONS}
        value={status}
        onSelect={setStatus}
        placeholder="Buscar estado…"
        ariaLabel="Filtrar por estado"
        className="w-36"
      />

      <InventoryCombobox
        options={[
          { value: '', label: 'Todas las bodegas' },
          ...warehouses.map(w => ({ value: w.id, label: w.name })),
        ]}
        value={warehouse}
        onSelect={setWarehouse}
        placeholder="Buscar bodega…"
        ariaLabel="Filtrar por bodega"
        className="w-40"
      />

      <input
        type="date"
        value={dateFrom}
        onChange={e => setDateFrom(e.target.value)}
        aria-label="Fecha desde"
        className="h-7 w-[124px] rounded-md border border-theme-border/50 bg-transparent px-1.5 text-xs text-theme-text outline-none focus:border-theme-border-accent"
      />

      <input
        type="date"
        value={dateTo}
        onChange={e => setDateTo(e.target.value)}
        aria-label="Fecha hasta"
        className="h-7 w-[124px] rounded-md border border-theme-border/50 bg-transparent px-1.5 text-xs text-theme-text outline-none focus:border-theme-border-accent"
      />

      <button
        type="button"
        onClick={applyFilters}
        className="inline-flex h-7 items-center gap-1 rounded-md bg-theme-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Aplicar
      </button>
      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
        >
          <X className="h-3.5 w-3.5" />
          Limpiar
        </button>
      )}
    </div>
  )
}
