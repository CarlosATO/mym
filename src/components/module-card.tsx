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

export function ModuleCard({ module, disabled }: ModuleCardProps) {
  const Icon = getIcon(module.icon)

  const content = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border p-6 transition-all duration-300 h-full',
        disabled
          ? 'border-theme-border bg-theme-text/5 opacity-50 cursor-default'
          : 'border-theme-border bg-theme-text/5 backdrop-blur-sm hover:border-theme-accent-hover/30 hover:bg-theme-text/10 hover:shadow-2xl hover:shadow-theme-bg/40 hover:-translate-y-1 cursor-pointer'
      )}
    >
      {/* Brillo de esquina al hover */}
      {!disabled && (
        <div className="absolute top-0 right-0 w-40 h-40 -translate-y-1/3 translate-x-1/3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <div className="w-full h-full bg-gradient-to-br from-theme-accent-hover/15 to-transparent rounded-full" />
        </div>
      )}

      <div className="flex flex-col gap-5">
        <div className={cn(
          'w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-300',
          disabled
            ? 'bg-theme-text/5 text-theme-text-muted'
            : 'bg-gradient-to-br from-theme-accent-hover to-theme-accent text-white shadow-lg shadow-theme-bg/30 group-hover:shadow-xl group-hover:shadow-theme-accent/25 group-hover:scale-105'
        )}>
          <Icon className={cn('h-7 w-7', disabled && 'text-theme-text-muted')} />
        </div>

        <div className="space-y-1.5">
          <h3 className={cn(
            'text-lg font-semibold leading-tight',
            disabled ? 'text-theme-text/40' : 'text-theme-text'
          )}>
            {module.name}
          </h3>
          {module.description && (
            <p className={cn(
              'text-sm leading-relaxed',
              disabled ? 'text-theme-text-muted/40' : 'text-theme-text-muted/70'
            )}>
              {module.description}
            </p>
          )}
        </div>

        {disabled && (
          <div className="flex items-center gap-2 text-amber-500/50 text-xs font-semibold uppercase tracking-wider pt-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Próximamente
          </div>
        )}

        {!disabled && (
          <div className="flex items-center gap-1.5 text-theme-accent font-medium pt-1">
            <span>Disponible</span>
            <LucideIcons.ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
          </div>
        )}
      </div>
    </div>
  )

  if (disabled) {
    return <div className="h-full">{content}</div>
  }

  return (
    <Link href={module.route} className="block h-full">
      {content}
    </Link>
  )
}
