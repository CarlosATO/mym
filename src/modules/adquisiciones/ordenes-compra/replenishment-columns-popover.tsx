'use client'

import { RotateCcw, Settings2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { COLUMN_CONFIG_GROUPS, COLUMN_DEFS, type ColumnId } from './replenishment-columns'

interface ReplenishmentColumnsPopoverProps {
  hiddenColumns: Set<string>
  semanasVisible: boolean
  onToggle: (id: ColumnId) => void
  onRestore: () => void
}

export function ReplenishmentColumnsPopover({
  hiddenColumns,
  semanasVisible,
  onToggle,
  onRestore,
}: ReplenishmentColumnsPopoverProps) {
  const isVisible = (id: ColumnId) => (id === 'semanas' ? semanasVisible : !hiddenColumns.has(id))

  return (
    <Popover>
      <PopoverTrigger
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2.5 text-[11px] font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
      >
        <Settings2 className="h-3.5 w-3.5" />
        Columnas
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        {COLUMN_CONFIG_GROUPS.map(group => (
          <div key={group.id} className="mb-1 last:mb-0">
            <p className="px-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted/70">{group.label}</p>
            <div className="flex flex-col">
              {group.columns.map(id => (
                <label
                  key={id}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-theme-text transition hover:bg-theme-text/5"
                >
                  <input
                    type="checkbox"
                    checked={isVisible(id)}
                    onChange={() => onToggle(id)}
                    className="h-3.5 w-3.5 rounded border-theme-border text-theme-accent"
                  />
                  <span className="truncate">{COLUMN_DEFS[id].label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-1 border-t border-theme-border/60 pt-1.5">
          <button
            onClick={onRestore}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
          >
            <RotateCcw className="h-3 w-3" />
            Restaurar vista predeterminada
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
