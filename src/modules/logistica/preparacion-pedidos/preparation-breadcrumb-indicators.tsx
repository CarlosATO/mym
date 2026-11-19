'use client'

import { Children, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const TARGET_ID = 'preparation-breadcrumb-kpis'

/** Keeps the live board indicators in the existing breadcrumb, without another fixed row. */
export function PreparationBreadcrumbIndicators({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const indicators = Children.toArray(children)

  useEffect(() => {
    const existing = document.getElementById(TARGET_ID)
    if (existing) {
      setTarget(existing)
      return
    }
    const observer = new MutationObserver(() => {
      const found = document.getElementById(TARGET_ID)
      if (found) {
        setTarget(found)
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  const barContent = (
    <div className="flex min-w-0 items-center justify-end gap-3">
      {indicators.map((indicator, index) => (
        <div key={index} className={`shrink-0 ${index === 0 ? 'hidden md:block' : index === 1 ? 'hidden lg:block' : index < 4 ? 'hidden xl:block' : 'hidden 2xl:block'}`}>
          {indicator}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        aria-controls="preparation-kpi-details"
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-sky-700 2xl:hidden"
      >
        Indicadores {expanded ? '−' : '+'}
      </button>
      {action}
    </div>
  )

  return <>
    {target && createPortal(barContent, target)}
    {!target && (
      <div className="flex flex-wrap items-center justify-end gap-3 border-b border-slate-200 bg-white px-3 py-2">
        {barContent}
      </div>
    )}
    {expanded && (
      <div id="preparation-kpi-details" className="flex-none border-b border-slate-200 bg-white px-3 py-2 2xl:hidden">
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      </div>
    )}
  </>
}
