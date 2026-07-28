'use client'

import Link from 'next/link'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDateRange, setDateRange } from '../hooks/use-date-range'
import { useSidebarSection } from '../hooks/use-sidebar-section'

interface AnalisisTopbarProps {
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  onToggleSidebar: () => void
  isSidebarExpanded: boolean
}

export function AnalisisTopbar({ onToggleSidebar, isSidebarExpanded }: AnalisisTopbarProps) {
  const { dateFrom, dateTo } = useDateRange()
  const { activeSection } = useSidebarSection()
  const showDateFilter = activeSection !== 'proveedor-360'

  return (
    <header className="fixed top-0 left-0 right-0 z-30 h-9 bg-theme-surface/70 backdrop-blur-md border-b border-theme-border/60">
      <div className="h-full px-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onToggleSidebar}
            className="flex items-center justify-center w-7 h-7 rounded-md text-theme-text-muted hover:text-theme-text hover:bg-theme-surface-hover transition-colors shrink-0"
            title={isSidebarExpanded ? 'Contraer sidebar' : 'Expandir sidebar'}
          >
            <LucideIcons.PanelLeftClose className={cn(
              'h-4 w-4 transition-transform duration-200',
              !isSidebarExpanded && 'rotate-180'
            )} />
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/dashboard"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-theme-text-muted hover:text-theme-text hover:bg-theme-surface-hover transition-colors shrink-0"
            >
              <LucideIcons.ArrowLeft className="h-3 w-3" />
              <span>Portal</span>
            </Link>

            <div className="w-px h-3 bg-theme-border/60 shrink-0" />

            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-bold text-theme-text truncate">
                Análisis Comercial
              </span>
              <span className="text-[9px] text-theme-text-muted/50 hidden sm:inline truncate">
                MYM · PetGroup
              </span>
            </div>
          </div>
        </div>

        {showDateFilter && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-theme-accent/8 border border-theme-accent/15">
              <LucideIcons.CalendarDays className="h-3 w-3 text-theme-accent" />
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateRange(e.target.value, dateTo)}
                className="w-20 bg-transparent text-[10px] font-semibold text-theme-text-muted outline-none border-none p-0 [color-scheme:dark]"
              />
              <span className="text-[10px] text-theme-text-muted/50">→</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateRange(dateFrom, e.target.value)}
                className="w-20 bg-transparent text-[10px] font-semibold text-theme-text-muted outline-none border-none p-0 [color-scheme:dark]"
              />
            </div>

            <div className="w-px h-3 bg-theme-border/60 shrink-0" />

            <div className="flex items-center gap-1 text-[10px] text-theme-text-muted/60">
              <LucideIcons.Database className="h-3 w-3" />
              <span className="hidden sm:inline">FE tipo 5</span>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
