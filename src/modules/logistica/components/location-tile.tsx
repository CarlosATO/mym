'use client'

import { cn } from '@/lib/utils'
import { Package, MapPin, AlertCircle } from 'lucide-react'

interface LocationTileProps {
  id: string
  code: string
  name: string | null
  aisle: string | null
  rack: string | null
  level: string | null
  position: string | null
  stockCount: number
  itemCount: number
  isIncomplete?: boolean
  isActive?: boolean
  onClick: () => void
  onDoubleClick: () => void
  selected?: boolean
  highlight?: boolean
}

export function LocationTile({
  code,
  name,
  aisle,
  rack,
  level,
  position,
  stockCount,
  itemCount,
  isIncomplete = false,
  isActive = true,
  onClick,
  onDoubleClick,
  selected = false,
  highlight = false
}: LocationTileProps) {
  const isEmpty = stockCount === 0

  let stateLabel = 'Vacía'
  let stateColor = 'border-gray-200 dark:border-gray-800 bg-white dark:bg-theme-surface/50 text-gray-400 dark:text-gray-500 hover:border-gray-300'
  
  if (!isActive) {
    stateLabel = 'Inactiva'
    stateColor = 'border-gray-300 bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-gray-600 opacity-50'
  } else if (isIncomplete) {
    stateLabel = 'Incompleta'
    stateColor = 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-500'
  } else if (!isEmpty) {
    stateLabel = 'Con stock'
    stateColor = 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400'
  }

  const tooltip = [
    `Código: ${code}`,
    name ? `Nombre: ${name}` : null,
    aisle ? `Pasillo: ${aisle}` : null,
    rack ? `Rack: ${rack}` : null,
    level ? `Nivel: ${level}` : null,
    position ? `Posición: ${position}` : null,
    `Estado: ${stateLabel}`
  ].filter(Boolean).join('\n')

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={tooltip}
      className={cn(
        "relative flex flex-col justify-between p-1.5 h-[52px] min-w-[90px] border rounded-md transition-all cursor-pointer select-none",
        stateColor,
        selected && "ring-2 ring-blue-500 border-blue-500 shadow-sm z-10",
        highlight && "animate-in zoom-in duration-500 ring-2 ring-blue-500 shadow-md border-blue-500 z-10"
      )}
    >
      <div className="flex justify-between items-start mb-0.5 gap-1">
        <span className={cn(
          "font-mono text-[10px] font-bold leading-none tracking-tight break-all",
          (code.length > 14) ? "text-[8px]" : "",
          !isActive && "line-through opacity-70"
        )}>
          {code}
        </span>
        {isIncomplete && isActive && <AlertCircle className="w-2.5 h-2.5 shrink-0 text-amber-500" />}
      </div>

      <div className="mt-auto flex items-end justify-between">
        <div className="flex flex-col">
          {!isEmpty ? (
            <div className="flex items-baseline gap-0.5 leading-none">
              <span className="text-[11px] font-black">{stockCount}</span>
              <span className="text-[7px] font-bold uppercase opacity-70">u</span>
            </div>
          ) : (
            <span className="text-[8px] font-semibold opacity-50 flex items-center gap-0.5 leading-none">
              <MapPin className="w-2.5 h-2.5" /> Vacía
            </span>
          )}
        </div>
        
        {!isEmpty && itemCount > 0 && (
          <span className="flex items-center gap-0.5 text-[8px] font-black opacity-80 bg-black/5 dark:bg-white/10 px-1 py-0.5 rounded leading-none">
            <Package className="w-2.5 h-2.5" />
            {itemCount}
          </span>
        )}
      </div>
    </div>
  )
}
