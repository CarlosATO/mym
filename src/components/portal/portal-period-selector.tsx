'use client'

import type { PortalPeriodMode } from '@/app/actions/portal/periods'

export function PortalPeriodSelector({ mode, onChange }: { mode: PortalPeriodMode; onChange: (mode: PortalPeriodMode) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-theme-border/70 bg-theme-surface/60 px-3 py-2">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-theme-text-muted/70">Período de Ventas y Cobranzas</p>
      </div>
      <div className="inline-flex rounded-lg border border-theme-border bg-theme-bg/60 p-0.5" role="group" aria-label="Período de Ventas y Cobranzas">
        {([
          ['CALENDAR_MONTH', 'Mes actual'],
          ['COMMISSIONABLE', 'Período comisionable'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${mode === value ? 'bg-theme-accent text-white shadow-sm' : 'text-theme-text-muted hover:text-theme-text'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
