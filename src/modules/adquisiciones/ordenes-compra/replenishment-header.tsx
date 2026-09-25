'use client'

import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'

interface ReplenishmentHeaderProps {
  busy: boolean
  disabled: boolean
  onBack?: () => void
  onRefresh: () => void
  parameterContent?: ReactNode
}

export function ReplenishmentHeader({ busy, disabled, onBack, onRefresh, parameterContent }: ReplenishmentHeaderProps) {
  return (
    <div className="shrink-0 border-b border-[#D1C7BD] bg-[#EFE9E1] px-5 py-1.5">
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-md border border-[#D1C7BD] bg-[#EFE9E1] p-1.5 text-[#AC9C8D] transition-colors hover:border-[#72383D]/40 hover:text-[#72383D]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
        </div>
        {parameterContent && <div className="order-2 min-w-0 flex-1 basis-full lg:order-none lg:basis-auto">{parameterContent}</div>}
        <button
          onClick={onRefresh}
          disabled={disabled}
          title={disabled && !busy ? 'Aplica una consulta antes de actualizar' : undefined}
          className="order-3 ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-3 text-xs font-semibold text-[#72383D] transition hover:border-[#72383D]/50 hover:bg-[#D1C7BD]/40 disabled:cursor-not-allowed disabled:opacity-50 lg:order-none"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Actualizar
        </button>
      </div>
    </div>
  )
}
