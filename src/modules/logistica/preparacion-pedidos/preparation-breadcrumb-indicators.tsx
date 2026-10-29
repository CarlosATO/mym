'use client'

import { Children, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const subscribe = () => () => {}
const getTarget = () => document.getElementById('preparation-breadcrumb-kpis')
const getServerTarget = () => null

/** Keeps the live board indicators in the existing breadcrumb, without another fixed row. */
export function PreparationBreadcrumbIndicators({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(subscribe, getTarget, getServerTarget)
  const [expanded, setExpanded] = useState(false)
  const indicators = Children.toArray(children)
  return <>
    {target && createPortal(
      <div className="flex min-w-0 items-center justify-end gap-3">
        {indicators.map((indicator, index) => (
          <div key={index} className={`shrink-0 ${index === 0 ? 'hidden md:block' : index === 1 ? 'hidden lg:block' : index < 4 ? 'hidden xl:block' : 'hidden 2xl:block'}`}>
            {indicator}
          </div>
        ))}
        <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls="preparation-kpi-details" className="shrink-0 rounded px-1 text-[10px] font-medium text-[#6B625C] hover:text-[#72383D] 2xl:hidden">
          Indicadores {expanded ? '−' : '+'}
        </button>
      </div>, target)}
    {expanded && <div id="preparation-kpi-details" className="flex-none border-b border-[#D1C7BD] bg-[#FCFBF9] px-3 py-2 2xl:hidden">
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>}
  </>
}
