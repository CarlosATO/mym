'use client'

import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export interface RibbonAction {
  id: string
  label: string
  icon?: string
  onClick?: () => void
  disabled?: boolean
  upcoming?: boolean
}

interface ModuleRibbonProps {
  actions: RibbonAction[]
  activeActionId?: string
}

function getIcon(iconName?: string) {
  if (!iconName) return LucideIcons.Box
  const Icon = (LucideIcons as Record<string, any>)[iconName]
  return Icon ?? LucideIcons.Box
}

export function ModuleRibbon({ actions, activeActionId }: ModuleRibbonProps) {
  if (!actions || actions.length === 0) return null

  return (
    <div className="fixed top-[84px] left-0 right-0 z-15 h-10 bg-theme-surface/85 border-b border-theme-border/60 py-1 shadow-sm">
      {/* Contenedor con gradiente de desborde a la derecha para indicar scroll */}
      <div className="max-w-7xl mx-auto px-4 lg:px-6 h-full relative overflow-hidden">
        <div className="h-full flex items-center gap-1.5 overflow-x-auto hide-scrollbar scroll-smooth pr-10">
          {actions.map(action => {
            const Icon = getIcon(action.icon)
            const isSelected = activeActionId === action.id
            const isDisabled = action.disabled || action.upcoming

            return (
              <button
                key={action.id}
                onClick={() => {
                  if (!isDisabled && action.onClick) {
                    action.onClick()
                  }
                }}
                disabled={isDisabled}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-0.5 rounded-lg text-xs font-semibold transition-all shrink-0 border relative",
                  isSelected
                    ? "bg-theme-accent/18 border-theme-accent/60 text-theme-text shadow-sm ring-1 ring-theme-accent/25"
                    : "bg-theme-text/5 border-theme-border/60 text-theme-text-muted hover:text-theme-text hover:border-theme-border-accent/50 hover:bg-theme-text/10",
                  isDisabled && "opacity-65 cursor-not-allowed hover:bg-white/5 hover:border-white/10 text-theme-text-muted"
                )}
              >
                {isSelected && <span className="absolute left-1 top-1 bottom-1 w-0.5 rounded-full bg-theme-accent" />}
                <Icon className={cn("h-3 w-3", isSelected ? "text-theme-accent" : "text-theme-text-muted")} />
                <span>{action.label}</span>
                {action.upcoming && (
                  <span className="text-[7px] font-bold bg-theme-accent/20 text-theme-accent border border-theme-accent/25 px-1 rounded-sm uppercase tracking-wider scale-90 origin-right">
                    Próx.
                  </span>
                )}
              </button>
            )
          })}
        </div>
        
        {/* Gradiente sutil indicador de scroll horizontal */}
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-theme-surface/90 to-transparent pointer-events-none" />
      </div>
    </div>
  )
}
