'use client'

import { useState, useEffect, useCallback } from 'react'
import { getStockSummary, type StockItem } from '@/app/actions/logistica/recepciones'
import { Search } from 'lucide-react'

export function StockPanel() {
  const [data, setData] = useState<StockItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 50

  const load = useCallback(async () => {
    setLoading(true)
    const summary = await getStockSummary()
    setData(summary)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Client-side filtering
  let filteredData = data
  if (search.trim()) {
    const s = search.toLowerCase()
    filteredData = filteredData.filter(item => 
      item.product_sku.toLowerCase().includes(s) ||
      item.product_description.toLowerCase().includes(s) ||
      item.warehouse_name.toLowerCase().includes(s) ||
      (item.location_code && item.location_code.toLowerCase().includes(s)) ||
      (item.lot_number && item.lot_number.toLowerCase().includes(s))
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
          placeholder="Buscar stock por SKU, producto, bodega, ubicación o lote..."
          className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" 
        />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay registros de stock (inventario vacío).</p>
        </div>
      ) : paginatedData.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No se encontraron existencias para la búsqueda.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-theme-border bg-theme-text/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="text-left py-3 px-4 font-medium">Producto</th>
                <th className="text-left py-3 px-4 font-medium">Bodega</th>
                <th className="text-left py-3 px-4 font-medium">Ubicación</th>
                <th className="text-left py-3 px-4 font-medium">Lote / Vencimiento</th>
                <th className="text-right py-3 px-4 font-medium">Cantidad Stock</th>
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((item, idx) => (
                <tr key={`${item.product_id}_${idx}`} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                  <td className="py-3 px-4">
                    <p className="text-xs font-mono font-semibold text-theme-text-accent">{item.product_sku}</p>
                    <p className="text-[11px] text-theme-text-muted max-w-[350px] truncate">{item.product_description}</p>
                  </td>
                  <td className="py-3 px-4 text-xs text-theme-text whitespace-nowrap">{item.warehouse_name}</td>
                  <td className="py-3 px-4 text-xs font-mono font-semibold text-theme-text-accent">{item.location_code || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted whitespace-nowrap">
                    {item.lot_number ? (
                      <div>
                        <p className="font-semibold text-theme-text">Lote: {item.lot_number}</p>
                        {item.expiration_date && <p className="text-[10px]">Vence: {item.expiration_date}</p>}
                      </div>
                    ) : '—'}
                  </td>
                  <td className="py-3 px-4 text-sm text-right font-bold text-theme-accent">{item.quantity}</td>
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
