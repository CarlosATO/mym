'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import type { WarehouseOption } from '@/app/actions/inventarios/sessions'

const STATUS_OPTIONS = [
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
    <div className="space-y-2.5" role="search">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            placeholder="Buscar por nombre o número"
            aria-label="Buscar jornadas"
            className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface pl-8 pr-2 text-xs text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
          />
        </div>

        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          aria-label="Filtrar por estado"
          className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
        >
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <select
          value={warehouse}
          onChange={e => setWarehouse(e.target.value)}
          aria-label="Filtrar por bodega"
          className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
        >
          <option value="">Todas las bodegas</option>
          {warehouses.map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>

        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          aria-label="Fecha desde"
          className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
        />

        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          aria-label="Fecha hasta"
          className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={applyFilters}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Aplicar
        </button>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-3.5 w-3.5" />
            Limpiar
          </button>
        )}
      </div>
    </div>
  )
}
