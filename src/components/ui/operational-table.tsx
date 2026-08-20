'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'

export type OperationalTableSortType = 'text' | 'number' | 'date'
export type OperationalTableSortDirection = 'asc' | 'desc'
export type OperationalTableSort = { column: string; direction: OperationalTableSortDirection }

export type OperationalTableColumn = {
  id: string
  defaultWidth: number
  minWidth: number
  maxWidth?: number
  resizable?: boolean
  sticky?: 'left' | 'right'
  sortable?: boolean
  sortKey?: string
  sortType?: OperationalTableSortType
}

type Widths = Record<string, number>

function defaultsFor(columns: OperationalTableColumn[]): Widths {
  return Object.fromEntries(columns.map(column => [column.id, column.defaultWidth]))
}

function clampWidth(column: OperationalTableColumn, width: number): number {
  const upper = column.maxWidth ?? Number.POSITIVE_INFINITY
  return Math.min(upper, Math.max(column.minWidth, Math.round(width)))
}

function validStoredWidths(value: unknown, columns: OperationalTableColumn[]): Widths {
  if (!value || typeof value !== 'object') return {}
  const stored = value as Record<string, unknown>
  const widths: Widths = {}
  for (const column of columns) {
    const width = stored[column.id]
    if (typeof width !== 'number' || !Number.isFinite(width)) continue
    if (width < column.minWidth || (column.maxWidth != null && width > column.maxWidth)) continue
    widths[column.id] = Math.round(width)
  }
  return widths
}

function readPreferences(tableKey: string): { widths: unknown; sort?: OperationalTableSort } {
  try {
    const raw = window.localStorage.getItem(tableKey)
    if (!raw) return { widths: {} }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed.widths === 'object') {
      return { widths: parsed.widths, sort: parsed.sort as OperationalTableSort | undefined }
    }
    return { widths: parsed }
  } catch {
    return { widths: {} }
  }
}

export function useOperationalTableWidths(tableKey: string, columns: OperationalTableColumn[]) {
  const [widths, setWidths] = useState<Widths>(() => defaultsFor(columns))
  const widthsRef = useRef(widths)

  useEffect(() => {
    const stored = validStoredWidths(readPreferences(tableKey).widths, columns)
    if (Object.keys(stored).length === 0) return
    setWidths(current => {
      const next = { ...current, ...stored }
      widthsRef.current = next
      return next
    })
  }, [columns, tableKey])

  const setColumnWidth = useCallback((column: OperationalTableColumn, width: number) => {
    const next = { ...widthsRef.current, [column.id]: clampWidth(column, width) }
    widthsRef.current = next
    setWidths(next)
  }, [])

  const persist = useCallback(() => {
    try {
      const preferences = readPreferences(tableKey)
      window.localStorage.setItem(tableKey, JSON.stringify({ widths: widthsRef.current, sort: preferences.sort }))
    } catch {
      // La persistencia local es opcional y no debe bloquear el resize.
    }
  }, [tableKey])

  const reset = useCallback(() => {
    const next = defaultsFor(columns)
    widthsRef.current = next
    setWidths(next)
    try {
      const preferences = readPreferences(tableKey)
      if (preferences.sort) window.localStorage.setItem(tableKey, JSON.stringify({ widths: next, sort: preferences.sort }))
      else window.localStorage.removeItem(tableKey)
    } catch {
      // La tabla conserva defaults aunque localStorage falle.
    }
  }, [columns, tableKey])

  return { widths, setColumnWidth, persist, reset }
}

export function useOperationalTableSort(tableKey: string, columns: OperationalTableColumn[]) {
  const [sort, setSort] = useState<OperationalTableSort | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- restore persisted table preference after mount */
  useEffect(() => {
    const stored = readPreferences(tableKey).sort
    if (!stored) return
    const column = columns.find(item => item.id === stored.column && item.sortable !== false && item.sortKey)
    if (column && (stored.direction === 'asc' || stored.direction === 'desc')) setSort(stored)
  }, [columns, tableKey])
  /* eslint-enable react-hooks/set-state-in-effect */

  const cycleSort = useCallback((column: OperationalTableColumn) => {
    if (column.sortable === false || !column.sortKey) return
    const next: OperationalTableSort | null = sort?.column !== column.id
      ? { column: column.id, direction: 'asc' }
      : sort.direction === 'asc'
        ? { column: column.id, direction: 'desc' }
        : null
    setSort(next)
    try {
      const preferences = readPreferences(tableKey)
      window.localStorage.setItem(tableKey, JSON.stringify({ widths: preferences.widths, sort: next }))
    } catch {
      // El ordenamiento de sesión funciona aunque no exista persistencia local.
    }
  }, [sort, tableKey])

  return { sort, cycleSort }
}

export function OperationalTableSortIndicator({ active, direction }: { active: boolean; direction?: OperationalTableSortDirection }) {
  if (!active) return <ChevronsUpDown aria-hidden="true" className="h-3 w-3 text-theme-text-muted/25 transition-colors group-hover:text-theme-text-muted/60" />
  return direction === 'asc'
    ? <ChevronUp aria-label="Orden ascendente" className="h-3 w-3 text-theme-accent" />
    : <ChevronDown aria-label="Orden descendente" className="h-3 w-3 text-theme-accent" />
}

type OperationalTableResizeHandleProps = {
  column: OperationalTableColumn
  width: number
  onResize: (width: number) => void
  onResizeEnd: () => void
}

export function OperationalTableResizeHandle({ column, width, onResize, onResizeEnd }: OperationalTableResizeHandleProps) {
  const [dragging, setDragging] = useState(false)
  if (column.resizable === false) return null

  return (
    <span
      aria-label={`Redimensionar columna ${column.id}`}
      className={`absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none select-none border-r transition-colors ${dragging ? 'border-theme-accent bg-theme-accent/50' : 'border-theme-border/50 hover:border-theme-accent/80 hover:bg-theme-accent/25'}`}
      onPointerDown={event => {
        event.preventDefault()
        event.stopPropagation()
        setDragging(true)
        const startX = event.clientX
        const startWidth = width
        const pointerId = event.pointerId
        const move = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId) return
          onResize(startWidth + moveEvent.clientX - startX)
        }
        const up = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          document.removeEventListener('pointercancel', up)
          setDragging(false)
          onResizeEnd()
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
        document.addEventListener('pointercancel', up)
      }}
    />
  )
}

export function shouldIgnoreOperationalRowDoubleClick(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, [role="button"], [data-row-interactive="true"]'))
}
