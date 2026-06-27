'use client'

import Link from 'next/link'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

interface Tab {
  id: string
  label: string
}

interface ModuleTabsProps {
  tabs: Tab[]
  activeTab: string
  onTabChange: (tabId: string) => void
}

export function ModuleTabs({ tabs, activeTab, onTabChange }: ModuleTabsProps) {
  return (
    <div className="fixed top-12 left-0 right-0 z-20 h-9 bg-theme-surface/60 backdrop-blur-sm border-b border-theme-border/60">
      <div className="h-full max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between gap-4">
        {/* Pestañas */}
        <nav className="flex items-center h-full overflow-x-auto hide-scrollbar">
          {tabs.map(tab => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "h-full px-4 text-xs font-semibold border-b-2 transition-all shrink-0 flex items-center justify-center gap-1.5 relative",
                  isActive
                    ? "border-theme-accent text-theme-text bg-theme-accent/12 shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)]"
                    : "border-transparent text-theme-text-muted hover:text-theme-text hover:border-theme-border/60 hover:bg-theme-text/5 font-medium"
                )}
              >
                {isActive && <span className="absolute left-2 right-2 top-0 h-px rounded-full bg-theme-accent/70" />}
                {tab.label}
              </button>
            )
          })}
        </nav>

        {/* Retorno al Portal */}
        <Link
          href="/dashboard"
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold text-theme-text hover:text-theme-text hover:bg-white/5 transition-all shrink-0 border border-white/10 hover:border-white/20 bg-theme-surface/50"
        >
          <LucideIcons.ArrowLeft className="h-3 w-3 text-theme-accent" />
          <span>Portal</span>
        </Link>
      </div>
    </div>
  )
}
