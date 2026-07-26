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
import { setDateRange, useDateRange } from '../hooks/use-date-range'

export function Proveedor360() {
  const [suppliers, setSuppliers] = useState<AnalysisSupplierOption[]>([])
  const [selectedId, setSelectedId] = useState('')
  const { dateFrom, dateTo } = useDateRange()
  const [data, setData] = useState<SupplierPurchaseSales360 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const loading = Boolean(selectedId && !data && !error) || isPending

  useEffect(() => {
    void getAnalysisSuppliers().then(setSuppliers).catch(() => setSuppliers([]))
  }, [])

  useEffect(() => {
    if (!selectedId) return
    void getSupplierPurchaseSales360({ supplierId: selectedId, dateFrom, dateTo })
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
  }, [selectedId, dateFrom, dateTo])

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
        selectedId={selectedId}
        onSelectedId={(value) => {
          setSelectedId(value)
          setData(null)
          setError(null)
        }}
        dateFrom={dateFrom}
        onDateFrom={(value) => {
          setDateRange(value, dateTo)
          setData(null)
        }}
        dateTo={dateTo}
        onDateTo={(value) => {
          setDateRange(dateFrom, value)
          setData(null)
        }}
      />

      {!selectedId ? (
        <SupplierEmptyState />
      ) : (
        <>
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <SupplierKpis data={data} loading={loading} />

          <div className="rounded-xl border border-theme-border bg-theme-surface/60 px-4 py-3 text-xs text-theme-text-muted/80">
            <span className="font-semibold text-theme-text">Fuentes:</span>{' '}
            Ventas desde facturas Bsale tipo 5 menos notas de crédito tipo 2. Stock desde `bsale_stock_current`. Compras desde `bsale_receptions` cuando exista data sincronizada.
          </div>

          <SupplierPurchaseSalesChart monthly={data?.monthly || []} hasReceptionData={Boolean(data?.hasReceptionData)} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
            <SupplierLastPurchasesTable rows={data?.lastPurchases || []} />
            <SupplierCatalogTable rows={data?.catalog || []} />
          </div>
        </>
      )}
    </div>
  )
}
