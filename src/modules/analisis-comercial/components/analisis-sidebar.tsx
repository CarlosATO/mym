'use client'

import { cn } from '@/lib/utils'
import * as LucideIcons from 'lucide-react'
import { useSidebarSection, setSidebarSection } from '../hooks/use-sidebar-section'

interface SidebarSection {
  id: string
  label: string
  icon: string
  disabled?: boolean
}

const SECTIONS: SidebarSection[] = [
  { id: 'vista-general', label: 'Vista general', icon: 'LayoutDashboard' },
  { id: 'proveedor-360', label: 'Proveedor 360', icon: 'Truck' },
  { id: 'producto-360', label: 'Producto 360', icon: 'Package' },
  { id: 'clientes', label: 'Clientes', icon: 'Users' },
  { id: 'recepcion-vs-venta', label: 'Recepción vs venta', icon: 'ArrowLeftRight', disabled: true },
  { id: 'predictivo', label: 'Predictivo', icon: 'TrendingUp', disabled: true },
]

function getIcon(iconName: string) {
  const Icon = (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[iconName]
  return Icon || LucideIcons.Box
}

interface AnalisisSidebarProps {
  expanded: boolean
}

export function AnalisisSidebar({ expanded }: AnalisisSidebarProps) {
  const { activeSection } = useSidebarSection()

  return (
    <aside
      className={cn(
        'border-r border-theme-border bg-theme-surface/40 backdrop-blur-sm transition-all duration-300 ease-in-out flex flex-col shrink-0',
        expanded ? 'w-52' : 'w-12'
      )}
    >
      <nav className="flex flex-col gap-0.5 p-1.5 pt-2">
        {SECTIONS.map((section) => {
          const Icon = getIcon(section.icon)
          const isActive = activeSection === section.id

          return (
            <button
              key={section.id}
              onClick={() => {
                if (!section.disabled) setSidebarSection(section.id)
              }}
              disabled={section.disabled}
              title={section.label}
              className={cn(
                'flex items-center gap-3 rounded-lg transition-all duration-200',
                expanded ? 'px-3 py-2' : 'px-2 py-2 justify-center',
                isActive && !section.disabled
                  ? 'bg-theme-accent/15 text-theme-text border border-theme-border-accent shadow-sm'
                  : section.disabled
                    ? 'text-theme-text-muted/40 cursor-not-allowed opacity-50'
                    : 'text-theme-text-muted hover:text-theme-text hover:bg-theme-surface-hover border border-transparent'
              )}
            >
              <Icon className={cn('shrink-0', expanded ? 'h-4 w-4' : 'h-4 w-4')} />
              {expanded && (
                <div className="flex items-center justify-between w-full min-w-0">
                  <span className={cn(
                    'text-xs font-semibold truncate',
                    section.disabled && 'italic'
                  )}>
                    {section.label}
                  </span>
                  {section.disabled && (
                    <LucideIcons.Clock className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                  )}
                </div>
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto p-1.5">
        <div className={cn(
          'border-t border-theme-border pt-2 flex items-center gap-2',
          expanded ? 'px-3 py-1' : 'px-1 py-1 justify-center'
        )}>
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500/70 shrink-0" />
          {expanded && (
            <span className="text-[10px] text-theme-text-muted/60 truncate font-medium">
              Recepciones pendientes
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}
