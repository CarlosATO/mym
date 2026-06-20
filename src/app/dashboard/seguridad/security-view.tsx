'use client'

import { useState } from 'react'
import { getSecurityLogs, type SecurityLogEntry } from '@/app/actions/security'
import { cn } from '@/lib/utils'

const eventTypeMap: Record<string, string> = {
  LOGIN_SUCCESS: 'Inicio de sesión exitoso',
  LOGIN_FAILED: 'Inicio de sesión fallido',
  LOGOUT: 'Cierre de sesión',
  PASSWORD_CHANGE: 'Cambio de contraseña',
  PASSWORD_CHANGE_FORCED: 'Cambio obligatorio de contraseña',
  SESSION_EXPIRED: 'Sesión expirada',
}

const eventColors: Record<string, string> = {
  LOGIN_SUCCESS: 'text-theme-accent',
  LOGIN_FAILED: 'text-red-500',
  LOGOUT: 'text-amber-500',
  PASSWORD_CHANGE: 'text-theme-accent',
  PASSWORD_CHANGE_FORCED: 'text-amber-500',
  SESSION_EXPIRED: 'text-theme-text-muted/50',
}

export function SecurityView() {
  const [entries, setEntries] = useState<SecurityLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<SecurityLogEntry | null>(null)

  const [email, setEmail] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [eventType, setEventType] = useState('')
  const [success, setSuccess] = useState('')

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault()
    setLoading(true)
    setPage(1)
    setSearched(true)
    const result = await getSecurityLogs({
      email: email || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      eventType: eventType || undefined,
      success: success || undefined,
      page: 1,
    })
    setEntries(result.data)
    setTotal(result.total)
    setLoading(false)
  }

  async function goToPage(p: number) {
    setLoading(true)
    setPage(p)
    const result = await getSecurityLogs({
      email: email || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      eventType: eventType || undefined,
      success: success || undefined,
      page: p,
    })
    setEntries(result.data)
    setTotal(result.total)
    setLoading(false)
  }

  const totalPages = Math.ceil(total / 50)

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Usuario / Correo</label>
          <input
            type="text"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Buscar..."
            className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text placeholder:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Fecha desde</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 [color-scheme:dark]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Fecha hasta</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 [color-scheme:dark]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Tipo de evento</label>
          <select
            value={eventType}
            onChange={e => setEventType(e.target.value)}
            className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
          >
            <option value="">Todos</option>
            <option value="LOGIN_SUCCESS">Inicio de sesión exitoso</option>
            <option value="LOGIN_FAILED">Inicio de sesión fallido</option>
            <option value="LOGOUT">Cierre de sesión</option>
            <option value="PASSWORD_CHANGE">Cambio de contraseña</option>
            <option value="PASSWORD_CHANGE_FORCED">Cambio obligatorio de contraseña</option>
            <option value="SESSION_EXPIRED">Sesión expirada</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Resultado</label>
          <select
            value={success}
            onChange={e => setSuccess(e.target.value)}
            className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
          >
            <option value="">Todos</option>
            <option value="true">Exitoso</option>
            <option value="false">Fallido</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            className="w-full h-10 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-semibold transition-colors"
          >
            Buscar
          </button>
        </div>
      </form>

      {!searched && !loading && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Complete los filtros y presione Buscar para consultar.</p>
        </div>
      )}

      {loading && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Consultando...</p>
        </div>
      )}

      {!loading && searched && entries.length === 0 && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No se encontraron registros.</p>
        </div>
      )}

      {!loading && searched && entries.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-2xl border border-white/8 bg-theme-text/5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-xs text-theme-accent/60 uppercase tracking-wider">
                  <th className="text-left py-3 px-4 font-medium">Fecha</th>
                  <th className="text-left py-3 px-4 font-medium">Usuario / Correo</th>
                  <th className="text-left py-3 px-4 font-medium">Evento</th>
                  <th className="text-left py-3 px-4 font-medium">Resultado</th>
                  <th className="text-left py-3 px-4 font-medium">IP</th>
                  <th className="text-left py-3 px-4 font-medium">Navegador</th>
                  <th className="text-right py-3 px-4 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-theme-border hover:bg-white/3 transition-colors">
                    <td className="py-3 px-4 text-theme-text-accent/80 whitespace-nowrap text-xs">
                      {new Date(entry.created_at).toLocaleString('es-CL')}
                    </td>
                    <td className="py-3 px-4 text-theme-text-accent/80 text-xs">
                      {entry.email || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <span className={cn('text-xs font-semibold', eventColors[entry.event_type] ?? 'text-theme-text-muted')}>
                        {eventTypeMap[entry.event_type] ?? entry.event_type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {entry.success ? (
                        <span className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-accent border-theme-accent/20">Exitoso</span>
                      ) : (
                        <span className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-500 border-red-500/20">Fallido</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-theme-text-muted/60 text-xs font-mono">
                      {entry.ip_address || '—'}
                    </td>
                    <td className="py-3 px-4 text-theme-text-muted/50 text-[11px] max-w-[150px] truncate" title={entry.user_agent || ''}>
                      {entry.user_agent ? entry.user_agent.split('/')[0] || entry.user_agent.slice(0, 30) : '—'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => setDetail(entry)}
                        className="text-xs text-theme-accent/70 hover:text-theme-text-muted transition-colors"
                      >
                        Ver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 text-xs">
              <button
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
                className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Anterior
              </button>
              <span className="text-theme-text-muted/50 px-2">
                Página {page} de {totalPages} ({total} registros)
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
                className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}

      {detail && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={() => setDetail(null)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-theme-bg border-l border-theme-border shadow-2xl overflow-y-auto">
            <div className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-theme-text">Detalle del Evento</h2>
                <button onClick={() => setDetail(null)} className="text-theme-accent/70 hover:text-theme-text text-xl leading-none">&times;</button>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-theme-accent/60">Fecha</span>
                <span className="text-theme-text-accent/90">{new Date(detail.created_at).toLocaleString('es-CL')}</span>
                <span className="text-theme-accent/60">Correo</span>
                <span className="text-theme-text-accent/90">{detail.email || '—'}</span>
                <span className="text-theme-accent/60">Evento</span>
                <span className={cn('font-semibold', eventColors[detail.event_type])}>{eventTypeMap[detail.event_type] ?? detail.event_type}</span>
                <span className="text-theme-accent/60">Resultado</span>
                <span className="text-theme-text-accent/90">{detail.success ? 'Exitoso' : 'Fallido'}</span>
                <span className="text-theme-accent/60">IP</span>
                <span className="text-theme-text-accent/90 font-mono">{detail.ip_address || '—'}</span>
                <span className="text-theme-accent/60">Navegador</span>
                <span className="text-theme-text-accent/90 text-[11px] break-words">{detail.user_agent || '—'}</span>
                {detail.description && (
                  <>
                    <span className="text-theme-accent/60">Descripción</span>
                    <span className="text-theme-text-accent/90">{detail.description}</span>
                  </>
                )}
              </div>

              {detail.metadata && Object.keys(detail.metadata).length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-theme-accent/80 uppercase tracking-wider">Metadatos</h4>
                  <pre className="bg-black/30 rounded-xl p-4 overflow-x-auto text-xs text-theme-text-muted/80 font-mono leading-relaxed max-h-60 overflow-y-auto">
                    {JSON.stringify(detail.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
