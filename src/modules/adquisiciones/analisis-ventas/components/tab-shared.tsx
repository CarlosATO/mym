'use client'
// tab-shared.tsx — Componentes y utilidades compartidas entre todos los tabs del Dashboard BI
import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

// ─── Formatters ────────────────────────────────────────────────────────────────

export function fmtMoney(val: number): string {
  if (val == null || isNaN(val)) return '$0'
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(val)
}

export function fmtNumber(val: number): string {
  if (val == null || isNaN(val)) return '0'
  return new Intl.NumberFormat('es-CL').format(val)
}

export function fmtPct(val: number): string {
  if (val == null || isNaN(val)) return '-'
  return `${(val * 100).toFixed(1)}%`
}

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return '-'
  try {
    return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch {
    return '-'
  }
}

// ─── PeriodSelector ────────────────────────────────────────────────────────────

interface PeriodOption { label: string; days: number }

export function PeriodSelector({
  options, value, onChange, label = 'Período de análisis',
}: {
  options: PeriodOption[]; value: number; onChange: (i: number) => void; label?: string
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider">{label}:</span>
      {options.map((opt, i) => (
        <button
          key={i}
          onClick={() => onChange(i)}
          className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-colors ${
            value === i
              ? 'border-theme-primary/60 bg-theme-primary/15 text-theme-text ring-1 ring-theme-primary/20'
              : 'border-theme-border bg-theme-text/5 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── AlertCard ─────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, { border: string; bg: string; text: string; badge: string }> = {
  Alta:  { border: 'border-red-500', bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', badge: 'bg-red-500 text-white' },
  'Media-Alta': { border: 'border-orange-500', bg: 'bg-orange-500/10', text: 'text-orange-600 dark:text-orange-400', badge: 'bg-orange-500 text-white' },
  Media: { border: 'border-amber-500', bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', badge: 'bg-amber-500 text-white' },
  Baja:  { border: 'border-blue-500', bg: 'bg-blue-500/10', text: 'text-blue-600 dark:text-blue-400', badge: 'bg-blue-500 text-white' },
}

export function AlertCard({
  title, body, priority, action, expanded, onToggle, expandLabel, children,
}: {
  title: string; body: string; priority: string; action: string
  expanded: boolean; onToggle: () => void; expandLabel: string; children?: React.ReactNode
}) {
  const colors = PRIORITY_COLORS[priority] || PRIORITY_COLORS['Baja']
  const priorityLabel = priority === 'Alta' ? 'Hallazgo crítico' : priority === 'Baja' ? 'Hallazgo informativo' : 'Hallazgo relevante'

  return (
    <div className={`border-l-4 ${colors.border} ${colors.bg} rounded-r-xl p-4 shadow-sm`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`font-bold text-sm ${colors.text}`}>{title}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.badge}`}>{priorityLabel}</span>
          </div>
          <p className="text-sm text-theme-text leading-relaxed">{body}</p>
          <p className="text-xs text-theme-text-muted mt-1 italic"><strong>Acción sugerida:</strong> {action}</p>
        </div>
      </div>
      <button
        onClick={onToggle}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-theme-primary hover:opacity-80 transition-opacity"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {expandLabel}
      </button>
      {expanded && <div className="mt-2">{children}</div>}
    </div>
  )
}

// ─── KpiCard ───────────────────────────────────────────────────────────────────

export function KpiCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl p-4 flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted">{label}</span>
      <span className="text-xl font-bold text-theme-text">{typeof value === 'number' ? fmtNumber(value) : value}</span>
      {sub && <span className="text-xs text-theme-text-muted">{sub}</span>}
    </div>
  )
}

// ─── DataTable ─────────────────────────────────────────────────────────────────

export interface TableColumn {
  key: string
  label: string
  fmt?: (v: any, row?: any) => React.ReactNode
  right?: boolean
  className?: string
}

export function DataTable({ rows, columns, maxRows = 200 }: { rows: any[]; columns: TableColumn[]; maxRows?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-theme-border">
      <table className="w-full text-xs text-left">
        <thead className="bg-theme-surface sticky top-0 border-b border-theme-border z-10">
          <tr>
            {columns.map(c => (
              <th key={c.key} className={`p-2.5 font-bold uppercase tracking-wider text-theme-text-muted whitespace-nowrap ${c.right ? 'text-right' : ''} ${c.className || ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-theme-border/40">
          {rows.slice(0, maxRows).map((row, i) => (
            <tr key={i} className="hover:bg-theme-text/5 transition-colors">
              {columns.map(c => (
                <td key={c.key} className={`p-2.5 text-theme-text whitespace-nowrap ${c.right ? 'text-right' : ''} ${c.className || ''}`}>
                  {c.fmt ? c.fmt(row[c.key], row) : (row[c.key] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="p-6 text-center text-theme-text-muted">Sin datos para este período.</td></tr>
          )}
        </tbody>
      </table>
      {rows.length > maxRows && (
        <p className="text-center text-xs text-theme-text-muted p-2 border-t border-theme-border">
          Mostrando {maxRows} de {rows.length} productos
        </p>
      )}
    </div>
  )
}
