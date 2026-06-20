'use client'

import { useState, useEffect } from 'react'
import { getAuditLogs, getAuditUsers, getAuditFilterOptions, type AuditEntry } from '@/app/actions/audit'
import { cn } from '@/lib/utils'

const actionMap: Record<string, string> = {
  INSERT: 'Creación',
  UPDATE: 'Modificación',
  DELETE: 'Eliminación',
}

const severityMap: Record<string, string> = {
  INFO: 'Informativo',
  WARNING: 'Advertencia',
  CRITICAL: 'Crítico',
}

const severityStyle: Record<string, string> = {
  CRITICAL: 'bg-red-500/15 text-red-500 border-red-500/20',
  INFO: 'bg-theme-accent-hover/10 text-theme-accent border-theme-accent/20',
}

const actionStyle: Record<string, string> = {
  INSERT: 'text-theme-accent',
  UPDATE: 'text-amber-500',
  DELETE: 'text-red-500',
}

export function AuditView() {
  const [users, setUsers] = useState<{ id: string; nombre: string; apellido: string; email: string }[]>([])
  const [filterOptions, setFilterOptions] = useState<{ modules: string[]; severities: string[]; actions: string[] }>({
    modules: [], severities: [], actions: [],
  })

  const [selectedUser, setSelectedUser] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [moduleCode, setModuleCode] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [search, setSearch] = useState('')

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<AuditEntry | null>(null)
  const [detailTab, setDetailTab] = useState<'new' | 'old' | 'meta'>('new')

  useEffect(() => {
    getAuditUsers().then(setUsers)
    getAuditFilterOptions().then(setFilterOptions)
  }, [])

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault()
    if (!selectedUser) return
    setLoading(true)
    setPage(1)
    setSearched(true)
    const result = await getAuditLogs({
      performedBy: selectedUser,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      moduleCode: moduleCode || undefined,
      action: actionFilter || undefined,
      severity: severityFilter || undefined,
      search: search || undefined,
      page: 1,
    })
    setEntries(result.data)
    setTotal(result.total)
    setLoading(false)
  }

  async function goToPage(p: number) {
    if (!selectedUser) return
    setLoading(true)
    setPage(p)
    const result = await getAuditLogs({
      performedBy: selectedUser,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      moduleCode: moduleCode || undefined,
      action: actionFilter || undefined,
      severity: severityFilter || undefined,
      search: search || undefined,
      page: p,
    })
    setEntries(result.data)
    setTotal(result.total)
    setLoading(false)
  }

  const totalPages = Math.ceil(total / 50)

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Usuario *</label>
            <select
              value={selectedUser}
              onChange={e => setSelectedUser(e.target.value)}
              required
              className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
            >
              <option value="">Seleccionar usuario</option>
              {users.map(u => (
                <option key={u.id} value={u.id} className="bg-theme-surface">
                  {u.nombre} {u.apellido} — {u.email}
                </option>
              ))}
            </select>
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
            <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Módulo</label>
            <select
              value={moduleCode}
              onChange={e => setModuleCode(e.target.value)}
              className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
            >
              <option value="">Todos</option>
              {filterOptions.modules.map(m => (
                <option key={m} value={m} className="bg-theme-surface">{m === 'PORTAL' ? 'Portal' : m}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Acción</label>
            <select
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
              className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
            >
              <option value="">Todas</option>
              <option value="INSERT">Creación</option>
              <option value="UPDATE">Modificación</option>
              <option value="DELETE">Eliminación</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Severidad</label>
            <select
              value={severityFilter}
              onChange={e => setSeverityFilter(e.target.value)}
              className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
            >
              <option value="">Todas</option>
              <option value="INFO">Informativo</option>
              <option value="WARNING">Advertencia</option>
              <option value="CRITICAL">Crítico</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-theme-accent/80 mb-1.5 uppercase tracking-wider">Tabla / Evento</label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar..."
              className="w-full h-10 rounded-xl border border-theme-border bg-theme-text/5 px-3 text-sm text-theme-text placeholder:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"
            />
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={!selectedUser}
              className="w-full h-10 rounded-xl bg-theme-accent hover:bg-theme-accent-hover disabled:bg-theme-text/10 disabled:text-theme-accent-hover/50 text-white text-sm font-semibold transition-colors"
            >
              Buscar
            </button>
          </div>
        </div>
      </form>

      {!searched && !loading && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">
            Debe seleccionar un usuario para consultar la auditoría.
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Consultando...</p>
        </div>
      )}

      {!loading && searched && entries.length === 0 && (
        <div className="rounded-2xl border border-white/8 bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No se encontraron registros para este usuario.</p>
        </div>
      )}

      {!loading && searched && entries.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-2xl border border-white/8 bg-theme-text/5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-xs text-theme-accent/60 uppercase tracking-wider">
                  <th className="text-left py-3 px-4 font-medium">Fecha</th>
                  <th className="text-left py-3 px-4 font-medium">Módulo</th>
                  <th className="text-left py-3 px-4 font-medium">Sección</th>
                  <th className="text-left py-3 px-4 font-medium">Acción</th>
                  <th className="text-left py-3 px-4 font-medium">Evento</th>
                  <th className="text-left py-3 px-4 font-medium">Severidad</th>
                  <th className="text-right py-3 px-4 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-theme-border hover:bg-white/3 transition-colors">
                    <td className="py-3 px-4 text-theme-text-accent/80 whitespace-nowrap text-xs">
                      {new Date(entry.performed_at).toLocaleString('es-CL')}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-[11px] font-semibold text-theme-accent/80 uppercase tracking-wider">
                        {entry.module_code === 'PORTAL' ? 'Portal' : entry.module_code}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-theme-text-accent/80 text-xs">
                      {entry.table_name === 'users' ? 'Usuarios'
                        : entry.table_name === 'roles' ? 'Roles'
                        : entry.table_name === 'permissions' ? 'Permisos'
                        : entry.table_name === 'modules' ? 'Módulos'
                        : entry.table_name === 'role_permissions' ? 'Permisos de rol'
                        : entry.table_name === 'user_permissions' ? 'Permisos de usuario'
                        : entry.table_name === 'user_modules' ? 'Módulos de usuario'
                        : entry.table_name}
                    </td>
                    <td className="py-3 px-4">
                      <span className={cn('text-xs font-semibold', actionStyle[entry.action] ?? 'text-theme-text-muted')}>
                        {actionMap[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-theme-text-muted/60 text-xs font-mono">
                      {entry.event_type
                        .replace('_INSERT', ' → Creación')
                        .replace('_UPDATE', ' → Modificación')
                        .replace('_DELETE', ' → Eliminación')}
                    </td>
                    <td className="py-3 px-4">
                      <span className={cn(
                        'inline-block text-[11px] font-semibold px-2 py-0.5 rounded border',
                        severityStyle[entry.severity] ?? 'bg-theme-accent-hover/5 text-theme-accent border-theme-accent/10'
                      )}>
                        {severityMap[entry.severity] ?? entry.severity}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => { setDetail(entry); setDetailTab('new') }}
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
                <h2 className="text-lg font-bold text-theme-text">Detalle de Auditoría</h2>
                <button onClick={() => setDetail(null)} className="text-theme-accent/70 hover:text-theme-text text-xl leading-none">&times;</button>
              </div>

              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <span className="text-theme-accent/60">Fecha</span>
                  <span className="text-theme-text-accent/90">{new Date(detail.performed_at).toLocaleString('es-CL')}</span>
                  <span className="text-theme-accent/60">Usuario</span>
                  <span className="text-theme-text-accent/90">{detail.performed_by_name ?? '—'}</span>
                  <span className="text-theme-accent/60">Módulo</span>
                  <span className="text-theme-text-accent/90">{detail.module_code === 'PORTAL' ? 'Portal' : detail.module_code}</span>
                  <span className="text-theme-accent/60">Sección</span>
                  <span className="text-theme-text-accent/90">{detail.schema_name}.{detail.table_name}</span>
                  <span className="text-theme-accent/60">Acción</span>
                  <span className={cn('font-semibold', actionStyle[detail.action])}>{actionMap[detail.action] ?? detail.action}</span>
                  <span className="text-theme-accent/60">Evento</span>
                  <span className="text-theme-text-accent/90 font-mono text-[11px]">{detail.event_type}</span>
                  <span className="text-theme-accent/60">Severidad</span>
                  <span>
                    <span className={cn(
                      'inline-block text-[11px] font-semibold px-2 py-0.5 rounded border',
                      severityStyle[detail.severity] ?? 'bg-theme-accent-hover/5 text-theme-accent border-theme-accent/10'
                    )}>
                      {severityMap[detail.severity] ?? detail.severity}
                    </span>
                  </span>
                </div>
              </div>

              <div className="flex gap-2 border-b border-theme-border pb-2">
                {[
                  { key: 'new', label: 'Datos nuevos' },
                  { key: 'old', label: 'Datos anteriores' },
                  { key: 'meta', label: 'Metadatos' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setDetailTab(tab.key as typeof detailTab)}
                    className={cn(
                      'text-xs font-medium px-3 py-1.5 rounded-lg transition-colors',
                      detailTab === tab.key ? 'bg-theme-text/10 text-theme-text' : 'text-theme-accent/60 hover:text-theme-text'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <pre className="bg-black/30 rounded-xl p-4 overflow-x-auto text-xs text-theme-text-muted/80 font-mono leading-relaxed max-h-96 overflow-y-auto">
                {JSON.stringify(
                  detailTab === 'new' ? detail.new_data
                    : detailTab === 'old' ? detail.old_data
                    : detail.metadata,
                  null, 2
                )}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
