'use client'

import { useState, useEffect, useCallback } from 'react'
import { getKardexMovements, type KardexMovement } from '@/app/actions/logistica/recepciones'
import { Search } from 'lucide-react'

const MOVEMENT_TYPE_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  IN: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  OUT: { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' },
  ADJUSTMENT: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  TRANSFER_IN: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' },
  TRANSFER_OUT: { bg: 'bg-indigo-500/10', text: 'text-indigo-500', border: 'border-indigo-500/20' },
}

function Badge({ value, label }: { value: string; label: string }) {
  const s = MOVEMENT_TYPE_BADGES[value] || { bg: 'bg-gray-500/10', text: 'text-gray-500', border: 'border-gray-500/20' }
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}>
      {label}
    </span>
  )
}

function movementLabel(type: string) {
  const map: Record<string, string> = {
    IN: 'Entrada',
    OUT: 'Salida',
    ADJUSTMENT: 'Ajuste',
    TRANSFER_IN: 'Transf. Entrada',
    TRANSFER_OUT: 'Transf. Salida',
  }
  return map[type] || type
}

function formatCurrency(amount: number | null) {
  if (amount === null) return '—'
  return amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('es-CL')
}

export function KardexPanel() {
  const [data, setData] = useState<KardexMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 50

  const load = useCallback(async () => {
    setLoading(true)
    const movements = await getKardexMovements()
    setData(movements)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Client-side filtering
  let filteredData = data
  if (search.trim()) {
    const s = search.toLowerCase()
    filteredData = filteredData.filter(m => 
      m.product_sku.toLowerCase().includes(s) ||
      m.product_description.toLowerCase().includes(s) ||
      m.warehouse_name.toLowerCase().includes(s) ||
      (m.location_code && m.location_code.toLowerCase().includes(s)) ||
      (m.lot_number && m.lot_number.toLowerCase().includes(s))
    )
  }

  const total = filteredData.length
  const tp = Math.ceil(total / pageSize)
  const paginatedData = filteredData.slice((page - 1) * pageSize, page * pageSize)

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
        <input 
          type="text" 
          value={search} 
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Buscar movimientos por SKU, producto, bodega, ubicación o lote..."
          className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" 
        />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay movimientos de Kardex registrados.</p>
        </div>
      ) : paginatedData.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No se encontraron movimientos para la búsqueda.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-theme-border bg-theme-text/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="text-left py-3 px-4 font-medium">Fecha / Hora</th>
                <th className="text-left py-3 px-4 font-medium">Producto</th>
                <th className="text-left py-3 px-4 font-medium">Movimiento</th>
                <th className="text-right py-3 px-4 font-medium">Cantidad</th>
                <th className="text-right py-3 px-4 font-medium">Costo Unitario</th>
                <th className="text-right py-3 px-4 font-medium">Costo Total</th>
                <th className="text-left py-3 px-4 font-medium">Bodega</th>
                <th className="text-left py-3 px-4 font-medium">Ubicación</th>
                <th className="text-left py-3 px-4 font-medium">Lote / Vencimiento</th>
                <th className="text-left py-3 px-4 font-medium">Notas / Referencia</th>
              </tr>
            </thead>
            <tbody>
              {paginatedData.map(m => (
                <tr key={m.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                  <td className="py-3 px-4 text-xs text-theme-text whitespace-nowrap">{formatDate(m.movement_date)}</td>
                  <td className="py-3 px-4">
                    <p className="text-xs font-mono font-semibold text-theme-text-accent">{m.product_sku}</p>
                    <p className="text-[11px] text-theme-text-muted max-w-[250px] truncate">{m.product_description}</p>
                  </td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <Badge value={m.movement_type} label={movementLabel(m.movement_type)} />
                  </td>
                  <td className="py-3 px-4 text-xs text-right font-medium text-theme-text">{m.quantity}</td>
                  <td className="py-3 px-4 text-xs text-right text-theme-text-muted">{formatCurrency(m.unit_cost)}</td>
                  <td className="py-3 px-4 text-xs text-right text-theme-text font-semibold">{formatCurrency(m.total_cost)}</td>
                  <td className="py-3 px-4 text-xs text-theme-text whitespace-nowrap">{m.warehouse_name}</td>
                  <td className="py-3 px-4 text-xs font-mono font-medium text-theme-text-accent">{m.location_code || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted whitespace-nowrap">
                    {m.lot_number ? (
                      <div>
                        <p className="font-semibold text-theme-text">Lote: {m.lot_number}</p>
                        {m.expiration_date && <p className="text-[10px]">Vence: {m.expiration_date}</p>}
                      </div>
                    ) : '—'}
                  </td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted max-w-[200px] truncate">
                    <span className="font-medium text-theme-text">{m.source_type}</span>
                    {m.notes && <span className="block text-[10px] text-theme-text-muted/70">{m.notes}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tp > 1 && (
        <div className="flex items-center justify-between text-xs pt-2">
          <span className="text-theme-text-muted/50">Mostrando {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} de {total} registros</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="text-theme-text-muted/50">Pág. {page} de {tp}</span>
            <button disabled={page >= tp} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}
    </div>
  )
}
