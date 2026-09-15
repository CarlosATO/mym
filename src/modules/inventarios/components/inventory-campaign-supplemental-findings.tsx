'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, Loader2, PackageSearch, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { InventoryCombobox } from '@/modules/inventarios/components/inventory-combobox'
import {
  createSupplementalFinding,
  getActiveCompanySupplementalBatches,
  getActiveCompanySupplementalFindings,
  getSupplementalSiteLocations,
  removeSupplementalFinding,
  searchSupplementalFindingProducts,
  updateSupplementalFindingQuantity,
  syncSupplementalFindings,
  type SupplementalFinding,
  type SupplementalBatch,
  type SupplementalFindingClassification,
  type SupplementalFindingSiteOption,
  type SupplementalProduct,
  type SupplementalSiteLocation,
} from '@/app/actions/inventarios/supplemental-findings'

interface InventoryCampaignSupplementalFindingsProps {
  campaignId: string
  sites: SupplementalFindingSiteOption[]
  initialFindings: SupplementalFinding[]
  initialBatches: SupplementalBatch[]
}

const CLASSIFICATION_LABEL: Record<SupplementalFindingClassification, string> = {
  ELIGIBLE_CANONICAL: 'Elegible',
  ELIGIBLE_OUT_OF_THEORETICAL: 'Fuera del teórico · Elegible',
  BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT: 'Ya considerado · Puede agregarse',
  BLOCKED_MISSING_BSALE_VARIANT: 'Bloqueado · Sin variante Bsale',
}

const SYNCABLE_CLASSIFICATIONS = new Set<SupplementalFindingClassification>([
  'ELIGIBLE_CANONICAL',
  'ELIGIBLE_OUT_OF_THEORETICAL',
  'BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT',
])

function isSyncableClassification(classification: SupplementalFindingClassification): boolean {
  return SYNCABLE_CLASSIFICATIONS.has(classification)
}

function classificationTone(classification: SupplementalFindingClassification): string {
  switch (classification) {
    case 'ELIGIBLE_CANONICAL':
      return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'ELIGIBLE_OUT_OF_THEORETICAL':
      return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'BLOCKED_ALREADY_IN_NORMAL_SNAPSHOT':
      return 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'BLOCKED_MISSING_BSALE_VARIANT':
      return 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400'
  }
}

function formatQuantity(value: number | string): string {
  const n = Number(value)
  if (Number.isNaN(n)) return '—'
  return n.toLocaleString('es-CL', { maximumFractionDigits: 3 })
}

function displaySite(site: SupplementalFindingSiteOption): string {
  return [site.site_code, site.site_name].filter(Boolean).join(' · ') || site.site_name || '—'
}

function mergeLocationName(location: SupplementalSiteLocation): string {
  return [location.code, location.name].filter(Boolean).join(' · ') || location.code
}

export function InventoryCampaignSupplementalFindings({
  campaignId,
  sites,
  initialFindings,
  initialBatches,
}: InventoryCampaignSupplementalFindingsProps) {
  const [findings, setFindings] = useState<SupplementalFinding[]>(initialFindings)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // ---- Add dialog state ----
  const [open, setOpen] = useState(false)
  const [siteId, setSiteId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [locations, setLocations] = useState<SupplementalSiteLocation[]>([])
  const [locationsLoading, setLocationsLoading] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [products, setProducts] = useState<SupplementalProduct[]>([])
  const [productSearching, setProductSearching] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<SupplementalProduct | null>(null)
  const [quantity, setQuantity] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [batches, setBatches] = useState<SupplementalBatch[]>(initialBatches)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // ---- Edit / remove state ----
  const [editing, setEditing] = useState<SupplementalFinding | null>(null)
  const [editQuantity, setEditQuantity] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<SupplementalFinding | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const productListboxRef = useRef<HTMLDivElement>(null)
  const productSearchInputRef = useRef<HTMLInputElement>(null)

  const loadFindings = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    const result = await getActiveCompanySupplementalFindings(campaignId)
    setListLoading(false)
    if (result.error) {
      setListError(result.error)
      return
    }
    setFindings(result.data ?? [])
  }, [campaignId])

  const loadBatches = useCallback(async () => {
    setBatchError(null)
    const result = await getActiveCompanySupplementalBatches(campaignId)
    if (result.error) {
      setBatchError(result.error)
      return
    }
    setBatches(result.data?.batches ?? [])
  }, [campaignId])

  useEffect(() => {
    const clean = productQuery.trim()
    if (clean.length === 0) {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      return
    }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      setProductSearching(true)
      const result = await searchSupplementalFindingProducts(campaignId, clean)
      setProductSearching(false)
      if (result.error) {
        toast.error(result.error)
        return
      }
      setProducts(result.data ?? [])
    }, 300)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [productQuery, campaignId])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (productListboxRef.current && !productListboxRef.current.contains(event.target as Node)) {
        setProducts([])
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const resetForm = useCallback(() => {
    setSiteId('')
    setLocationId('')
    setLocations([])
    setProductQuery('')
    setProducts([])
    setSelectedProduct(null)
    setQuantity('')
  }, [])

  const handleOpen = () => {
    if (sites.length === 1) {
      const first = sites[0]
      setSiteId(first.site_id)
      void handleSiteChange(first.site_id, first.location_scope)
    }
    setOpen(true)
  }

  const handleSiteChange = async (nextSiteId: string, locationScope: 'ALL' | 'SELECTED') => {
    setLocationId('')
    setLocations([])
    setLocationsLoading(true)
    const result = await getSupplementalSiteLocations(campaignId, nextSiteId, locationScope)
    setLocationsLoading(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    setLocations(result.data ?? [])
  }

  const handleAddSubmit = async () => {
    if (submitting) return
    if (!siteId) {
      toast.error('Selecciona una bodega.')
      return
    }
    if (!locationId) {
      toast.error('Selecciona una ubicación.')
      return
    }
    if (!selectedProduct) {
      toast.error('Selecciona un producto.')
      return
    }
    const value = Number(quantity)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('La cantidad debe ser mayor a cero.')
      return
    }
    setSubmitting(true)
    const result = await createSupplementalFinding({
      campaignId,
      siteId,
      locationId,
      productId: selectedProduct.product_id,
      quantity: value,
    })
    setSubmitting(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Hallazgo registrado. Ya aparece en el listado.')
    setOpen(false)
    resetForm()
    await loadFindings()
    await loadBatches()
  }

  const handleEditOpen = (finding: SupplementalFinding) => {
    setEditing(finding)
    setEditQuantity(String(finding.quantity))
    setEditBusy(false)
  }

  const handleEditSave = async () => {
    if (!editing || editBusy) return
    const value = Number(editQuantity)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('La cantidad debe ser mayor a cero.')
      return
    }
    setEditBusy(true)
    const result = await updateSupplementalFindingQuantity({ findingId: editing.finding_id, quantity: value })
    setEditBusy(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Cantidad actualizada.')
    setEditing(null)
    await loadFindings()
  }

  const handleRemoveConfirm = async () => {
    if (!confirmRemove || removeBusy) return
    setRemoveBusy(true)
    const result = await removeSupplementalFinding({ findingId: confirmRemove.finding_id })
    setRemoveBusy(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success('Hallazgo retirado del listado.')
    setConfirmRemove(null)
    await loadFindings()
  }

  const siteOptions = useMemo(
    () =>
      sites.map(site => ({
        value: site.site_id,
        label: displaySite(site),
        scope: site.location_scope,
      })),
    [sites]
  )

  const locationOptions = useMemo(
    () =>
      locations.map(location => ({
        value: location.id,
        label: mergeLocationName(location),
      })),
    [locations]
  )

  const draftFindings = useMemo(() => findings.filter(finding => finding.status === 'DRAFT'), [findings])
  const eligibleFindings = useMemo(
    () => draftFindings.filter(finding => isSyncableClassification(finding.classification)),
    [draftFindings]
  )
  const blockedFindings = useMemo(
    () => draftFindings.filter(finding => !isSyncableClassification(finding.classification)),
    [draftFindings]
  )
  const resumableBatches = useMemo(
    () => batches.filter(batch => batch.session_status === 'PREPARED' || batch.session_status === 'COUNTING'),
    [batches]
  )
  const syncAvailable = eligibleFindings.length > 0 || resumableBatches.length > 0
  const pendingQuantity = eligibleFindings.reduce((sum, finding) => sum + Number(finding.quantity), 0)
  const syncSites = new Set([
    ...eligibleFindings.map(finding => finding.inventory_site_id),
    ...resumableBatches.map(batch => batch.inventory_site_id),
  ]).size

  const handleSync = async () => {
    if (syncing) return
    setSyncing(true)
    const result = await syncSupplementalFindings({ campaignId })
    setSyncing(false)
    if (result.error) {
      toast.error(result.error)
      await Promise.all([loadFindings(), loadBatches()])
      return
    }
    setSyncOpen(false)
    toast.success('Hallazgos sincronizados correctamente.')
    await Promise.all([loadFindings(), loadBatches()])
  }

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-theme-text">Hallazgos adicionales</h2>
          <p className="text-[11px] text-theme-text-muted">
            Registra productos encontrados fuera de lo planificado durante el conteo del inventario.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadFindings()}
            disabled={listLoading}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {listLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {listLoading ? 'Actualizando…' : 'Actualizar'}
          </button>
          <button
            type="button"
            onClick={handleOpen}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            <Plus className="h-3.5 w-3.5" />
            Agregar hallazgo
          </button>
          {syncAvailable && (
            <button
              type="button"
              onClick={() => setSyncOpen(true)}
              disabled={syncing}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Sincronizar hallazgos
            </button>
          )}
        </div>
      </div>

      {batchError && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {batchError}
        </div>
      )}

      {batches.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
          <span className="font-semibold">Lotes supplemental:</span>
          {batches.map(batch => (
            <span key={batch.supplemental_session_id} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 px-2 py-0.5">
              {batch.site_name} · {batch.recorded_count} hallazgo(s) · {batch.session_status === 'UNDER_REVIEW' ? 'Sincronizado' : 'Proceso pendiente'}
            </span>
          ))}
          <span className="text-emerald-700/80 dark:text-emerald-200/80">Los hallazgos sincronizados ya fueron incorporados al conteo del inventario.</span>
        </div>
      )}

      {listError && (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {listError}
        </div>
      )}

      {!listError && findings.length === 0 ? (
        <div className="mt-3 flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
          <PackageSearch className="h-7 w-7 text-theme-text-muted/50" />
          <p className="text-sm font-semibold text-theme-text">No hay hallazgos adicionales pendientes.</p>
          <p className="max-w-md text-xs text-theme-text-muted/70">
            Usa «Agregar hallazgo» para registrar un producto adicional en una ubicación concreta.
          </p>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                <th className="px-3 py-2">Producto</th>
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Bodega</th>
                <th className="px-3 py-2">Ubicación</th>
                <th className="px-3 py-2 text-right">Cantidad</th>
                <th className="px-3 py-2">Clasificación</th>
                <th className="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {findings.map(finding => (
                <tr key={finding.finding_id} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                  <td className="max-w-[320px] whitespace-normal px-3 py-1.5 text-theme-text">{finding.name}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono font-semibold text-theme-text">{finding.sku ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">
                    {displaySite({ site_id: finding.inventory_site_id, site_name: finding.site_name, site_code: finding.site_code, location_scope: 'ALL' })}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">
                    {[finding.location_code, finding.location_name].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-semibold text-theme-text">
                    {formatQuantity(finding.quantity)}
                  </td>
                   <td className="whitespace-nowrap px-3 py-1.5">
                     <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${classificationTone(finding.classification)}`}>
                         {finding.status === 'DRAFT'
                          ? (isSyncableClassification(finding.classification) ? 'Pendiente de sincronizar' : 'Requiere revisión')
                          : finding.status === 'UNDER_REVIEW' ? 'Sincronizado' : 'Procesado'}
                     </span>
                   </td>
                   <td className="whitespace-nowrap px-3 py-1.5 text-right">
                     {finding.status === 'DRAFT' && <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleEditOpen(finding)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Editar cantidad
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(finding)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-red-500/25 bg-red-500/5 px-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Retirar
                      </button>
                     </div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[min(90vh,760px)] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div className="px-6 pt-6">
                <h3 className="text-lg font-bold text-theme-text">Agregar hallazgo</h3>
                <p className="mt-1 text-sm text-theme-text-muted">
                  Registra un producto encontrado fuera del plan en una ubicación concreta.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mr-4 mt-5 rounded-md p-1 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 overflow-y-auto px-6 pb-2">
            <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="mb-1 block text-xs font-medium text-theme-text">Bodega / unidad</label>
                <select
                  value={siteId}
                  onChange={e => {
                    const value = e.target.value
                    setSiteId(value)
                    const site = sites.find(s => s.site_id === value)
                    if (site) void handleSiteChange(value, site.location_scope)
                  }}
                  className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
                >
                  <option value="">Selecciona una bodega</option>
                  {siteOptions.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="mb-1 block text-xs font-medium text-theme-text">Ubicación</label>
                {locationsLoading ? (
                  <div className="flex h-9 items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Cargando ubicaciones…
                  </div>
                ) : (
                  <InventoryCombobox
                    options={locationOptions}
                    value={locationId}
                    onSelect={setLocationId}
                    placeholder={siteId ? 'Buscar código, pasillo, rack…' : 'Primero selecciona una bodega'}
                    ariaLabel="Ubicación"
                    disabled={!siteId}
                    emptyText="No se encontraron ubicaciones"
                    size="comfortable"
                    className="w-full"
                  />
                )}
                {!locationsLoading && siteId && locations.length === 0 && (
                  <p className="text-xs text-theme-text-muted">No hay ubicaciones activas disponibles para esta bodega.</p>
                )}
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <label className="mb-1 block text-xs font-medium text-theme-text">Producto</label>
                <div ref={productListboxRef} className="relative">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
                    <input
                      ref={productSearchInputRef}
                      value={productQuery}
                      onChange={e => {
                        setProductQuery(e.target.value)
                        if (selectedProduct && e.target.value !== '') setSelectedProduct(null)
                      }}
                      placeholder="Busca por SKU, código de barras o nombre…"
                      className="w-full rounded-lg border border-theme-border bg-theme-surface py-2 pl-9 pr-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/60 focus:border-theme-border-accent"
                    />
                  </div>
                  {selectedProduct && (
                    <div className="mt-1.5 flex items-center gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-theme-text">
                      <div className="min-w-0 flex-1">
                        <strong className="break-words">{selectedProduct.name}</strong>{' '}
                        <span className="text-theme-text-muted">· SKU {selectedProduct.sku ?? '—'}</span>
                        <span className="ml-2 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                          {CLASSIFICATION_LABEL[selectedProduct.classification] ?? selectedProduct.classification}
                        </span>
                      </div>
                      <button
                        type="button"
                        aria-label="Quitar producto seleccionado"
                        title="Quitar producto seleccionado"
                        onClick={() => {
                          setSelectedProduct(null)
                          setProductQuery('')
                          setProducts([])
                          setQuantity('')
                          productSearchInputRef.current?.focus()
                        }}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-theme-text-muted transition-colors hover:bg-theme-text/10 hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-border-accent"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {productSearching && (
                    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Buscando productos…
                    </div>
                  )}
                  {!selectedProduct && !productSearching && productQuery.trim().length > 0 && (
                    <div className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-theme-border bg-theme-surface">
                      {products.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-theme-text-muted">Sin resultados.</div>
                      ) : (
                        products.map(product => (
                          <button
                            key={product.product_id + String(product.bsale_variant_id)}
                            type="button"
                            onClick={() => {
                              setSelectedProduct(product)
                              setProductQuery('')
                              setProducts([])
                            }}
                            className="flex w-full items-center justify-between gap-2 border-b border-theme-border/40 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-theme-text/3"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-theme-text">{product.name}</div>
                              <div className="truncate text-[11px] text-theme-text-muted">
                                SKU {product.sku ?? '—'}
                                {product.barcode ? ` · Código ${product.barcode}` : ''}
                              </div>
                            </div>
                            <span className="shrink-0">
                              <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${classificationTone(product.classification)}`}>
                                {CLASSIFICATION_LABEL[product.classification] ?? product.classification}
                              </span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-1.5 md:max-w-sm">
                <label className="mb-1 block text-xs font-medium text-theme-text">Cantidad física encontrada</label>
                <input
                  value={quantity}
                  onChange={e => setQuantity(e.target.value)}
                  type="number"
                  min="0"
                  step="0.001"
                  inputMode="decimal"
                  placeholder="0"
                  className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/60 focus:border-theme-border-accent"
                />
              </div>
            </div>
            </div>

            {selectedProduct?.in_normal_snapshot && (
              <div className="mx-6 mb-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100">
                <div className="flex items-start gap-2.5">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 space-y-2">
                    <p className="font-semibold">Este producto ya fue considerado en el inventario.</p>
                    <p>Puede registrarse igualmente como un nuevo hallazgo.</p>
                    <div>
                      <p className="font-medium">Ubicaciones conocidas:</p>
                      <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-100/80">
                        El contrato de lectura disponible actualmente no entrega las ubicaciones consideradas para este producto.
                      </p>
                    </div>
                    <p className="text-xs text-amber-800/90 dark:text-amber-100/90">
                      La nueva cantidad se registrará en la ubicación seleccionada en esta operación y se incorporará al conteo físico correspondiente.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-theme-border/60 px-6 py-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleAddSubmit()}
                disabled={submitting}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Agregar hallazgo
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Consolidar hallazgos</h3>
            <p className="mt-1 text-sm text-theme-text-muted">
              Al consolidar, los hallazgos elegibles dejarán de estar en edición y pasarán a la siguiente etapa del proceso de inventario.
            </p>

            {consolidationSiteOptions.length > 1 && (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-theme-text">Bodega del lote</label>
                <select
                  value={consolidationSiteId}
                  onChange={event => setConsolidationSiteId(event.target.value)}
                  disabled={consolidating}
                  className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent disabled:opacity-50"
                >
                  {consolidationSiteOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            )}

            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border border-theme-border px-3 py-2">
                <dt className="text-xs text-theme-text-muted">DRAFT en esta bodega</dt>
                <dd className="mt-0.5 font-semibold text-theme-text">{consolidationSummary.total}</dd>
              </div>
              <div className="rounded-lg border border-theme-border px-3 py-2">
                <dt className="text-xs text-theme-text-muted">Cantidad física elegible</dt>
                <dd className="mt-0.5 font-semibold text-theme-text">{formatQuantity(consolidationSummary.quantity)}</dd>
              </div>
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
                <dt className="text-xs text-theme-text-muted">Se consolidarán</dt>
                <dd className="mt-0.5 font-semibold text-emerald-700 dark:text-emerald-300">{consolidationSummary.eligible}</dd>
              </div>
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2">
                <dt className="text-xs text-theme-text-muted">No elegibles, permanecen DRAFT</dt>
                <dd className="mt-0.5 font-semibold text-amber-700 dark:text-amber-300">{consolidationSummary.blocked}</dd>
              </div>
            </dl>

            <p className="mt-4 text-xs text-theme-text-muted">
              Los hallazgos no elegibles no se consolidarán y seguirán disponibles para revisión.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConsolidationOpen(false)}
                disabled={consolidating}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleConsolidate()}
                disabled={consolidating || consolidationSummary.eligible === 0}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {consolidating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Consolidar hallazgos
              </button>
            </div>
          </div>
        </div>
      )}

      {false && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Registrar conteos</h3>
            <p className="mt-1 text-sm text-theme-text-muted">
              Se registrarán como conteos físicos oficiales los hallazgos consolidados de este lote.
            </p>

            <dl className="mt-4 space-y-2 rounded-lg border border-theme-border px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Bodega</dt>
                <dd className="text-right font-semibold text-theme-text">{recordingBatch.site_name}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Hallazgos pendientes</dt>
                <dd className="font-semibold text-theme-text">{recordingBatch.pending_count_record_count}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Cantidad física pendiente</dt>
                <dd className="font-semibold text-theme-text">{formatQuantity(recordingBatch.pending_physical_quantity)} unidades</dd>
              </div>
            </dl>

            <p className="mt-4 text-xs text-theme-text-muted">
              La sesión continuará en conteo después de registrar estos conteos. Esta acción no finaliza ni revisa el lote.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setRecordingOpen(false)
                  setRecordingBatch(null)
                }}
                disabled={recording}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleRecordCounts()}
                disabled={recording}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {recording && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Registrar conteos
              </button>
            </div>
          </div>
        </div>
      )}

      {false && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Finalizar conteo</h3>
            <p className="mt-1 text-sm text-theme-text-muted">
              Los conteos de este lote ya están registrados. Al finalizar se cerrarán sus ubicaciones y tarea, y el lote quedará listo para revisión.
            </p>

            <dl className="mt-4 space-y-2 rounded-lg border border-theme-border px-3 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Bodega</dt>
                <dd className="text-right font-semibold text-theme-text">{finalizationBatch.site_name}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Hallazgos registrados</dt>
                <dd className="font-semibold text-theme-text">{finalizationBatch.recorded_count}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Cantidad física registrada</dt>
                <dd className="font-semibold text-theme-text">{formatQuantity(finalizationBatch.consolidated_physical_quantity)} unidades</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Estado actual</dt>
                <dd className="font-semibold text-theme-text">En conteo</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-theme-text-muted">Estado resultante</dt>
                <dd className="font-semibold text-theme-text">En revisión</dd>
              </div>
            </dl>

            <p className="mt-4 text-xs text-theme-text-muted">
              Esta acción no aprueba el inventario ni modifica las cantidades registradas.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setFinalizationOpen(false)
                  setFinalizationBatch(null)
                }}
                disabled={finalizing}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleFinalize()}
                disabled={finalizing}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {finalizing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Finalizar conteo
              </button>
            </div>
          </div>
        </div>
      */}

      {syncOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Sincronizar hallazgos</h3>
            <p className="mt-1 text-sm text-theme-text-muted">Se procesarán los hallazgos pendientes y se incorporarán al conteo del inventario. Al finalizar, los lotes procesados quedarán sincronizados.</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2"><dt className="text-xs text-theme-text-muted">Hallazgos pendientes elegibles</dt><dd className="mt-0.5 font-semibold text-theme-text">{eligibleFindings.length}</dd></div>
              <div className="rounded-lg border border-theme-border px-3 py-2"><dt className="text-xs text-theme-text-muted">Cantidad física pendiente</dt><dd className="mt-0.5 font-semibold text-theme-text">{formatQuantity(pendingQuantity)} unidades</dd></div>
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2"><dt className="text-xs text-theme-text-muted">Requieren revisión</dt><dd className="mt-0.5 font-semibold text-theme-text">{blockedFindings.length}</dd></div>
              <div className="rounded-lg border border-theme-border px-3 py-2"><dt className="text-xs text-theme-text-muted">Bodegas/lotes</dt><dd className="mt-0.5 font-semibold text-theme-text">{syncSites}</dd></div>
            </dl>
            {blockedFindings.length > 0 && <p className="mt-4 text-xs text-theme-text-muted">Los hallazgos que requieran revisión permanecerán pendientes y no impedirán procesar los elegibles.</p>}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setSyncOpen(false)} disabled={syncing} className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void handleSync()} disabled={syncing} className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-50">
                {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {syncing ? 'Sincronizando...' : 'Sincronizar hallazgos'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Editar cantidad</h3>
            <p className="mt-0.5 text-xs text-theme-text-muted">
              {editing.name} · SKU {editing.sku ?? '—'} · {[editing.location_code, editing.location_name].filter(Boolean).join(' · ') || '—'}
            </p>
            <input
              value={editQuantity}
              onChange={e => setEditQuantity(e.target.value)}
              type="number"
              min="0"
              step="0.001"
              inputMode="decimal"
              className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
            />
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={editBusy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleEditSave()}
                disabled={editBusy}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {editBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemove && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Retirar hallazgo</h3>
            <p className="mt-1 text-xs text-theme-text-muted">
              Se retirará <strong className="text-theme-text">{confirmRemove.name}</strong> (SKU{' '}
              {confirmRemove.sku ?? '—'}) de la lista de hallazgos pendientes. Esta acción no se puede deshacer.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                disabled={removeBusy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleRemoveConfirm()}
                disabled={removeBusy}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {removeBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Retirar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
