'use client'

import { useEffect, useState, useTransition } from 'react'
import { getAnalysisSuppliers, getSupplierPurchaseSales360 } from '@/app/actions/comercial/analysis/suppliers'
import type { AnalysisSupplierOption, SupplierPurchaseSales360 } from '@/app/actions/comercial/analysis/types'
import { SupplierCatalogTable } from '../components/provider/supplier-catalog-table'
import { SupplierEmptyState } from '../components/provider/supplier-empty-state'
import { SupplierKpis } from '../components/provider/supplier-kpis'
import { SupplierLastPurchasesTable } from '../components/provider/supplier-last-purchases-table'
import { SupplierPurchaseSalesChart } from '../components/provider/supplier-purchase-sales-chart'
import { SupplierSelector } from '../components/provider/supplier-selector'
import { useDateRange } from '../hooks/use-date-range'

export function Proveedor360() {
  const [suppliers, setSuppliers] = useState<AnalysisSupplierOption[]>([])
  const { dateFrom: globalDateFrom, dateTo: globalDateTo } = useDateRange()

  // Draft / Pending State
  const [pendingSupplierId, setPendingSupplierId] = useState('')
  const [pendingDateFrom, setPendingDateFrom] = useState(globalDateFrom)
  const [pendingDateTo, setPendingDateTo] = useState(globalDateTo)

  // Applied State (what is actually fetched)
  const [appliedSupplierId, setAppliedSupplierId] = useState('')
  const [appliedDateFrom, setAppliedDateFrom] = useState(globalDateFrom)
  const [appliedDateTo, setAppliedDateTo] = useState(globalDateTo)

  const [data, setData] = useState<SupplierPurchaseSales360 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)
  const [isPending, startTransition] = useTransition()

  const hasPendingChanges =
    pendingSupplierId !== appliedSupplierId ||
    pendingDateFrom !== appliedDateFrom ||
    pendingDateTo !== appliedDateTo

  const loading = Boolean(appliedSupplierId && !data && !error) || isFetching || isPending

  useEffect(() => {
    void getAnalysisSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
  }, [])

  // Sync global date if changed elsewhere, only if no pending local edits
  useEffect(() => {
    if (!hasPendingChanges) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDateFrom(globalDateFrom)

      setPendingDateTo(globalDateTo)

      setAppliedDateFrom(globalDateFrom)

      setAppliedDateTo(globalDateTo)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalDateFrom, globalDateTo])

  useEffect(() => {
    if (!appliedSupplierId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsFetching(true)
    void getSupplierPurchaseSales360({ supplierId: appliedSupplierId, dateFrom: appliedDateFrom, dateTo: appliedDateTo })
      .then((result) => {
        startTransition(() => {
          setData(result)
          setError(null)
        })
      })
      .catch((err) => {
        startTransition(() => {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el análisis del proveedor')
        })
      })
      .finally(() => {
        setIsFetching(false)
      })
  }, [appliedSupplierId, appliedDateFrom, appliedDateTo])

  const handleLoad = () => {
    if (!pendingSupplierId) return
    setAppliedSupplierId(pendingSupplierId)
    setAppliedDateFrom(pendingDateFrom)
    setAppliedDateTo(pendingDateTo)
    // Si queremos que el Date Range global del topbar siga a este, descomentar:
    // setDateRange(pendingDateFrom, pendingDateTo)
  }

  const handleSupplierChange = (newId: string) => {
    setPendingSupplierId(newId)
    // Auto-load si no hay fechas pendientes (intención clara de cambiar solo proveedor)
    if (pendingDateFrom === appliedDateFrom && pendingDateTo === appliedDateTo && newId) {
      setAppliedSupplierId(newId)
    }
  }

  return (
    <div className="space-y-5 p-5 lg:p-6">
      <div>
        <h1 className="text-base font-bold text-theme-text">Proveedor 360</h1>
        <p className="mt-1 text-xs text-theme-text-muted/70">
          Vista ejecutiva de catálogo, ventas, stock y compras disponibles por proveedor real.
        </p>
      </div>

      <SupplierSelector
        suppliers={suppliers}
        selectedId={pendingSupplierId}
        onSelectedId={handleSupplierChange}
        dateFrom={pendingDateFrom}
        onDateFrom={setPendingDateFrom}
        dateTo={pendingDateTo}
        onDateTo={setPendingDateTo}
        hasPendingChanges={hasPendingChanges}
        onLoad={handleLoad}
        loading={loading}
      />

      {!appliedSupplierId ? (
        <SupplierEmptyState />
      ) : (
        <>
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {hasPendingChanges && !loading && (
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-700 dark:text-blue-400">
              Rango o proveedor modificado. Presiona <strong>Cargar</strong> para actualizar la información.
            </div>
          )}
          {loading && (
            <div className="rounded-xl border border-theme-border bg-theme-surface/60 px-4 py-3 text-sm text-theme-text-muted flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-theme-border border-t-blue-500" />
              Cargando información...
            </div>
          )}

          <div className={hasPendingChanges || loading ? 'opacity-50 pointer-events-none transition-opacity' : 'transition-opacity'}>

            {appliedDateFrom < '2026-01-01' && (
              <div className="mb-5 rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-700 dark:text-yellow-500">
                Compras sincronizadas desde 01/01/2026. Los períodos anteriores pueden aparecer en $0 hasta completar el backfill histórico anterior a 2026.
              </div>
            )}

            <SupplierKpis data={data} loading={loading} />

            <div className="my-5 rounded-xl border border-theme-border bg-theme-surface/60 px-4 py-3 text-xs text-theme-text-muted/80">
              <span className="font-semibold text-theme-text">Fuentes:</span>{' '}
              Ventas desde facturas Bsale menos notas de crédito. Compras desde recepciones Bsale menos notas de crédito, calculado por líneas/SKUs asociados al proveedor (cantidad × costo unitario). Stock desde `bsale_stock_current`.
            </div>

            <SupplierPurchaseSalesChart supplierId={appliedSupplierId} weekly={data?.weekly || []} hasReceptionData={Boolean(data?.hasReceptionData)} totalEstimatedCost={data?.kpis.total_estimated_cost ?? 0} />

            <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
              <SupplierLastPurchasesTable rows={data?.lastPurchases || []} />
              <SupplierCatalogTable rows={data?.catalog || []} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
