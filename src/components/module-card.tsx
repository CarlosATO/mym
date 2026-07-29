'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'
import * as LucideIcons from 'lucide-react'
import type { Modulo } from '@/lib/types'

interface ModuleCardProps {
  module: Modulo
  disabled?: boolean
}

function getIcon(iconName: string) {
  const Icon = (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[iconName]
  return Icon ?? LucideIcons.Box
}

function getDisplayModule(module: Modulo) {
  if (module.route === '/dashboard/logistica' || module.code === 'logistica') {
    return {
      name: 'WMS · Logística de Bodegas',
      description: 'Gestión de bodegas, rutas, despachos, movimientos e inventario.'
    }
  }

  return {
    name: module.name,
    description: module.description
  }
}

export function ModuleCard({ module, disabled }: ModuleCardProps) {
  const Icon = getIcon(module.icon)
  const displayModule = getDisplayModule(module)
  const route = typeof module.route === 'string' && module.route.trim().length > 0
    ? module.route.trim()
    : null
  const isDisabled = disabled || route === null

  const content = (
    <div
      className={cn(
        'group flex items-center gap-4 rounded-xl border px-4 py-3.5 transition-all duration-200',
        isDisabled
          ? 'border-theme-border bg-theme-text/3 opacity-50 cursor-default'
          : 'border-theme-border bg-theme-text/5 hover:bg-theme-text/10 hover:border-theme-border-accent hover:shadow-md hover:shadow-theme-bg/30 cursor-pointer'
      )}
    >
      {/* Icono */}
      <div className={cn(
        'flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-200',
        isDisabled
          ? 'bg-theme-text/5 text-theme-text-muted/40'
          : 'bg-theme-text/8 text-theme-text-muted group-hover:text-theme-accent group-hover:bg-theme-accent/10'
      )}>
        <Icon className="h-4 w-4" />
      </div>

      {/* Texto */}
      <div className="min-w-0 flex-1">
        <p className={cn(
          'text-sm font-semibold leading-tight truncate',
          isDisabled ? 'text-theme-text/40' : 'text-theme-text'
        )}>
          {displayModule.name}
        </p>
        {displayModule.description && (
          <p className={cn(
            'text-xs mt-0.5 leading-snug line-clamp-1',
            isDisabled ? 'text-theme-text-muted/30' : 'text-theme-text-muted/60'
          )}>
            {displayModule.description}
          </p>
        )}
      </div>

      {/* Indicador derecho */}
      {isDisabled ? (
        <span className="flex-shrink-0 text-[10px] font-medium text-theme-text-muted/40 uppercase tracking-wider">
          Pronto
        </span>
      ) : (
        <LucideIcons.ChevronRight className="flex-shrink-0 h-4 w-4 text-theme-text-muted/40 group-hover:text-theme-accent group-hover:translate-x-0.5 transition-all duration-200" />
      )}
    </div>
  )

  if (isDisabled || route === null) {
    return <div>{content}</div>
  }

  return (
    <Link href={route} className="block">
      {content}
    </Link>
  )
}
