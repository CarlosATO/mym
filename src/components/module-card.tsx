'use client'

import Link from 'next/link'
import { createElement } from 'react'
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

const moduleAccents: Record<string, {
  icon: string
  dot: string
  cta: string
  border: string
}> = {
  adquisiciones: {
    icon: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 group-hover:bg-amber-500/15 group-hover:text-amber-500',
    dot: 'bg-amber-500',
    cta: 'text-amber-700 dark:text-amber-300 group-hover:text-amber-500',
    border: 'group-hover:border-amber-500/35',
  },
  logistica: {
    icon: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 group-hover:bg-sky-500/15 group-hover:text-sky-400',
    dot: 'bg-sky-500',
    cta: 'text-sky-700 dark:text-sky-300 group-hover:text-sky-400',
    border: 'group-hover:border-sky-500/35',
  },
  inventarios: {
    icon: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 group-hover:bg-teal-500/15 group-hover:text-teal-400',
    dot: 'bg-teal-500',
    cta: 'text-teal-700 dark:text-teal-300 group-hover:text-teal-400',
    border: 'group-hover:border-teal-500/35',
  },
  comercial: {
    icon: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 group-hover:bg-indigo-500/15 group-hover:text-indigo-400',
    dot: 'bg-indigo-500',
    cta: 'text-indigo-700 dark:text-indigo-300 group-hover:text-indigo-400',
    border: 'group-hover:border-indigo-500/35',
  },
  'analisis-comercial': {
    icon: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 group-hover:bg-violet-500/15 group-hover:text-violet-400',
    dot: 'bg-violet-500',
    cta: 'text-violet-700 dark:text-violet-300 group-hover:text-violet-400',
    border: 'group-hover:border-violet-500/35',
  },
}

export function ModuleCard({ module, disabled }: ModuleCardProps) {
  const Icon = getIcon(module.icon)
  const displayModule = getDisplayModule(module)
  const route = typeof module.route === 'string' && module.route.trim().length > 0
    ? module.route.trim()
    : null
  const isDisabled = disabled || route === null
  const accent = moduleAccents[module.code] ?? {
    icon: 'bg-theme-accent/10 text-theme-text-accent group-hover:bg-theme-accent/15 group-hover:text-theme-accent',
    dot: 'bg-theme-accent',
    cta: 'text-theme-text-accent group-hover:text-theme-accent',
    border: 'group-hover:border-theme-accent/35',
  }

  const content = (
    <div
      className={cn(
        'group relative flex min-h-[156px] flex-col overflow-hidden rounded-xl border p-4 transition-all duration-200',
        isDisabled
          ? 'cursor-default border-theme-border bg-theme-text/3 opacity-50'
          : `cursor-pointer border-theme-border/90 bg-theme-surface shadow-sm hover:-translate-y-0.5 ${accent.border} hover:bg-theme-surface-hover hover:shadow-md hover:shadow-theme-bg/20`
      )}
    >
      <div className={cn('pointer-events-none absolute inset-x-4 top-0 h-px opacity-0 transition-opacity group-hover:opacity-100', accent.dot)} />
      <div className="flex items-start justify-between gap-3">
        <div className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all duration-200',
          isDisabled
            ? 'bg-theme-text/5 text-theme-text-muted/40'
            : accent.icon
        )}>
          {createElement(Icon, { className: 'h-4 w-4' })}
        </div>
        {isDisabled ? (
          <span className="rounded-md border border-theme-border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted/45">Pronto</span>
        ) : (
          <LucideIcons.ArrowUpRight className="h-4 w-4 text-theme-text-muted/35 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        )}
      </div>

      <div className="mt-3 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isDisabled ? 'bg-theme-text-muted/30' : accent.dot)} />
          <p className={cn(
            'truncate text-sm font-semibold leading-tight tracking-tight',
            isDisabled ? 'text-theme-text/40' : 'text-theme-text'
          )}>
            {displayModule.name}
          </p>
        </div>
        <div className="mt-1.5 min-h-[32px]">
          {displayModule.description && (
            <p className={cn(
              'line-clamp-2 text-[11px] leading-relaxed',
              isDisabled ? 'text-theme-text-muted/30' : 'text-theme-text-muted/70'
            )}>
              {displayModule.description}
            </p>
          )}
        </div>
      </div>

      {!isDisabled && (
        <div className={cn('mt-3 flex items-center gap-2 border-t border-theme-border/70 pt-2.5 text-[11px] font-semibold transition-colors', accent.cta)}>
          <span>Ingresar al módulo</span>
          <LucideIcons.ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </div>
      )}
    </div>
  )

  if (isDisabled || route === null) {
    return <div>{content}</div>
  }

  return (
    <Link href={route} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent focus-visible:ring-offset-2 focus-visible:ring-offset-theme-bg" aria-label={`Ingresar a ${displayModule.name}`}>
      {content}
    </Link>
  )
}
