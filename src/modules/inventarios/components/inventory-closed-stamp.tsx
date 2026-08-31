interface InventoryClosedStampProps {
  className?: string
}

export function InventoryClosedStamp({ className = '' }: InventoryClosedStampProps) {
  return (
    <div
      aria-label="Inventario cerrado"
      className={`pointer-events-none absolute z-10 flex items-center justify-center border-y-2 border-red-600/45 bg-red-600/10 px-8 py-1.5 text-2xl font-black tracking-[0.28em] text-red-700/75 shadow-sm dark:border-red-400/45 dark:bg-red-400/10 dark:text-red-300/75 sm:text-3xl ${className}`}
    >
      CERRADO
    </div>
  )
}
