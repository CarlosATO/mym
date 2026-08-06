'use client'

import { useCallback, useRef, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
import { searchInventoryVariants, type VariantOption } from '@/app/actions/inventarios/sessions'
import type { ScopeData } from '@/modules/inventarios/lib/wizard'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

interface ScopeStepProps {
  companyId: string
  scopeMode: 'GENERAL' | 'PARTIAL'
  data: ScopeData
  onChange: (data: ScopeData) => void
}

export function InventoryScopeStep({ companyId, scopeMode, data, onChange }: ScopeStepProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VariantOption[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchSeq = useRef(0)

  const runSearch = useCallback(async (text: string, targetPage: number) => {
    const seq = ++searchSeq.current
    setLoading(true)
    setError(null)
    const result = await searchInventoryVariants(companyId, text, targetPage, 25)
    if (seq !== searchSeq.current) return
    setLoading(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudieron buscar productos.')
      return
    }
    setResults(result.data.variants)
    setTotal(result.data.total)
    setHasMore(result.data.has_more)
    setPage(result.data.page)
  }, [companyId])

  const toggleVariant = useCallback((id: number) => {
    const exists = data.variant_ids.includes(id)
    const next = exists ? data.variant_ids.filter(v => v !== id) : [...data.variant_ids, id]
    onChange({ variant_ids: next })
  }, [data.variant_ids, onChange])

  const selectedNames = results.filter(r => data.variant_ids.includes(r.bsale_variant_id))

  if (scopeMode === 'GENERAL') {
    return (
      <div className="rounded-lg border border-theme-border bg-theme-text/2 p-5">
        <p className="text-sm font-semibold text-theme-text">Alcance general</p>
        <p className="mt-1 text-sm text-theme-text-muted">
          La sección de conteo incluirá todas las variantes activas del catálogo Bsale de la empresa. No es necesario seleccionar productos.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-theme-text-muted">
        Selecciona los productos que formarán parte de esta sección de conteo parcial. Busca por SKU, nombre o código de barras.
      </p>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
        <input
          value={query}
          onChange={e => {
            const value = e.target.value
            setQuery(value)
            runSearch(value, 1)
          }}
          placeholder="Buscar producto por SKU, nombre o código de barras"
          aria-label="Buscar productos"
          className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
        />
      </div>

      {loading && <InventoryLoadingState compact label="Buscando productos…" />}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!loading && !error && query.trim() === '' && (
        <p className="text-sm text-theme-text-muted/70">Escribe para buscar productos del catálogo.</p>
      )}

      {!loading && query.trim() !== '' && results.length === 0 && (
        <p className="text-sm text-theme-text-muted">No se encontraron productos para tu búsqueda.</p>
      )}

      {results.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-theme-border">
          <ul className="max-h-72 divide-y divide-theme-border/40 overflow-y-auto">
            {results.map(variant => {
              const selected = data.variant_ids.includes(variant.bsale_variant_id)
              return (
                <li key={variant.bsale_variant_id}>
                  <button
                    type="button"
                    onClick={() => toggleVariant(variant.bsale_variant_id)}
                    aria-pressed={selected}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-theme-text/3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-theme-text">{variant.name}</p>
                      <p className="text-xs text-theme-text-muted">
                        <span className="font-mono">{variant.sku}</span>
                        {variant.barcode && <span className="ml-2 font-mono">{variant.barcode}</span>}
                      </p>
                    </div>
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      selected ? 'border-theme-accent bg-theme-accent text-white' : 'border-theme-border'
                    }`}>
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-theme-text-muted">
          <span>{total} producto(s)</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => runSearch(query, page - 1)}
              className="rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-theme-text-muted transition-colors hover:bg-theme-text/5 disabled:opacity-40"
            >
              Anterior
            </button>
            <span>Pág. {page}</span>
            <button
              type="button"
              disabled={!hasMore || loading}
              onClick={() => runSearch(query, page + 1)}
              className="rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-theme-text-muted transition-colors hover:bg-theme-text/5 disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      )}

      {data.variant_ids.length > 0 && (
        <div className="rounded-lg border border-theme-border bg-theme-surface p-3">
          <p className="mb-2 text-xs font-semibold text-theme-text-muted uppercase tracking-wider">
            Productos seleccionados ({data.variant_ids.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selectedNames.map(variant => (
              <span key={variant.bsale_variant_id} className="inline-flex items-center gap-1 rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-xs text-theme-text">
                <span className="font-mono">{variant.sku}</span>
                <button
                  type="button"
                  onClick={() => toggleVariant(variant.bsale_variant_id)}
                  aria-label={`Quitar ${variant.name}`}
                  className="text-theme-text-muted hover:text-theme-text"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
