'use client'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'

const NAVIGATION_EVENT = 'inventarios:navigation-start'

export function notifyInventoryNavigation(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAVIGATION_EVENT))
}

export function InventoryNavigationFeedback() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const currentUrl = `${pathname}?${searchParams.toString()}`

  useEffect(() => {
    const handleNavigationStart = () => setPendingUrl(`${window.location.pathname}?${window.location.search.slice(1)}`)
    const handleLinkClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (!(event.target instanceof Element)) return
      const link = event.target.closest('a[href]')
      if (!link || link.getAttribute('target') === '_blank') return
      const href = link.getAttribute('href')
      if (!href || !href.startsWith('/dashboard/inventarios')) return
      const destination = new URL(href, window.location.origin)
      if (destination.href === window.location.href) return
      setPendingUrl(`${window.location.pathname}?${window.location.search.slice(1)}`)
    }

    window.addEventListener(NAVIGATION_EVENT, handleNavigationStart)
    document.addEventListener('click', handleLinkClick, true)
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, handleNavigationStart)
      document.removeEventListener('click', handleLinkClick, true)
    }
  }, [])

  if (pendingUrl !== currentUrl) return null

  return (
    <>
      <div className="fixed inset-x-0 top-12 z-[1000] h-0.5 bg-theme-accent/20">
        <div className="h-full w-1/3 animate-pulse bg-theme-accent" />
      </div>
      <div role="status" aria-live="polite" className="fixed right-4 top-14 z-[1000] inline-flex items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-[11px] font-medium text-theme-text-muted shadow-sm">
        <Loader2 className="h-3 w-3 animate-spin text-theme-accent" />
        Cargando…
      </div>
    </>
  )
}
