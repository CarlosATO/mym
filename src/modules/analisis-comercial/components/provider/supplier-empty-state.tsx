'use client'

export function SupplierEmptyState() {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface/40 p-8 text-center">
      <p className="text-sm text-theme-text-muted/70">
        Selecciona un proveedor real para ver su relación entre catálogo, ventas, stock y compras disponibles.
      </p>
    </div>
  )
}
