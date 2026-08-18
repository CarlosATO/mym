'use client'

import { useCallback, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

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
  const [pending, startTransition] = useTransition()

  const handleTabChange = useCallback((tabId: string) => {
    if (pending || tabId === activeTab) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tabId)
    startTransition(() => router.replace(`${pathname}?${params.toString()}`))
  }, [activeTab, pending, pathname, router, searchParams, startTransition])

  return (
    <div aria-busy={pending}>
      <div role="tablist" aria-label="Secciones de conteo" className="flex gap-1 overflow-x-auto border-b border-theme-border">
        {tabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => handleTabChange(tab.id)}
            disabled={pending}
            className={cn(
              'shrink-0 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-70',
              activeTab === tab.id
                ? 'border-theme-accent text-theme-accent'
                : 'border-transparent text-theme-text-muted hover:text-theme-text'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {pending && <InventoryLoadingState compact className="mt-2" label="Cargando sección…" />}
    </div>
  )
}
