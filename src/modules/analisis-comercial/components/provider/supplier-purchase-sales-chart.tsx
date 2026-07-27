'use client'

import type { SupplierWeeklyPoint, SupplierWeeklyDetail, SupplierDocumentDetail } from '@/app/actions/comercial/analysis/types'
import { getSupplierWeeklyDetail, getSupplierDocumentDetail } from '@/app/actions/comercial/analysis/suppliers'
import { useMemo, useState, useTransition, useEffect } from 'react'

const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function formatCompactMoney(value: number) {
  if (value >= 1000000) return '$' + (value / 1000000).toFixed(1).replace('.0', '') + 'M'
  if (value >= 1000) return '$' + Math.round(value / 1000) + 'k'
  return '$' + value
}

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function monthLabel(weekStart: string) {
  const [y, m] = weekStart.split('-')
  return `${MONTHS_SHORT[parseInt(m) - 1]} ${y}`
}

function shortDate(weekStart: string) {
  const [, m, d] = weekStart.split('-')
  return `${parseInt(d)}/${parseInt(m)}`
}

function getEpoch(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).getTime()
}



function getMonthBoundaries(weekly: SupplierWeeklyPoint[]) {
  const boundaries: { label: string; startIndex: number; weeks: SupplierWeeklyPoint[] }[] = []
  weekly.forEach((w, i) => {
    const key = w.weekStart.slice(0, 7)
    if (i === 0 || key !== weekly[i - 1].weekStart.slice(0, 7)) {
      boundaries.push({ label: monthLabel(w.weekStart), startIndex: i, weeks: [w] })
    } else {
      boundaries[boundaries.length - 1].weeks.push(w)
    }
  })
  return boundaries
}

const baselineY_pct = 90
const usableHeight_pct = 80

export function SupplierPurchaseSalesChart({ supplierId, weekly, hasReceptionData }: { supplierId: string; weekly: SupplierWeeklyPoint[]; hasReceptionData: boolean }) {
  const maxValue = Math.max(1, ...weekly.flatMap((item) => [item.purchases, item.sales, item.margin || 0]))
  const maxPurchases = Math.max(...weekly.map(w => w.purchases))
  const maxSales = Math.max(...weekly.map(w => w.sales))

  const n = weekly.length

  const [selectedWeekKey, setSelectedWeekKey] = useState<string | null>(null)
  const [cache, setCache] = useState<Record<string, SupplierWeeklyDetail>>({})
  const [error, setError] = useState<string | null>(null)

  // States for Document Detail
  const [documentDetail, setDocumentDetail] = useState<SupplierDocumentDetail | null>(null)
  const [docCache, setDocCache] = useState<Record<string, SupplierDocumentDetail>>({})
  const [loadingDocId, setLoadingDocId] = useState<string | null>(null)

  const [showMargin, setShowMargin] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Clear selected week if supplier changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedWeekKey(null)
  }, [supplierId])

  const handleSelectWeek = (w: SupplierWeeklyPoint) => {
    const key = w.weekStart
    const cacheKey = `${supplierId}:${w.weekStart}:${w.weekEnd}`

    if (selectedWeekKey === key) {
      setSelectedWeekKey(null)
      return
    }
    setSelectedWeekKey(key)
    if (cache[cacheKey]) return

    setError(null)
    startTransition(() => {
      getSupplierWeeklyDetail({ supplierId, dateFrom: w.weekStart, dateTo: w.weekEnd })
        .then((detail) => {
          setCache((prev) => ({ ...prev, [cacheKey]: detail }))
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Error al cargar detalle semanal')
        })
    })
  }

  const handleDocumentDoubleClick = (docId: string, kind: 'PURCHASE' | 'SALE' | 'CREDIT_NOTE') => {
    const cacheKey = `${supplierId}:${kind}:${docId}`
    if (docCache[cacheKey]) {
      setDocumentDetail(docCache[cacheKey])
      return
    }

    setLoadingDocId(docId)
    startTransition(() => {
      getSupplierDocumentDetail({ supplierId, documentKind: kind, documentId: docId })
        .then((res) => {
          if (res) setDocCache(prev => ({ ...prev, [cacheKey]: res }))
          setDocumentDetail(res)
        })
        .catch(() => {
          alert('Error al cargar detalle del documento.')
        })
        .finally(() => {
          setLoadingDocId(null)
        })
    })
  }

  const pointsWithX = useMemo(() => {
    if (n === 0) return []
    const minTime = getEpoch(weekly[0].weekStart)
    const maxTime = getEpoch(weekly[n - 1].weekStart)
    const timeSpan = maxTime - minTime || 1

    return weekly.map((w, i) => {
      const time = getEpoch(w.weekStart)
      const ratio = n === 1 ? 0.5 : (time - minTime) / timeSpan
      const x = 2 + ratio * 96

      let showLabel = false
      if (n <= 6 && (w.purchases > 0 || w.sales > 0)) showLabel = true
      else if (n > 6) {
        if (w.purchases === maxPurchases && w.purchases > 0) showLabel = true
        if (w.sales === maxSales && w.sales > 0) showLabel = true
      }

      return { ...w, x, time, index: i, showLabel }
    })
  }, [weekly, n, maxPurchases, maxSales])

  const purchaseLine = useMemo(
    () => {
      if (!pointsWithX.length) return ''
      if (pointsWithX.length === 1) {
        const y = baselineY_pct - (pointsWithX[0].purchases / maxValue) * usableHeight_pct
        return `50,${y.toFixed(2)} 50,${y.toFixed(2)}`
      }
      return pointsWithX.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - (p.purchases / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    },
    [pointsWithX, maxValue],
  )

  const salesLine = useMemo(
    () => {
      if (!pointsWithX.length) return ''
      if (pointsWithX.length === 1) {
        const y = baselineY_pct - (pointsWithX[0].sales / maxValue) * usableHeight_pct
        return `50,${y.toFixed(2)} 50,${y.toFixed(2)}`
      }
      return pointsWithX.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - (p.sales / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    },
    [pointsWithX, maxValue],
  )

  const marginLine = useMemo(
    () => {
      if (!pointsWithX.length) return ''
      if (pointsWithX.length === 1) {
        const y = baselineY_pct - ((pointsWithX[0].margin || 0) / maxValue) * usableHeight_pct
        return `50,${y.toFixed(2)} 50,${y.toFixed(2)}`
      }
      return pointsWithX.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - ((p.margin || 0) / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    },
    [pointsWithX, maxValue],
  )

  const monthBoundaries = useMemo(() => getMonthBoundaries(weekly), [weekly])

  const selectedWeek = useMemo(() => weekly.find(w => w.weekStart === selectedWeekKey), [weekly, selectedWeekKey])
  const cacheKey = selectedWeek ? `${supplierId}:${selectedWeek.weekStart}:${selectedWeek.weekEnd}` : null
  const detail = cacheKey ? cache[cacheKey] : null
  const loadingDetail = isPending && selectedWeekKey && !detail

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/80 p-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-bold text-theme-text">Compra vs Venta Semanal</h3>
          <p className="mt-1 text-xs text-theme-text-muted/80">
            {hasReceptionData
              ? 'Haz clic en una semana para ver el detalle de productos y documentos.'
              : 'Ventas semanales disponibles. Compras en 0 porque recepciones Bsale aún no están sincronizadas.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs font-medium text-theme-text-muted flex-wrap justify-end">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500 dark:bg-blue-400" />
            Compras
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
            Ventas
          </span>
          <label className="inline-flex items-center gap-1.5 cursor-pointer hover:text-theme-text transition-colors">
            <input type="checkbox" checked={showMargin} onChange={(e) => setShowMargin(e.target.checked)} className="rounded border-theme-border text-purple-500 focus:ring-purple-500 bg-transparent" />
            <span className="h-2.5 w-2.5 rounded-full bg-purple-500 dark:bg-purple-400" />
            <span title="Margen estimado según costo registrado. No incluye todos los gastos operacionales.">Margen estimado</span>
          </label>
        </div>
      </div>

      <div className="mt-6 w-full">
        {weekly.length === 0 ? (
          <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-8 text-center text-sm text-theme-text-muted/70">
            No hay datos semanales en el período seleccionado.
          </div>
        ) : weekly.length === 1 ? (
          <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-6 flex flex-col items-center justify-center text-center shadow-sm">
            <h4 className="text-lg font-bold text-theme-text mb-1">{weekly[0].label}</h4>
            <div className="flex flex-wrap items-center justify-center gap-6 mt-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-theme-text-muted uppercase">Compras</div>
                <div className="text-lg font-bold text-blue-600 dark:text-blue-400">{money(weekly[0].purchases)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold text-theme-text-muted uppercase">Ventas</div>
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{money(weekly[0].sales)}</div>
              </div>
              {showMargin && (
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-theme-text-muted uppercase">Margen Est.</div>
                  <div className="text-lg font-bold text-purple-600 dark:text-purple-400">{money(weekly[0].margin || 0)}</div>
                </div>
              )}
            </div>
            <button onClick={() => handleSelectWeek(weekly[0])} className="mt-6 rounded-lg bg-theme-border/50 px-4 py-2 text-sm font-semibold hover:bg-theme-border transition-colors">
              {selectedWeekKey === weekly[0].weekStart ? 'Cerrar detalle' : 'Ver detalle semanal'}
            </button>
          </div>
        ) : (
          <>
            <div className="relative group/chart w-full h-56">
              <svg className="absolute inset-0 w-full h-full overflow-visible">
                {[0, 0.25, 0.5, 0.75, 1].map((r) => {
                  const y = baselineY_pct - r * usableHeight_pct
                  return (
                    <line
                      key={r}
                      x1="0%" y1={`${y}%`} x2="100%" y2={`${y}%`}
                      stroke="currentColor" className="text-theme-border/30" strokeWidth="1px" strokeDasharray={r > 0 ? "4 4" : "none"}
                    />
                  )
                })}

                <svg viewBox="0 0 100 100" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" className="overflow-visible pointer-events-none">
                  {showMargin && (
                    <polyline
                      points={marginLine}
                      fill="none" className="stroke-purple-500/70 dark:stroke-purple-400/70" strokeWidth="2.5"
                      strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 6" vectorEffect="non-scaling-stroke"
                    />
                  )}
                  <polyline
                    points={purchaseLine}
                    fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                  />
                  <polyline
                    points={salesLine}
                    fill="none" className="stroke-emerald-500 dark:stroke-emerald-400" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                  />
                </svg>

                {pointsWithX.map((item, i) => {
                  const purchaseY = baselineY_pct - (item.purchases / maxValue) * usableHeight_pct
                  const salesY = baselineY_pct - (item.sales / maxValue) * usableHeight_pct
                  const marginY = baselineY_pct - ((item.margin || 0) / maxValue) * usableHeight_pct
                  const isSelected = selectedWeekKey === item.weekStart

                  const prevX = i > 0 ? pointsWithX[i-1].x : 0
                  const nextX = i < n - 1 ? pointsWithX[i+1].x : 100
                  const leftBound = i === 0 ? 0 : (item.x + prevX) / 2
                  const rightBound = i === n - 1 ? 100 : (item.x + nextX) / 2
                  const width = rightBound - leftBound

                  return (
                    <g key={item.weekStart} className={`transition-opacity ${isSelected ? 'opacity-100' : 'opacity-70 hover:opacity-100 group-hover/chart:opacity-50'}`}>
                      <rect
                        x={`${leftBound}%`} y="0%" width={`${width}%`} height="100%"
                        className={`cursor-pointer transition-colors ${isSelected ? 'fill-theme-border/30' : 'fill-transparent hover:fill-theme-border/10'}`}
                        onClick={() => handleSelectWeek(item)}
                      >
                        <title>{`${item.label}\nCompras: ${money(item.purchases)}\nVentas: ${money(item.sales)}${showMargin ? `\nMargen Est.: ${money(item.margin || 0)}` : ''}`}</title>
                      </rect>

                      {isSelected && (
                        <line x1={`${item.x}%`} y1="0%" x2={`${item.x}%`} y2={`${baselineY_pct}%`} stroke="currentColor" className="text-theme-text-muted/40 pointer-events-none" strokeWidth="1px" strokeDasharray="4 4" />
                      )}

                      {showMargin && (
                        <circle cx={`${item.x}%`} cy={`${marginY}%`} r={isSelected ? "5" : "3.5"} className="fill-purple-500 dark:fill-purple-400 transition-all cursor-pointer pointer-events-auto" stroke="var(--theme-surface)" strokeWidth="1.5" onClick={() => handleSelectWeek(item)}>
                          <title>{`Margen Est.: ${money(item.margin || 0)}`}</title>
                        </circle>
                      )}

                      <circle cx={`${item.x}%`} cy={`${purchaseY}%`} r={isSelected ? "5" : "3.5"} className="fill-blue-500 dark:fill-blue-400 transition-all cursor-pointer pointer-events-auto" stroke="var(--theme-surface)" strokeWidth="1.5" onClick={() => handleSelectWeek(item)}>
                        <title>{`Compras: ${money(item.purchases)}`}</title>
                      </circle>

                      <circle cx={`${item.x}%`} cy={`${salesY}%`} r={isSelected ? "5" : "3.5"} className="fill-emerald-500 dark:fill-emerald-400 transition-all cursor-pointer pointer-events-auto" stroke="var(--theme-surface)" strokeWidth="1.5" onClick={() => handleSelectWeek(item)}>
                        <title>{`Ventas: ${money(item.sales)}`}</title>
                      </circle>

                      {item.showLabel && (
                        <>
                          <text x={`${item.x}%`} y={`${purchaseY - 3}%`} textAnchor="middle" className="fill-blue-600 dark:fill-blue-400 text-[9px] font-semibold pointer-events-none">{formatCompactMoney(item.purchases)}</text>
                          <text x={`${item.x}%`} y={`${salesY - 3}%`} textAnchor="middle" className="fill-emerald-600 dark:fill-emerald-400 text-[9px] font-semibold pointer-events-none">{formatCompactMoney(item.sales)}</text>
                        </>
                      )}
                    </g>
                  )
                })}
              </svg>
            </div>

            <div className="mt-3 w-full px-[2%]">
              <div className="flex text-[11px] font-semibold text-theme-text-muted">
                {monthBoundaries.map((mb) => (
                  <div key={mb.label} className="text-center first:text-left last:text-right" style={{ flex: mb.weeks.length }}>
                    {mb.label}
                  </div>
                ))}
              </div>
              {n <= 12 && (
                <div className="mt-1 flex text-[10px] text-theme-text-muted/80">
                  {weekly.map((w) => (
                    <div key={w.weekStart} className={`flex-1 text-center first:text-left last:text-right cursor-pointer transition-colors ${selectedWeekKey === w.weekStart ? 'text-theme-text font-bold' : 'hover:text-theme-text'}`} onClick={() => handleSelectWeek(w)}>
                      {shortDate(w.weekStart)}
                    </div>
                  ))}
                </div>
              )}
            </div>


            {/* Panel de Detalle */}
            {selectedWeekKey && (
              <div className="mt-6 rounded-lg border border-theme-border bg-theme-bg/60 p-5 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300">
                {error && (
                  <div className="mb-4 rounded border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-600">
                    {error}
                  </div>
                )}

                <div className="flex items-center justify-between border-b border-theme-border/50 pb-4">
                  <div>
                    <h4 className="text-sm font-bold text-theme-text">Detalle Semanal</h4>
                    <p className="text-xs text-theme-text-muted">{weekly.find(w => w.weekStart === selectedWeekKey)?.label}</p>
                  </div>
                  {loadingDetail && (
                    <div className="text-xs text-theme-text-muted flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-theme-border border-t-blue-500" />
                      Cargando detalle...
                    </div>
                  )}
                  {detail && !loadingDetail && (
                    <button
                      onClick={() => setSelectedWeekKey(null)}
                      className="text-xs text-theme-text-muted hover:text-theme-text transition-colors"
                    >
                      Cerrar detalle ✕
                    </button>
                  )}
                </div>

                {detail && !loadingDetail && (
                  <div className="mt-4 grid gap-6 md:grid-cols-2 lg:grid-cols-3">

                    {/* Compras */}
                    <div className="space-y-3">
                      <h5 className="text-xs font-bold text-blue-600 dark:text-blue-400 border-b border-theme-border/40 pb-1">
                        Compras: {money(detail.purchases)}
                      </h5>
                      {detail.purchaseDocuments.length === 0 ? (
                        <div className="text-xs text-theme-text-muted/60">Sin recepciones registradas.</div>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                          {detail.purchaseDocuments.map(doc => (
                            <div key={doc.id} onDoubleClick={() => handleDocumentDoubleClick(String(doc.id), 'PURCHASE')} className="text-[11px] rounded bg-theme-surface/50 p-2 border border-theme-border/30 hover:border-theme-border transition-colors cursor-pointer" title="Doble clic para ver detalle de documento">
                              <div className="flex justify-between font-semibold text-theme-text mb-1">
                                <span>{doc.document} {doc.documentNumber}</span>
                                <span>{money(doc.amount)}</span>
                              </div>
                              <div className="text-theme-text-muted flex justify-between">
                                <span>{doc.date}</span>
                                <span>{doc.units} unid.</span>
                              </div>
                              <div className="mt-1 text-theme-text-muted/80 truncate" title={doc.productsSummary}>
                                📦 {doc.productsSummary}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Ventas */}
                    <div className="space-y-3">
                      <h5 className="text-xs font-bold text-emerald-600 dark:text-emerald-400 border-b border-theme-border/40 pb-1">
                        Ventas: {money(detail.sales)}
                      </h5>
                      {detail.saleDocuments.length === 0 ? (
                        <div className="text-xs text-theme-text-muted/60">Sin facturas emitidas.</div>
                      ) : (
                        <div className="space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                          {detail.saleDocuments.map(doc => (
                            <div key={doc.id} onDoubleClick={() => handleDocumentDoubleClick(String(doc.id), doc.kind as 'SALE' | 'CREDIT_NOTE')} className={`text-[11px] rounded bg-theme-surface/50 p-2 border border-theme-border/30 hover:border-theme-border transition-colors cursor-pointer ${doc.kind === 'CREDIT_NOTE' ? 'opacity-80' : ''}`} title="Doble clic para ver detalle de documento">
                              <div className="flex justify-between font-semibold text-theme-text mb-1">
                                <span className={doc.kind === 'CREDIT_NOTE' ? 'text-rose-600/80' : ''}>{doc.document} {doc.documentNumber}</span>
                                <span className={doc.kind === 'CREDIT_NOTE' ? 'text-rose-600/80' : ''}>
                                  {doc.kind === 'CREDIT_NOTE' ? '-' : ''}{money(Math.abs(doc.amount))}
                                </span>
                              </div>
                              <div className="text-theme-text-muted flex justify-between">
                                <span>{doc.date}</span>
                                <span>{doc.units} unid.</span>
                              </div>
                              <div className="mt-1 text-theme-text-muted/80 truncate" title={doc.productsSummary}>
                                📦 {doc.productsSummary}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Top Productos */}
                    <div className="space-y-3 md:col-span-2 lg:col-span-1">
                      <h5 className="text-xs font-bold text-theme-text border-b border-theme-border/40 pb-1">
                        Top Productos (Volumen)
                      </h5>
                      {detail.topProducts.length === 0 ? (
                        <div className="text-xs text-theme-text-muted/60">Sin movimientos.</div>
                      ) : (
                        <div className="space-y-2">
                          {detail.topProducts.map(p => (
                            <div key={p.sku} className="text-[11px] rounded bg-theme-surface/50 p-2 border border-theme-border/30 flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-theme-text truncate" title={p.description}>{p.description}</div>
                                <div className="text-theme-text-muted/80 text-[10px]">{p.sku}</div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-medium text-theme-text">{money(p.amount)}</div>
                                <div className="text-theme-text-muted">{p.units} unid.</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                  </div>
                )}

                {/* Detalle Documento Inline */}
                {(documentDetail || loadingDocId) && (
                  <div className="mt-6 border-t border-theme-border/50 pt-4 animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h5 className="text-sm font-bold text-theme-text">Detalle asociado a este proveedor</h5>
                        {documentDetail && !loadingDocId && (
                          <p className="text-xs text-theme-text-muted">{documentDetail.document} {documentDetail.documentNumber} • {shortDate(documentDetail.date)}</p>
                        )}
                      </div>
                      {loadingDocId && (
                        <div className="text-xs text-theme-text-muted flex items-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-theme-border border-t-blue-500" />
                          Cargando documento...
                        </div>
                      )}
                      {documentDetail && !loadingDocId && (
                        <button onClick={() => setDocumentDetail(null)} className="text-xs text-theme-text-muted hover:text-theme-text transition-colors">
                          Cerrar documento ✕
                        </button>
                      )}
                    </div>
                    {documentDetail && !loadingDocId && (
                      <div className="overflow-x-auto rounded-lg border border-theme-border/50 bg-theme-surface/30">
                        <table className="w-full text-left text-xs whitespace-nowrap">
                          <thead>
                            <tr className="border-b border-theme-border/50 bg-theme-surface/50">
                              <th className="py-2 pl-3 pr-2 font-semibold text-theme-text">SKU</th>
                              <th className="px-2 py-2 font-semibold text-theme-text">Cantidad</th>
                              <th className="px-2 py-2 text-right font-semibold text-theme-text">Unitario</th>
                              <th className="py-2 pl-2 pr-3 text-right font-semibold text-theme-text">Total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-theme-border/30">
                            {documentDetail.lines.map((line, idx) => (
                              <tr key={idx} className="hover:bg-theme-surface/50">
                                <td className="py-2 pl-3 pr-2 text-theme-text">{line.sku}</td>
                                <td className="px-2 py-2 text-theme-text-muted">{line.quantity}</td>
                                <td className="px-2 py-2 text-right text-theme-text-muted">{money(line.unitAmount)}</td>
                                <td className="py-2 pl-2 pr-3 text-right font-medium text-theme-text">{money(line.totalAmount)}</td>
                              </tr>
                            ))}
                            <tr className="bg-theme-surface/20">
                              <td colSpan={3} className="py-2.5 px-3 text-right font-semibold text-theme-text text-[11px] uppercase tracking-wider">Total en Proveedor</td>
                              <td className="py-2.5 pl-2 pr-3 text-right font-bold text-theme-text text-sm">{money(documentDetail.totalAmount)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Data Table */}
            <div className="mt-8 overflow-hidden rounded-lg border border-theme-border bg-theme-bg/50">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-theme-border/70 bg-theme-surface/50">
                      <th className="py-3 pl-4 pr-3 font-semibold text-theme-text">Semana</th>
                      <th className="px-3 py-3 text-right font-semibold text-theme-text">Compras</th>
                      <th className="px-3 py-3 text-right font-semibold text-theme-text">Ventas</th>
                      <th className="py-3 pl-3 pr-4 text-right font-semibold text-theme-text">Diferencia</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/30">
                    {weekly.map((w) => {
                      const diff = w.sales - w.purchases
                      const isPos = diff > 0
                      const isNeg = diff < 0
                      const isSelected = selectedWeekKey === w.weekStart

                      return (
                        <tr
                          key={w.weekStart}
                          onClick={() => handleSelectWeek(w)}
                          className={`cursor-pointer transition-colors ${isSelected ? 'bg-theme-border/20 border-l-2 border-l-blue-500' : 'hover:bg-theme-surface/80 border-l-2 border-l-transparent'}`}
                        >
                          <td className={`py-2.5 pl-4 pr-3 font-medium transition-colors ${isSelected ? 'text-theme-text' : 'text-theme-text-muted/90'}`}>
                            {w.label}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-theme-text-muted/90">
                            {money(w.purchases)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-medium tabular-nums text-theme-text">
                            {money(w.sales)}
                          </td>
                          <td className={`py-2.5 pl-3 pr-4 text-right tabular-nums font-semibold ${isPos ? 'text-emerald-600 dark:text-emerald-400' : isNeg ? 'text-rose-600 dark:text-rose-400' : 'text-theme-text-muted/60'}`}>
                            {isPos ? '+' : ''}{money(diff)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {!hasReceptionData && (
        <div className="mt-5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
          Recepciones Bsale aún no sincronizadas. Para completar el análisis cruzado de compras se requiere el espejo de recepciones.
        </div>
      )}
    </section>
  )
}
