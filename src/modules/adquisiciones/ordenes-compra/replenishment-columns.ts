export type ColumnId =
  | 'index'
  | 'sku'
  | 'product'
  | 'variant'
  | 'supplier'
  | 'line'
  | 'disponible'
  | 'estado'
  | 'sugerido'
  | 'cantidad'
  | 'monto'
  | 'confirmar'
  | 'totalVendido'
  | 'promedio'
  | 'costo'
  | 'semanas'

export type WidthKey =
  | 'sku'
  | 'product'
  | 'variant'
  | 'realSupplier'
  | 'pseudoSupplier'
  | 'disponible'
  | 'sugerido'
  | 'cantidad'
  | 'monto'
  | 'confirmar'
  | 'totalVendido'
  | 'promedio'
  | 'costo'
  | 'estado'

export type SortKey =
  | 'sku'
  | 'producto'
  | 'variante'
  | 'proveedor_real'
  | 'pseudoproveedor'
  | 'disponible'
  | 'sugerido'
  | 'cantidad'
  | 'monto'
  | 'total_vendido'
  | 'promedio'
  | 'costo'
  | 'estado'
  | `bucket_${number}`

export interface SortConfig {
  key: SortKey
  direction: 'asc' | 'desc'
}

/** Devuelve el índice de bucket si la key es bucket_N, si no null */
export function getBucketSortIdx(key: SortKey): number | null {
  if (typeof key === 'string' && key.startsWith('bucket_')) {
    const n = parseInt(key.slice(7), 10)
    return isNaN(n) ? null : n
  }
  return null
}

export type ViewId = 'compra' | 'ventas' | 'completa'
export type HistorialVisible = 'Oculto' | '4' | '8' | 'Todas'

export interface ColumnDef {
  label: string
  widthKey?: WidthKey
  sortKey?: SortKey
  resizable: boolean
  sticky?: boolean
  fixedWidth?: number
  align: 'left' | 'center' | 'right'
}

export const ALL_COLUMNS: ColumnId[] = [
  'index',
  'sku',
  'product',
  'variant',
  'supplier',
  'line',
  'disponible',
  'estado',
  'sugerido',
  'cantidad',
  'monto',
  'confirmar',
  'totalVendido',
  'promedio',
  'costo',
  'semanas',
]

export const FIXED_COLUMNS: ColumnId[] = ALL_COLUMNS.filter(id => id !== 'semanas')
export const STICKY_COLUMNS: ColumnId[] = ['index', 'sku', 'product']

export const COLUMN_DEFS: Record<ColumnId, ColumnDef> = {
  index: { label: '#', resizable: false, sticky: true, fixedWidth: 36, align: 'center' },
  sku: { label: 'SKU', widthKey: 'sku', sortKey: 'sku', resizable: true, sticky: true, align: 'left' },
  product: { label: 'Producto / desc.', widthKey: 'product', sortKey: 'producto', resizable: true, sticky: true, align: 'left' },
  variant: { label: 'Variante/tipo', widthKey: 'variant', sortKey: 'variante', resizable: true, align: 'left' },
  supplier: { label: 'Proveedor', widthKey: 'realSupplier', sortKey: 'proveedor_real', resizable: true, align: 'left' },
  line: { label: 'Línea de artículos', widthKey: 'pseudoSupplier', sortKey: 'pseudoproveedor', resizable: true, align: 'left' },
  disponible: { label: 'Disponible', widthKey: 'disponible', sortKey: 'disponible', resizable: true, align: 'center' },
  estado: { label: 'Estado', widthKey: 'estado', sortKey: 'estado', resizable: true, align: 'center' },
  sugerido: { label: 'Sugerido', widthKey: 'sugerido', sortKey: 'sugerido', resizable: true, align: 'right' },
  cantidad: { label: 'Cantidad', widthKey: 'cantidad', sortKey: 'cantidad', resizable: true, align: 'center' },
  monto: { label: 'Monto conf.', widthKey: 'monto', sortKey: 'monto', resizable: true, align: 'right' },
  confirmar: { label: 'Conf.', widthKey: 'confirmar', resizable: true, align: 'center' },
  totalVendido: { label: 'Total ven.', widthKey: 'totalVendido', sortKey: 'total_vendido', resizable: true, align: 'right' },
  promedio: { label: 'Prom. sem.', widthKey: 'promedio', sortKey: 'promedio', resizable: true, align: 'right' },
  costo: { label: 'Costo unit.', widthKey: 'costo', sortKey: 'costo', resizable: true, align: 'right' },
  semanas: { label: 'Historial semanal', resizable: false, align: 'center' },
}

// Grupos del selector de columnas (popover)
export const COLUMN_CONFIG_GROUPS: { id: string; label: string; columns: ColumnId[] }[] = [
  { id: 'PRODUCTO', label: 'Producto', columns: ['index', 'sku', 'product', 'variant', 'supplier', 'line'] },
  { id: 'INVENTARIO', label: 'Inventario', columns: ['disponible'] },
  { id: 'COMPRA', label: 'Compra', columns: ['estado', 'sugerido', 'cantidad', 'monto', 'confirmar'] },
  { id: 'ANALISIS', label: 'Análisis', columns: ['totalVendido', 'promedio', 'costo', 'semanas'] },
]

// Grupos de la cabecera agrupada de la tabla
export const TABLE_GROUPS: { label: string; columns: ColumnId[] }[] = [
  { label: 'Producto', columns: ['index', 'sku', 'product', 'variant', 'supplier', 'line'] },
  { label: 'Stock', columns: ['disponible'] },
  { label: 'Unidades vendidas cada 7 días', columns: ['semanas'] },
  { label: 'Confirmación de compra', columns: ['sugerido', 'cantidad', 'monto', 'confirmar'] },
  { label: 'Cálculo sugerido', columns: ['totalVendido', 'promedio', 'costo', 'estado'] },
]

export interface ViewDef {
  id: ViewId
  label: string
  visible: ColumnId[]
  historial: HistorialVisible
}

export const VIEWS: ViewDef[] = [
  {
    id: 'compra',
    label: 'Compra',
    visible: ['sku', 'product', 'supplier', 'line', 'disponible', 'estado', 'sugerido', 'cantidad', 'monto', 'confirmar'],
    historial: 'Oculto',
  },
  {
    id: 'ventas',
    label: 'Ventas',
    visible: ['index', 'sku', 'product', 'variant', 'line', 'disponible', 'semanas', 'totalVendido', 'promedio', 'costo', 'estado'],
    historial: 'Todas',
  },
  {
    id: 'completa',
    label: 'Completa',
    visible: ALL_COLUMNS,
    historial: 'Todas',
  },
]

export function hiddenForView(view: ViewId): ColumnId[] {
  const def = VIEWS.find(v => v.id === view)!
  return ALL_COLUMNS.filter(c => !def.visible.includes(c))
}

export function getHistorialOptions(numBuckets: number): { id: HistorialVisible; label: string }[] {
  const opts: { id: HistorialVisible; label: string }[] = [{ id: 'Oculto', label: 'Oculto' }]
  if (numBuckets >= 4) opts.push({ id: '4', label: 'Últimas 4' })
  if (numBuckets >= 8) opts.push({ id: '8', label: 'Últimas 8' })
  opts.push({ id: 'Todas', label: `Todas (${numBuckets})` })
  return opts
}

export function visibleBucketIndicesFor(historial: HistorialVisible, numBuckets: number): number[] {
  if (historial === 'Oculto' || numBuckets <= 0) return []
  const n = historial === 'Todas' ? numBuckets : Math.min(Number(historial), numBuckets)
  const start = numBuckets - n
  return Array.from({ length: n }, (_, i) => start + i)
}

export function getColumnWidth(id: ColumnId, colWidths: Record<WidthKey, number>): number {
  const def = COLUMN_DEFS[id]
  if (def.fixedWidth != null) return def.fixedWidth
  return def.widthKey ? colWidths[def.widthKey] : 90
}

export interface ReplenishmentViewPrefs {
  view: ViewId
  hidden: ColumnId[]
  historial: HistorialVisible
}

export const VIEW_PREFS_KEY = 'replenishment_view_v2'

export function loadViewPrefs(): ReplenishmentViewPrefs | null {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ReplenishmentViewPrefs>
    return {
      view: parsed.view || 'compra',
      hidden: parsed.hidden || [],
      historial: parsed.historial || 'Oculto',
    }
  } catch {
    return null
  }
}

export function saveViewPrefs(prefs: ReplenishmentViewPrefs): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // sin persistencia no bloquea la UI
  }
}
