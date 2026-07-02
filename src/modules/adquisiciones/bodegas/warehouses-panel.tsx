'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'

export function WarehousesPanel() {
  const [data, setData] = useState<Warehouse[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [filters, setFilters] = useState<{ search?: string; warehouse_type?: string; status?: string; is_active?: string; page: number; pageSize: number }>({ page: 1, pageSize: 50 })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(async () => {
    const start = performance.now()
    setLoading(true)
    const r = await getWarehouses(filters)
    setData(r.data)
    setTotal(r.total)
    setLoading(false)
    if (process.env.NODE_ENV === 'development') {
      console.log(`[WarehousesPanel] load completa`, Math.round(performance.now() - start), 'ms')
    }
  }, [filters])

  useEffect(() => { load() }, [load])

  function setFilter(k: string, v: string) {
    if (k === 'search') {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = setTimeout(() => {
        setFilters(p => ({ ...p, [k]: v || undefined, page: 1 }))
      }, 300)
    } else {
      setFilters(p => ({ ...p, [k]: v || undefined, page: 1 }))
    }
  }

  const tp = Math.ceil(total / (filters.pageSize ?? 50))
  const typeOpts = ['CENTRAL','SUCURSAL','TRANSITO','DEVOLUCIONES','CONSIGNACION','OTRO']

  return (
    <div className="flex flex-col h-full bg-theme-surface overflow-hidden">
      {msg && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2 text-sm text-theme-text-accent">{msg}</div>}

      <div className="shrink-0 flex flex-col gap-4 p-5 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex flex-wrap items-center gap-3">
          <input type="text" value={filters.search ?? ''} onChange={e => setFilter('search', e.target.value)}
            placeholder="Buscar por código, nombre, ciudad, comuna..."
            className="flex-1 min-w-[200px] h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text placeholder:text-gray-400 dark:placeholder:text-theme-text-muted/50 focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
        </div>

        <div className="flex flex-wrap gap-3">
          <select value={filters.warehouse_type ?? ''} onChange={e => setFilter('warehouse_type', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
            <option value="" className="bg-white dark:bg-theme-surface">Todos los tipos</option>
            {typeOpts.map(t => <option key={t} value={t} className="bg-white dark:bg-theme-surface">{t}</option>)}
          </select>
          <select value={filters.status ?? ''} onChange={e => setFilter('status', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
            <option value="" className="bg-white dark:bg-theme-surface">Todos los estados</option>
            <option value="ACTIVE" className="bg-white dark:bg-theme-surface">ACTIVA</option>
            <option value="INACTIVE" className="bg-white dark:bg-theme-surface">INACTIVA</option>
            <option value="BLOCKED" className="bg-white dark:bg-theme-surface">BLOQUEADA</option>
          </select>
          <button onClick={() => setFilters({ page: 1, pageSize: 50 })} className="h-9 px-3 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text hover:bg-theme-text/5 text-xs transition-colors">✕ Limpiar filtros</button>
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-theme-text-muted/50 text-sm">Cargando bodegas...</div>
      ) : data.length === 0 ? (
        <div className="p-10 text-center text-theme-text-muted/50 text-sm">No se encontraron bodegas.</div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="text-left py-3 px-4 font-medium">Código</th>
                <th className="text-left py-3 px-4 font-medium">Nombre</th>
                <th className="text-left py-3 px-4 font-medium">Tipo</th>
                <th className="text-left py-3 px-4 font-medium">Ubicación</th>
                <th className="text-left py-3 px-4 font-medium">Encargado</th>
                <th className="text-center py-3 px-4 font-medium">Capacidad</th>
                <th className="text-center py-3 px-4 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {data.map(w => (
                <tr key={w.id} className="border-b border-theme-border transition-colors hover:bg-theme-text/5">
                  <td className="py-3 px-4 font-mono font-semibold text-theme-accent text-xs">{w.code}</td>
                  <td className="py-3 px-4 font-medium text-theme-text flex items-center gap-2">
                    {w.name} {w.is_default && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-theme-accent/10 text-theme-accent border border-theme-accent/20 uppercase">Default</span>}
                  </td>
                  <td className="py-3 px-4 text-theme-text-muted/70 text-xs">{w.warehouse_type}</td>
                  <td className="py-3 px-4 text-xs">
                    <p className="text-theme-text">{w.commune || '—'}</p>
                    <p className="text-theme-text-muted/50">{w.address || ''}</p>
                  </td>
                  <td className="py-3 px-4 text-xs">
                    <p className="text-theme-text">{w.manager_name || '—'}</p>
                    {w.manager_phone && <p className="text-theme-text-muted/50">{w.manager_phone}</p>}
                  </td>
                  <td className="py-3 px-4 text-center text-xs text-theme-text-muted/70">
                    {w.capacity_pallets ? `${w.capacity_pallets} plts` : '—'}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${w.is_active ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                      {w.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tp > 1 && (
        <div className="shrink-0 flex items-center justify-between text-xs p-4 border-t border-theme-border/60 bg-theme-text/[0.01]">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
            <select value={filters.pageSize} onChange={e => setFilter('pageSize', e.target.value)} className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
              <option value={25} className="bg-white dark:bg-theme-surface">25</option>
              <option value={50} className="bg-white dark:bg-theme-surface">50</option>
              <option value={100} className="bg-white dark:bg-theme-surface">100</option>
            </select>
            <span className="text-theme-text-muted/50">de {total} registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) - 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="text-theme-text-muted/50">Pág. {filters.page ?? 1} de {tp}</span>
            <button disabled={(filters.page ?? 1) >= tp} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) + 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}
    </div>
  )
}
