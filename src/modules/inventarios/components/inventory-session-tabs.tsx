'use client'

import { useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'

export interface InventoryTab {
  id: string
  label: string
}

interface InventorySessionTabsProps {
  tabs: InventoryTab[]
}

export function InventorySessionTabs({ tabs }: InventorySessionTabsProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activeTab = searchParams.get('tab') ?? (tabs[0]?.id ?? '')

  const handleTabChange = useCallback((tabId: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tabId)
    router.replace(`${pathname}?${params.toString()}`)
  }, [router, pathname, searchParams])

  return (
    <div role="tablist" aria-label="Secciones de conteo" className="flex gap-1 overflow-x-auto border-b border-theme-border">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => handleTabChange(tab.id)}
          className={cn(
            'shrink-0 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            activeTab === tab.id
              ? 'border-theme-accent text-theme-accent'
              : 'border-transparent text-theme-text-muted hover:text-theme-text'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
