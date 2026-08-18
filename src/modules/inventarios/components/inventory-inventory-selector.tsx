'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Boxes, X } from 'lucide-react'
import { InventoryCombobox, type InventoryComboboxOption } from '@/modules/inventarios/components/inventory-combobox'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'

export interface InventorySelectorOption {
  id: string
  name: string
}

interface InventorySelectorProps {
  inventories: InventorySelectorOption[]
  value: string
}

export function InventorySelector({ inventories, value }: InventorySelectorProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const apply = (next: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (!next) params.delete('inventoryId')
    else params.set('inventoryId', next)
    const qs = params.toString()
    notifyInventoryNavigation()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  const options: InventoryComboboxOption[] = [
    ...inventories.map(inv => ({ value: inv.id, label: inv.name })),
    { value: 'all', label: 'Todas las bodegas' },
  ]

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2 py-1.5 shadow-sm">
      <Boxes className="h-4 w-4 shrink-0 text-theme-text-muted/60" />
      <span className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted/70">Inventario</span>
      <InventoryCombobox
        options={options}
        value={value}
        onSelect={apply}
        placeholder="Buscar inventario…"
        ariaLabel="Seleccionar inventario"
        className="min-w-[200px] max-w-[340px] flex-1"
      />
      {value && (
        <button
          type="button"
          onClick={() => apply('')}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
        >
          <X className="h-3 w-3" />
          Limpiar
        </button>
      )}
    </div>
  )
}
