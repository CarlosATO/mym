'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ClipboardCheck, Loader2, Plus, Save, Search, Trash2 } from 'lucide-react'
import { confirmCommercialPurchaseOrder, confirmPurchaseOrderSupplierReview, getPurchaseOrderSupplierReviewComparison, updateSentPurchaseOrderReview, getCommercialSupplierReviewState, saveCommercialSupplierReview, type CommercialDraftLine, type PurchaseOrderReviewChangedField, type PurchaseOrderReviewComparisonLine, type PurchaseOrderReviewItem, type PurchaseOrderSupplierReviewComparison, type SupplierReviewData } from '@/app/actions/adquisiciones/purchase-orders'
import { getPurchaseCommercialForManualOrder } from '@/app/actions/adquisiciones/purchase-units'
import { calculateCommercialDraftLineTotals, calculateCommercialDraftTotals } from '@/lib/adquisiciones/purchase-commercial-totals'
import { commercialReviewChangedFields, commercialReviewConvert, commercialReviewFingerprint, commercialReviewValidQuantity } from '@/lib/adquisiciones/commercial-supplier-review'
import { getPurchaseOrderProductCatalogCached } from './purchase-order-product-cache'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'
import { PurchaseOrderNewProductModal } from './purchase-order-new-product-modal'
import { PurchaseCommercialPresentation, PurchaseCommercialQuantity, PurchaseCommercialPrice } from './purchase-order-commercial-fields'
import { PurchaseOrderCommercialProductForm, type CommercialProductAddition } from './purchase-order-commercial-product-form'
import type { LocalCreatedProduct } from '@/lib/integraciones/bsale-product-creation-core'
import { calculatePurchaseOrderLineTotals, calculatePurchaseOrderTotals } from '@/lib/adquisiciones/purchase-order-totals'
import { getPurchaseOrderDiscountDisplayValues, getPurchaseOrderDiscountPayload, resolvePurchaseOrderDiscountMode, type PurchaseOrderDiscountMode } from '@/lib/adquisiciones/purchase-order-discounts'

type EditableReviewItem = Omit<PurchaseOrderReviewItem, 'item_id'> & {
  item_id: string | null
  client_id: string
  discount_unit_amount: number
  discount_mode: PurchaseOrderDiscountMode
  commercial_factor?: number
  commercial_unit?: string | null
  commercial_mapping_id?: string | null
  commercial_price_raw?: string
  commercial_quantity_raw?: string
  internal_price_raw?: string
  restore_pending?: boolean
}

interface PurchaseOrderSupplierReviewProps {
  poId: string
  commercial: boolean
  onBack: () => void
  onSaved?: () => void | Promise<void>
  onConfirmed?: () => void | Promise<void>
}

const inputClass = 'h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15'

function currency(value: number | null | undefined, code: string, cents = false) {
  return Number(value ?? 0).toLocaleString('es-CL', {
    style: 'currency',
    currency: code,
    ...(cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {}),
  })
}

function signedCurrency(value: number, code: string, cents = false) {
  return value > 0 ? `+${currency(value, code, cents)}` : currency(value, code, cents)
}

function dateValue(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('es-CL')
}

function statusStyle(status: string) {
  if (status === 'MODIFICADA') return 'border-[#AC9C8D]/50 bg-[#AC9C8D]/15 text-[#72383D]'
  if (status === 'AGREGADA') return 'border-[#72383D]/30 bg-[#72383D]/10 text-[#72383D]'
  return 'border-[#D1C7BD] bg-[#EFE9E1] text-[#6D625B]'
}

function statusLabel(status: string) {
  return status === 'SIN_CAMBIOS' ? 'Sin cambios' : status === 'MODIFICADA' ? 'Modificada' : status === 'AGREGADA' ? 'Agregada' : 'Eliminada'
}

function changedValue(changes: PurchaseOrderReviewChangedField[], field: string) {
  return changes.find((change) => change.field === field)?.original
}

function changedFieldLabel(field: string) {
  const labels: Record<string, string> = {
    item_type: 'Tipo de línea', product_id: 'Producto', product_description: 'Descripción', unit: 'Unidad',
    quantity: 'Cantidad', unit_price: 'Precio unitario', commercial_unit_price: 'Precio comercial',
    discount_percent: 'Descuento porcentual', discount_unit_amount: 'Descuento por unidad',
    tax_rate: 'IVA', notes: 'Observaciones',
  }
  return labels[field] ?? field
}

function displayValue(value: unknown, field: string, code: string, precise = false) {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'unit_price' || field === 'commercial_unit_price' || field === 'discount_unit_amount') return precise ? Number(value).toLocaleString('es-CL', { maximumFractionDigits: 4 }) : currency(Number(value), code)
  if (field === 'quantity') return Number(value).toLocaleString('es-CL')
  if (field.endsWith('_percent')) return `${value}%`
  return String(value)
}

function reviewLineMap(comparison: PurchaseOrderReviewComparisonLine[]) {
  return new Map(comparison.map((line) => [line.item_id, line]))
}

function toEditable(item: PurchaseOrderReviewItem, index: number): EditableReviewItem {
  const qty = Number(item.quantity) || 0
  const unitPrice = Number(item.unit_price) || 0
  const taxRate = Number(item.tax_rate ?? 19)
  const discountPercent = Number(item.discount_percent) || 0
  let discountUnitAmount = Number(item.discount_unit_amount) || 0
  const discountAmount = Number(item.discount_amount) || 0

  if (discountPercent === 0 && discountUnitAmount === 0 && discountAmount > 0 && qty > 0) {
    discountUnitAmount = Math.round(((discountAmount / qty) + Number.EPSILON) * 100) / 100
  }

  const mode = resolvePurchaseOrderDiscountMode(discountPercent, discountUnitAmount)

  const historical = item as PurchaseOrderReviewItem & { purchase_unit_factor_snapshot?: number | null; purchase_unit_snapshot?: string | null; product_supplier_mapping_id?: string | null; commercial_unit_price?: string | null; commercial_unit_price_snapshot?: string | number | null }
  const factor = historical.purchase_unit_factor_snapshot
  const price = historical.commercial_unit_price ?? historical.commercial_unit_price_snapshot
  return {
    ...item,
    quantity: qty,
    unit_price: unitPrice,
    tax_rate: taxRate,
    item_id: item.item_id || null,
    client_id: item.item_id ? `persisted-${item.item_id}` : `persisted-new-${index}`,
    discount_percent: discountPercent,
    discount_unit_amount: discountUnitAmount,
    discount_amount: discountAmount,
    discount_mode: mode,
    ...(factor != null ? { commercial_factor: factor, commercial_unit: historical.purchase_unit_snapshot, commercial_mapping_id: historical.product_supplier_mapping_id, commercial_price_raw: String(price ?? ''), commercial_quantity_raw: commercialReviewConvert(String(qty), factor, 'divide', false), internal_price_raw: String(unitPrice) } : {}),
  }
}

function discountPercentDisplay(line: EditableReviewItem) {
  return getPurchaseOrderDiscountDisplayValues(line).discount_percent
}

function discountUnitAmountDisplay(line: EditableReviewItem) {
  return getPurchaseOrderDiscountDisplayValues(line).discount_unit_amount
}

function matchesOriginal(line: EditableReviewItem, original: PurchaseOrderReviewItem) {
  const origQty = Number(original.quantity) || 0
  const origPrice = Number(original.unit_price) || 0
  const origPercent = Number(original.discount_percent) || 0
  let origUnitAmount = Number(original.discount_unit_amount) || 0
  const origAmount = Number(original.discount_amount) || 0
  if (origPercent === 0 && origUnitAmount === 0 && origAmount > 0 && origQty > 0) {
    origUnitAmount = Math.round(((origAmount / origQty) + Number.EPSILON) * 100) / 100
  }
  return (
    line.item_type === original.item_type &&
    line.product_id === original.product_id &&
    Number(line.quantity) === origQty &&
    Number(line.unit_price) === origPrice &&
    Number(line.discount_percent) === origPercent &&
    Number(line.discount_unit_amount) === origUnitAmount &&
    Number(line.tax_rate) === (Number(original.tax_rate) || 19) &&
    (line.notes || null) === (original.notes || null)
  )
}

export function PurchaseOrderSupplierReview({ poId, commercial, onBack, onSaved, onConfirmed }: PurchaseOrderSupplierReviewProps) {
  const [comparison, setComparison] = useState<PurchaseOrderSupplierReviewComparison | null>(null)
  const [lines, setLines] = useState<EditableReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const confirmInFlight = useRef(false)
  const [confirmationUncertain, setConfirmationUncertain] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogCache, setCatalogCache] = useState<PurchaseOrderCatalogProduct[]>([])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<PurchaseOrderCatalogProduct | null>(null)
  const [newQuantity, setNewQuantity] = useState('1')
  const [newUnitPrice, setNewUnitPrice] = useState('0')
  const [servicePickerOpen, setServicePickerOpen] = useState(false)
  const [newService, setNewService] = useState({
    description: '',
    quantity: '1',
    unitPrice: '0',
    discountPercent: '0',
    taxRate: '19',
    notes: '',
  })
  const [productPickerOpen, setProductPickerOpen] = useState(false)
  const [newProductModalOpen, setNewProductModalOpen] = useState(false)
  const [showDiscountColumns, setShowDiscountColumns] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const newItemSequence = useRef(0)
  const saveInFlight = useRef(false)
  const [revision, setRevision] = useState<number | null>(null)
  const [commercialReceiptEnabled, setCommercialReceiptEnabled] = useState<boolean | null>(null)
  const [savedFingerprint, setSavedFingerprint] = useState('')
  const [pendingRequest, setPendingRequest] = useState<{ poId: string; requestId: string; revision: number; items: CommercialDraftLine[] } | null>(null)
  const [conflict, setConflict] = useState(false)
  const [resolvingProduct, setResolvingProduct] = useState(false)
  const [productCommercial, setProductCommercial] = useState<Extract<Awaited<ReturnType<typeof getPurchaseCommercialForManualOrder>>, { success: true }> | null>(null)
  const requestKey = `commercial-review-request:${poId}`

  function payloadItems(value: EditableReviewItem[]): CommercialDraftLine[] {
    return value.map(line => ({ item_id: line.item_id?.startsWith('new-') ? null : line.item_id, item_type: line.item_type, product_id: line.product_id, product_description: line.product_description, unit: line.unit, quantity: line.quantity, unit_price: line.unit_price, commercial_unit_price: line.commercial_factor !== undefined ? (line.commercial_price_raw ?? '').replace(',', '.') : null, purchase_unit_snapshot: line.commercial_unit ?? null, purchase_unit_factor_snapshot: line.commercial_factor ?? null, product_supplier_mapping_id: line.commercial_mapping_id ?? null, ...getPurchaseOrderDiscountPayload(line), tax_rate: line.tax_rate, notes: line.notes }))
  }

  async function loadComparison() {
    setLoading(true)
    setError('')
    let result: Awaited<ReturnType<typeof getPurchaseOrderSupplierReviewComparison>>
    try {
      const before = commercial ? await getCommercialSupplierReviewState(poId) : null
      if (before && (!('data' in before) || !before.data)) throw new Error(before.error || 'No se pudo cargar la revisión comercial.')
      result = await getPurchaseOrderSupplierReviewComparison(poId)
      if (commercial && before && 'data' in before && before.data) {
        const after = await getCommercialSupplierReviewState(poId)
        if (!('data' in after) || !after.data) throw new Error(after.error || 'No se pudo cargar la revisión comercial.')
        if (before.data.revision !== after.data.revision) throw new Error('La revisión cambió durante la lectura. Vuelve a cargarla.')
        if ('data' in result && result.data) {
          const byId = new Map(result.data.current.items.map(item => [item.item_id, item]))
          if (byId.size !== after.data.items.length || after.data.items.some(item => !byId.has(item.item_id))) throw new Error('La revisión cambió durante la lectura. Vuelve a cargarla.')
          result.data.current.items = after.data.items.map(item => ({ ...byId.get(item.item_id)!, ...item }))
          setRevision(after.data.revision)
          setCommercialReceiptEnabled(after.data.commercial_receipt_enabled ?? null)
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar la comparación de la OC.')
      setLoading(false)
      return
    }
    if ('error' in result && result.error) {
      setError(result.error)
      setLoading(false)
      return
    }
    if ('data' in result && result.data) {
      setComparison(result.data)
      const editableItems = result.data.current.items.map(toEditable)
      setLines(editableItems)
      setSavedFingerprint(commercialReviewFingerprint(payloadItems(editableItems)))
      setConflict(false)
      const hasAnyDiscount = editableItems.some(
        (it) => it.discount_percent > 0 || it.discount_unit_amount > 0 || (it.discount_amount ?? 0) > 0,
      )
      if (hasAnyDiscount) {
        setShowDiscountColumns(true)
      }
      setDirty(false)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (commercial) {
      try {
        const stored = sessionStorage.getItem(requestKey)
        if (stored) setPendingRequest(JSON.parse(stored))
      } catch { setError('No se pudo recuperar el guardado pendiente de esta sesión.') }
    }
    void loadComparison()
  }, [poId])

  const changesPending = commercial ? commercialReviewFingerprint(payloadItems(lines)) !== savedFingerprint : dirty
  useEffect(() => {
    if (!changesPending && !pendingRequest) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [changesPending, pendingRequest])
  function closeProductPicker() {
    setProductPickerOpen(false)
    setSelectedProduct(null)
    setCatalogQuery('')
    setNewQuantity('1')
    setNewUnitPrice('0')
    setProductCommercial(null)
  }

  useEffect(() => {
    closeProductPicker()
  }, [poId])
  useEffect(() => {
    setNewProductModalOpen(false)
  }, [poId])

  const statuses = useMemo(() => reviewLineMap(comparison?.comparison ?? []), [comparison])
  const removedLines = commercial
    ? (comparison?.original.items ?? []).filter(original => !lines.some(item => item.item_id === original.item_id)).map(original => ({ item_id: original.item_id, original_item: original }))
    : comparison?.comparison.filter((line) => line.comparison_status === 'ELIMINADA' && !lines.some(item => item.item_id === line.item_id)) ?? []
  const catalog = productPickerOpen ? catalogCache : []
  const visibleProducts = useMemo(() => {
    const query = catalogQuery.trim().toLocaleLowerCase('es-CL')
    if (!query) return catalog.slice(0, 8)
    return catalog.filter((product) => [product.sku, product.description, product.barcode ?? ''].some((value) => value.toLocaleLowerCase('es-CL').includes(query))).slice(0, 8)
  }, [catalog, catalogQuery])

  const preview = useMemo(() => commercial ? calculateCommercialDraftTotals(lines) : calculatePurchaseOrderTotals(lines), [lines, commercial])

  const visibleLines = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('es-CL')
    if (!query) return lines
    return lines.filter((line) => [line.sku, line.product_description].some((value) => (value ?? '').toLocaleLowerCase('es-CL').includes(query)))
  }, [lines, searchQuery])

  const hasPendingPrice = lines.some((line) => !Number.isFinite(line.unit_price) || line.unit_price <= 0)
  const hasInvalidQuantity = lines.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0)
  const confirmDisabledReason = changesPending ? 'Guarda la revisión antes de confirmar la OC.' : pendingRequest ? 'Verifica el guardado pendiente antes de confirmar.' : conflict ? 'Recarga la revisión antes de confirmar.' : commercial && revision === null ? 'No se pudo verificar la revisión comercial.' : hasPendingPrice ? 'Existen líneas con precio pendiente.' : hasInvalidQuantity ? 'Existen líneas con cantidad inválida.' : ''

  function updateLine(itemId: string | null, field: 'quantity' | 'unit_price' | 'commercial_quantity_raw' | 'commercial_price_raw' | 'discount_percent' | 'discount_unit_amount' | 'tax_rate', value: string) {
    const numeric = Number(value)
    setLines((current) =>
      current.map((line) => {
        if (line.item_id !== itemId && line.client_id !== itemId) return line
        const nextValue = Number.isFinite(numeric) ? numeric : 0
        if (commercial && line.commercial_factor !== undefined) {
          const factor = line.commercial_factor
          if (field === 'quantity') return { ...line, quantity: nextValue, commercial_quantity_raw: commercialReviewConvert(value, factor, 'divide', false) }
          if (field === 'commercial_quantity_raw') {
            const internal = commercialReviewConvert(value, factor, 'multiply', true)
            return { ...line, commercial_quantity_raw: value, quantity: internal ? Number(internal) : 0 }
          }
          if (field === 'unit_price') return { ...line, internal_price_raw: value, unit_price: nextValue, commercial_price_raw: commercialReviewConvert(value, factor, 'multiply', false) }
          if (field === 'commercial_price_raw') {
            const valid = /^\d+(?:[.,]\d{0,4})?$/.test(value)
            const price = valid ? Number(value.replace(',', '.')) / factor : 0
            return { ...line, commercial_price_raw: value, unit_price: Number(price.toFixed(4)), internal_price_raw: valid ? String(Number(price.toFixed(4))) : '' }
          }
        }
        if (field === 'discount_percent') {
          const discountPercent = Math.min(Math.max(nextValue, 0), 100)
          return {
            ...line,
            discount_percent: discountPercent,
            discount_unit_amount: 0,
            discount_mode: discountPercent > 0 ? 'percent' : null,
          }
        }
        if (field === 'discount_unit_amount') {
          const discountUnitAmount = Math.min(Math.max(nextValue, 0), Math.max(line.unit_price, 0))
          return {
            ...line,
            discount_unit_amount: discountUnitAmount,
            discount_percent: 0,
            discount_mode: discountUnitAmount > 0 ? 'unit' : null,
          }
        }
        if (field === 'unit_price') {
          const unitPrice = Math.max(nextValue, 0)
          const unitAmount = Math.min(line.discount_unit_amount, unitPrice)
          return {
            ...line,
            unit_price: unitPrice,
            discount_unit_amount: unitAmount,
            discount_mode: unitAmount > 0 ? 'unit' : (line.discount_percent > 0 ? 'percent' : null),
          }
        }
        return { ...line, [field]: nextValue }
      }),
    )
    setDirty(true)
  }

  function removeLine(clientId: string | null) {
    setLines((current) => current.filter((line) => line.item_id !== clientId && line.client_id !== clientId))
    setDirty(true)
  }

  function restoreLine(line: PurchaseOrderReviewItem | null) {
    if (!line) return
    setLines((current) => (current.some((item) => item.item_id === line.item_id) ? current : [...current, { ...toEditable(line, current.length), restore_pending: commercial && !comparison?.current.items.some(item => item.item_id === line.item_id) }]))
    setDirty(true)
    setMessage('Línea restaurada; guarda la revisión para confirmar.')
  }

  async function openCatalog() {
    if (productPickerOpen) {
      closeProductPicker()
      return
    }
    setProductPickerOpen(true)
    setSelectedProduct(null)
    setCatalogQuery('')
    if (catalogCache.length > 0) return
    setCatalogLoading(true)
    try {
      setCatalogCache(await getPurchaseOrderProductCatalogCached())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el catálogo.')
    } finally {
      setCatalogLoading(false)
    }
  }

  async function selectProduct(product: PurchaseOrderCatalogProduct) {
    if (!commercial) { setSelectedProduct(product); return }
    if (!comparison?.po.supplier_id || resolvingProduct) return
    setResolvingProduct(true)
    setError('')
    try {
      const result = await getPurchaseCommercialForManualOrder(product.id, comparison.po.supplier_id)
      if (!result.success) { setError(result.message || 'No se pudo resolver la presentación comercial.'); return }
      setProductCommercial(result)
      setNewQuantity(String(result.purchase_unit_factor))
      setSelectedProduct(product)
    } catch { setError('No se pudo resolver la presentación comercial.') }
    finally { setResolvingProduct(false) }
  }

  function addProduct() {
    if (!selectedProduct) return
    if (commercial && !productCommercial) { setError('Selecciona nuevamente el producto para resolver su presentación.'); return }
    const quantity = Number(newQuantity)
    const unitPrice = Number(newUnitPrice)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.')
      return
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError('El precio unitario no puede ser negativo.')
      return
    }
    setLines((current) => [
      ...current,
      {
        item_id: `new-${++newItemSequence.current}`,
        client_id: `new-${newItemSequence.current}`,
        line_number: current.length + 1,
        item_type: 'PRODUCT',
        product_id: selectedProduct.id,
        sku: selectedProduct.sku,
        product_description: selectedProduct.description,
        unit: selectedProduct.unit_of_measure,
        quantity,
        unit_price: unitPrice,
        discount_percent: 0,
        discount_unit_amount: 0,
        discount_mode: null,
        discount_amount: 0,
        tax_rate: selectedProduct.tax_rate,
        tax_amount: 0,
        line_total: 0,
        notes: null,
        ...(commercial && productCommercial ? { commercial_unit: productCommercial.purchase_unit, commercial_factor: productCommercial.purchase_unit_factor, commercial_mapping_id: productCommercial.mapping_id, commercial_price_raw: commercialReviewConvert(newUnitPrice, productCommercial.purchase_unit_factor, 'multiply', false), commercial_quantity_raw: commercialReviewConvert(newQuantity, productCommercial.purchase_unit_factor, 'divide', false), internal_price_raw: newUnitPrice } : {}),
      },
    ])
    closeProductPicker()
    setDirty(true)
    setError('')
  }

  function addCommercialProduct(value: CommercialProductAddition) {
    if (!selectedProduct) return
    if (lines.some(line => line.product_id === selectedProduct.id)) { setError('Este producto ya está en la orden.'); return }
    const clientId = `new-${++newItemSequence.current}`
    setLines(current => [...current, {
      item_id: clientId, client_id: clientId, line_number: current.length + 1, item_type: 'PRODUCT',
      product_id: selectedProduct.id, sku: selectedProduct.sku, product_description: selectedProduct.description,
      unit: selectedProduct.unit_of_measure, quantity: value.quantity, unit_price: value.unitPrice,
      discount_percent: value.discountPercent, discount_unit_amount: value.discountUnitAmount, discount_mode: value.discountMode,
      discount_amount: 0, tax_rate: selectedProduct.tax_rate ?? 19, tax_amount: 0, line_total: 0, notes: null,
      commercial_unit: value.configuration.unit, commercial_factor: value.configuration.factor,
      commercial_mapping_id: value.configuration.mappingId, commercial_price_raw: value.commercialPrice,
      commercial_quantity_raw: value.commercialQuantity, internal_price_raw: value.internalPrice,
    }])
    closeProductPicker(); setDirty(true); setError('')
  }

  function addService() {
    const description = newService.description.trim()
    const quantity = Number(newService.quantity)
    const unitPrice = Number(newService.unitPrice)
    const discountPercent = Number(newService.discountPercent)
    const taxRate = Number(newService.taxRate)
    if (!description) {
      setError('La descripción del servicio es obligatoria.')
      return
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.')
      return
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError('El precio unitario no puede ser negativo.')
      return
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      setError('El descuento debe estar entre 0 y 100.')
      return
    }
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      setError('El IVA debe estar entre 0 y 100.')
      return
    }
    setLines((current) => [
      ...current,
      {
        item_id: `new-${++newItemSequence.current}`,
        client_id: `new-${newItemSequence.current}`,
        line_number: current.length + 1,
        item_type: 'SERVICE',
        product_id: null,
        sku: null,
        product_description: description,
        unit: null,
        quantity,
        unit_price: unitPrice,
        discount_percent: discountPercent,
        discount_unit_amount: 0,
        discount_mode: discountPercent > 0 ? 'percent' : null,
        discount_amount: 0,
        tax_rate: taxRate,
        tax_amount: 0,
        line_total: 0,
        notes: newService.notes.trim() || null,
      },
    ])
    setNewService({
      description: '',
      quantity: '1',
      unitPrice: '0',
      discountPercent: '0',
      taxRate: '19',
      notes: '',
    })
    setServicePickerOpen(false)
    setDirty(true)
    setError('')
  }

  function addCreatedProduct(product: LocalCreatedProduct, quantity: number, unitPrice: number) {
    setLines((current) => [
      ...current,
      {
        item_id: `new-${++newItemSequence.current}`,
        client_id: `new-${newItemSequence.current}`,
        line_number: current.length + 1,
        item_type: 'PRODUCT',
        product_id: product.id,
        sku: product.sku,
        product_description: product.description,
        unit: null,
        quantity,
        unit_price: unitPrice,
        discount_percent: 0,
        discount_unit_amount: 0,
        discount_mode: null,
        discount_amount: 0,
        tax_rate: product.tax_rate,
        tax_amount: 0,
        line_total: 0,
        notes: null,
      },
    ])
    setCatalogCache((current) =>
      current.some((item) => item.id === product.id)
        ? current
        : [
            ...current,
            {
              id: product.id,
              sku: product.sku,
              barcode: product.barcode,
              description: product.description,
              unit_of_measure: null,
              tax_rate: product.tax_rate,
              bsale_variant_id: product.bsale_variant_id,
              last_purchase_unit_cost: null,
            },
          ],
    )
    setNewProductModalOpen(false)
    closeProductPicker()
    setDirty(true)
    setMessage('Producto creado en Bsale y agregado a la revisión.')
    setError('')
  }

  async function saveReview() {
    if (saving || saveInFlight.current || confirming || confirmationUncertain) return
    if (commercial) {
      if (conflict && !pendingRequest) { setError('Recarga la revisión antes de volver a guardar.'); return }
      if (!pendingRequest && !changesPending) { setMessage('No hay cambios pendientes de guardar.'); return }
      if (!pendingRequest && (revision === null || lines.length === 0 || lines.some(line => !commercialReviewValidQuantity(line.quantity, line.commercial_factor) || (line.commercial_factor !== undefined && !/^\d+(?:[.,]\d{0,4})?$/.test(line.commercial_price_raw ?? ''))))) {
        setError('Revisa las cantidades, los múltiplos de la presentación y los precios comerciales (máximo cuatro decimales).')
        return
      }
      const request = pendingRequest ?? { poId, requestId: crypto.randomUUID(), revision: revision!, items: payloadItems(lines) }
      try { sessionStorage.setItem(requestKey, JSON.stringify(request)) } catch { setError('No se pudo conservar la clave de guardado. Revisa el almacenamiento del navegador.'); return }
      saveInFlight.current = true
      setPendingRequest(request)
      setSaving(true)
      setError('')
      try {
        const result = await saveCommercialSupplierReview(request)
        if ('error' in result && result.error) {
          if (result.definite) {
            sessionStorage.removeItem(requestKey)
            setPendingRequest(null)
            if (result.error.includes('La revisión cambió')) setConflict(true)
          }
          setError(result.definite ? result.error : `${result.error}. El resultado es incierto; vuelve a intentar el mismo guardado.`)
          return
        }
        if (!('data' in result) || !result.data?.success) { setError('No se pudo verificar el guardado; vuelve a intentar.'); return }
        sessionStorage.removeItem(requestKey)
        setPendingRequest(null)
        await loadComparison()
        try { await onSaved?.() } catch { setError('La revisión se guardó, pero no se pudo actualizar el listado. Vuelve a abrir la orden.') }
        setMessage('Revisión guardada')
      } catch {
        setError('No se pudo verificar el resultado. Vuelve a intentar el mismo guardado para recuperarlo sin duplicar cambios.')
      } finally { saveInFlight.current = false; setSaving(false) }
      return
    }
    if (lines.length === 0) {
      setError('La orden debe conservar al menos una línea. Si el proveedor rechazó todo el pedido, cancela la OC.')
      return
    }
    setSaving(true)
    setError('')
    const payload: SupplierReviewData = {
      items: lines.map((line) => ({
        item_id: line.item_id?.startsWith('new-') ? null : line.item_id,
        item_type: line.item_type,
        product_id: line.product_id,
        product_description: line.item_type === 'SERVICE' ? line.product_description : undefined,
        quantity: line.quantity,
        unit_price: line.unit_price,
        ...getPurchaseOrderDiscountPayload(line),
        tax_rate: line.tax_rate,
        notes: line.notes,
      })),
    }
    const result = await updateSentPurchaseOrderReview(poId, payload)
    if ('error' in result && result.error) {
      setError(result.error)
      setSaving(false)
      return
    }
    await loadComparison()
    setMessage('Revisión guardada')
    await onSaved?.()
    setSaving(false)
  }

  function openConfirmDialog() {
    if (confirmDialogOpen || confirming || saving || confirmDisabledReason) return
    setError('')
    setConfirmDialogOpen(true)
  }

  async function confirmReview() {
    if (confirmInFlight.current || confirming || saving || confirmDisabledReason) return
    confirmInFlight.current = true
    setConfirming(true)
    setError('')
    try {
      const result = commercial ? await confirmCommercialPurchaseOrder(poId, revision!) : await confirmPurchaseOrderSupplierReview(poId)
      if ('error' in result) {
        if (result.error) {
          if (commercial && result.error.includes('La revisión cambió')) {
            setConflict(true)
            setConfirmationUncertain(false)
            setConfirmDialogOpen(false)
          } else if (commercial && /fetch|network|timeout|timed out|conexi[oó]n/i.test(result.error)) {
            setConfirmationUncertain(true)
            setError('No se pudo verificar el resultado. Reintenta la confirmación para recuperarlo.')
            return
          }
          setError(result.error)
        }
        return
      }
      if (result.success && result.status === 'CONFIRMADA') {
        setConfirmDialogOpen(false)
        try { await onConfirmed?.() } catch { setError('La OC se confirmó, pero no se pudo actualizar la interfaz. Reintenta la confirmación para recuperar el resultado.') ; setConfirmationUncertain(commercial); setConfirmDialogOpen(true) }
      } else {
        setError('No se pudo confirmar la OC.')
      }
    } catch (reason) {
      if (commercial) setConfirmationUncertain(true)
      setError(commercial ? 'No se pudo verificar el resultado. Reintenta la confirmación para recuperarlo.' : reason instanceof Error ? reason.message : 'No se pudo confirmar la OC.')
    } finally {
      confirmInFlight.current = false
      setConfirming(false)
    }
  }

  function leave() {
    if (saving || confirming) return
    if ((changesPending || pendingRequest) && !confirm('Hay cambios sin guardar o un guardado pendiente. ¿Deseas salir?')) return
    onBack()
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#EFE9E1] text-sm text-[#6D625B]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando comparación...
      </div>
    )
  }

  if (error && !comparison) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#EFE9E1] p-6 text-center">
        <p className="text-sm text-[#72383D]">{error}</p>
        <button onClick={() => void loadComparison()} className="rounded-md border border-[#72383D] px-3 py-2 text-xs font-semibold text-[#72383D]">Reintentar carga</button>
        <button onClick={leave} className="rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-[#322D29]">
          Volver
        </button>
      </div>
    )
  }

  if (!comparison) return null
  const { po, summary } = comparison
  const displayCurrentTotal = changesPending ? preview.grand_total : summary.current_grand_total
  const displayDifference = displayCurrentTotal - summary.original_grand_total
  const commercialStatuses = lines.map(line => {
    const original = comparison.original.items.find(item => item.item_id === line.item_id)
    return !original ? 'AGREGADA' : commercialReviewChangedFields(original as unknown as Record<string, unknown>, { ...line, commercial_unit_price: line.commercial_price_raw ?? null }).length ? 'MODIFICADA' : 'SIN_CAMBIOS'
  })
  const summaryCards = [
    ['Sin cambios', commercial ? commercialStatuses.filter(s => s === 'SIN_CAMBIOS').length : summary.unchanged_count, false],
    ['Modificadas', commercial ? commercialStatuses.filter(s => s === 'MODIFICADA').length : summary.modified_count, false],
    ['Eliminadas', commercial ? removedLines.length : summary.removed_count, false],
    ['Agregadas', commercial ? commercialStatuses.filter(s => s === 'AGREGADA').length : summary.added_count, false],
    ['Total original', currency(summary.original_grand_total, po.currency, commercial), false],
    ['Total actual', currency(displayCurrentTotal, po.currency, commercial), changesPending],
    ['Diferencia', signedCurrency(displayDifference, po.currency, commercial), changesPending],
  ] as const

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[#EFE9E1] text-[#322D29]">
      <header className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 bg-[#322D29] px-4 py-3 text-[#EFE9E1] shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={leave} className="rounded-md p-1.5 hover:bg-white/10" title="Volver">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4 text-[#D1C7BD]" />
              <h1 className="text-sm font-bold">Confirmación del proveedor</h1>
              <span className="font-mono text-xs text-[#D1C7BD]">OC {po.correlative}</span>
            </div>
            <p className="text-[11px] text-[#D1C7BD]">Proveedor: {po.supplier_name || '—'} · Estado: ENVIADA_PROVEEDOR</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#D1C7BD]">{pendingRequest ? 'Guardado pendiente de verificar' : changesPending ? 'Cambios sin guardar' : message}</span>
          <button onClick={() => void saveReview()} disabled={saving || confirming || confirmationUncertain || (commercial && !pendingRequest && (!changesPending || conflict))} className="inline-flex items-center gap-1.5 rounded-md bg-[#EFE9E1] px-3 py-2 text-xs font-bold text-[#72383D] disabled:opacity-50">
            <Save className="h-3.5 w-3.5" /> {saving ? 'Guardando...' : pendingRequest ? 'Reintentar guardado' : 'Guardar revisión'}
          </button>
          <button type="button" onClick={openConfirmDialog} disabled={Boolean(confirmDisabledReason) || saving || confirming} title={confirmDisabledReason || 'Confirmar la orden de compra'} className="inline-flex items-center gap-1.5 rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-bold text-[#EFE9E1] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
            Confirmar OC
          </button>
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-auto p-4 lg:p-6">
        {error && <div className="mb-3 border border-[#72383D]/30 bg-[#F5EDEE] px-3 py-2 text-xs text-[#72383D]">{error}</div>}
        {conflict && <button type="button" onClick={() => { if (confirm('Se descartarán los cambios locales. ¿Recargar la revisión?')) void loadComparison() }} className="mb-3 rounded border border-[#72383D] px-3 py-2 text-xs font-semibold text-[#72383D]">Recargar revisión</button>}
        {commercial && <p className="mb-3 text-xs text-[#6D625B]">Revisión comercial · versión {revision} · Las diferencias se comparan con ORIGINAL_SENT.</p>}
        <fieldset disabled={saving || confirming || confirmationUncertain || Boolean(pendingRequest) || conflict}>
        <section className="mb-4 grid grid-cols-2 gap-3 border border-[#D1C7BD] bg-white/60 p-3 text-xs md:grid-cols-4 xl:grid-cols-7">
          {[
            ['Proveedor', po.supplier_name],
            ['RUT', po.supplier_rut],
            ['Bodega', po.warehouse_name],
            ['Fecha emisión', dateValue(po.issue_date)],
            ['Fecha requerida', dateValue(po.required_date)],
            ['Condición de pago', po.payment_terms],
            ['Moneda', po.currency],
          ].map(([label, value]) => (
            <div key={label as string}>
              <p className="text-[10px] uppercase tracking-wider text-[#AC9C8D]">{label}</p>
              <p className="mt-1 font-medium">{value || '—'}</p>
            </div>
          ))}
        </section>

        <section className="mb-4 grid gap-px border border-[#D1C7BD] bg-[#D1C7BD] md:grid-cols-7">
          {summaryCards.map(([label, value, pending]) => (
            <div key={label} className="bg-white/80 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-[#AC9C8D]">
                {label}
                {pending && <span className="ml-1 normal-case tracking-normal text-[#AC9C8D]">Sin guardar</span>}
              </p>
              <p className="mt-1 text-sm font-bold tabular-nums">{value}</p>
            </div>
          ))}
        </section>

        <section className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-[#AC9C8D]" />
            <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Buscar por SKU o producto..." aria-label="Buscar por SKU o producto" className={`${inputClass} pl-7`} />
          </div>
          <div className="flex items-center gap-3">
            {searchQuery.trim() && (
              <span className="text-[11px] text-[#AC9C8D]">
                Mostrando {visibleLines.length} de {lines.length} productos
              </span>
            )}
            <button type="button" onClick={() => setShowDiscountColumns((visible) => !visible)} className="rounded-md border border-[#AC9C8D] bg-white/70 px-3 py-2 text-xs font-semibold text-[#6D625B] hover:bg-[#EFE9E1]">
              {showDiscountColumns ? 'Ocultar columnas de descuento' : 'Ver / agregar descuentos'}
            </button>
          </div>
        </section>

        <section className="mb-4 overflow-x-auto border border-[#D1C7BD] bg-white">
          <table className={`${showDiscountColumns ? 'min-w-[1340px]' : 'min-w-[1180px]'} w-full border-collapse text-xs`}>
            <thead>
              <tr className="bg-[#322D29] text-[10px] uppercase tracking-wider text-[#EFE9E1]">
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Producto</th>
                <th className="px-3 py-2 text-left">Unidad</th>
                <th className="px-3 py-2 text-right">{commercial ? 'Cantidad interna' : 'Cantidad'}</th>
                {commercial && <><th className="px-3 py-2 text-center">Unidad de compra</th><th className="px-3 py-2 text-center">Cantidad comercial</th></>}
                <th className="px-3 py-2 text-right">P. unitario</th>
                {commercial && <th className="px-3 py-2 text-center">Precio comercial</th>}
                {showDiscountColumns && (
                  <>
                    <th className="px-3 py-2 text-right">Dcto %</th>
                    <th className="px-3 py-2 text-right">Dcto/U Neto</th>
                  </>
                )}
                <th className="px-3 py-2 text-right">IVA %</th>
                <th className="px-3 py-2 text-right">Neto</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {visibleLines.map((line) => {
                const persisted = line.item_id ? statuses.get(line.item_id) : undefined
                const original = commercial ? comparison.original.items.find(item => item.item_id === line.item_id) : undefined
                const changes = original ? commercialReviewChangedFields(original as unknown as Record<string, unknown>, { ...line, commercial_unit_price: line.commercial_price_raw ?? null }) : []
                const status = commercial ? !original ? 'AGREGADA' : changes.length ? 'MODIFICADA' : 'SIN_CAMBIOS' : persisted?.comparison_status === 'ELIMINADA' && persisted.original_item ? (matchesOriginal(line, persisted.original_item) ? 'SIN_CAMBIOS' : 'MODIFICADA') : (persisted?.comparison_status ?? 'AGREGADA')
                const lineTotals = commercial ? calculateCommercialDraftLineTotals(line) : calculatePurchaseOrderLineTotals(line)
                return (
                  <tr key={line.item_id ?? `${line.product_id}-${line.line_number}`} className="border-b border-[#E5DDD4] align-top">
                    <td className="px-3 py-2">
                      <span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold ${statusStyle(status)}`}>{statusLabel(status)}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[#72383D]">{line.sku || '—'}</td>
                    <td className="px-3 py-2 font-medium">
                      {line.product_description}
                      {line.restore_pending && <p className="text-[10px] text-[#72383D]">Guarda la restauración original antes de editarla.</p>}
                      {commercial && changes.length > 0 && <div className="mt-1 space-y-0.5 text-[10px] text-[#72383D]">{changes.map(change => <div key={change.field}>Original {changedFieldLabel(change.field)}: {displayValue(change.original, change.field, po.currency, true)} → {displayValue(change.current, change.field, po.currency, true)}</div>)}</div>}
                      {line.unit_price === 0 && <span className="ml-2 text-[10px] text-[#AC9C8D]">Precio pendiente</span>}
                      {!commercial && persisted?.comparison_status === 'MODIFICADA' && (
                        <div className="mt-1 space-y-0.5 text-[10px] text-[#AC9C8D]">
                          {persisted.changed_fields.map((change) => (
                            <div key={change.field}>
                              Antes {changedFieldLabel(change.field)}: {displayValue(change.original, change.field, po.currency)}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{line.unit || '—'}</td>
                    <td className="px-3 py-2">
                      <input disabled={line.restore_pending} aria-label={`Cantidad ${line.product_description}`} type="number" min="0" step="0.0001" value={line.quantity} onChange={(event) => updateLine(line.item_id, 'quantity', event.target.value)} className={`${inputClass} w-24 text-right`} />
                      {commercial && <span className="block text-[10px] text-[#6D625B]">Total unidades</span>}
                      {commercial && line.commercial_factor !== undefined && !commercialReviewValidQuantity(line.quantity, line.commercial_factor) && <div className="text-[10px] text-[#72383D]">Debe ser múltiplo de {line.commercial_factor}</div>}
                    </td>
                    {commercial && <><td className="px-2 py-1.5 text-center"><PurchaseCommercialPresentation unit={line.commercial_unit} factor={line.commercial_factor} /></td><td className="px-2 py-1.5 text-center">{line.commercial_factor !== undefined ? <PurchaseCommercialQuantity description={line.product_description} unit={line.commercial_unit} value={line.commercial_quantity_raw ?? ''} disabled={line.restore_pending} onChange={value => updateLine(line.item_id, 'commercial_quantity_raw', value)} /> : '—'}</td></>}
                    <td className="px-3 py-2">
                      <input disabled={line.restore_pending} aria-label={`Precio ${line.product_description}`} type="number" min="0" step="0.0001" value={commercial ? line.internal_price_raw ?? line.unit_price : line.unit_price} onChange={(event) => updateLine(line.item_id, 'unit_price', event.target.value)} className={`${inputClass} w-28 text-right`} />
                    </td>
                    {commercial && <td className="px-2 py-1.5 text-center">{line.commercial_factor !== undefined ? <PurchaseCommercialPrice description={line.product_description} unit={line.commercial_unit} value={line.commercial_price_raw ?? ''} disabled={line.restore_pending} onChange={value => updateLine(line.item_id, 'commercial_price_raw', value)} /> : '—'}</td>}
                    {showDiscountColumns && (
                      <>
                        <td className="px-3 py-2">
                          <input disabled={line.restore_pending} aria-label={`Dcto % ${line.product_description}`} type="number" min="0" max="100" step="0.01" value={discountPercentDisplay(line) > 0 ? discountPercentDisplay(line) : ''} placeholder="0" onChange={(event) => updateLine(line.item_id, 'discount_percent', event.target.value)} className={`${inputClass} w-20 text-right`} />
                        </td>
                        <td className="px-3 py-2">
                          <input disabled={line.restore_pending} aria-label={`Dcto/U Neto ${line.product_description}`} type="number" min="0" max={line.unit_price} step="0.0001" value={discountUnitAmountDisplay(line) > 0 ? discountUnitAmountDisplay(line) : ''} placeholder="0" onChange={(event) => updateLine(line.item_id, 'discount_unit_amount', event.target.value)} className={`${inputClass} w-28 text-right`} />
                        </td>
                      </>
                    )}
                    <td className="px-3 py-2">
                      <input disabled={line.restore_pending} aria-label={`IVA ${line.product_description}`} type="number" min="0" max="100" step="0.01" value={line.tax_rate} onChange={(event) => updateLine(line.item_id, 'tax_rate', event.target.value)} className={`${inputClass} w-20 text-right`} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{currency(lineTotals.net_amount, po.currency, commercial)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{currency(lineTotals.line_total, po.currency, commercial)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeLine(line.item_id)} className="rounded p-1.5 text-[#6D625B] hover:bg-[#F5EDEE] hover:text-[#72383D]" title="Eliminar línea">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        {!productPickerOpen && (
          <section className="mb-4 flex flex-wrap gap-2 border border-[#D1C7BD] bg-white/70 p-3">
            <button type="button" onClick={() => void openCatalog()} disabled={catalogLoading} className="inline-flex items-center gap-1.5 rounded-md border border-[#72383D]/40 px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#72383D]/10 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" /> {catalogLoading ? 'Cargando catálogo...' : 'Agregar producto'}
            </button>
            <button type="button" onClick={() => setServicePickerOpen(true)} className="inline-flex items-center gap-1.5 rounded-md border border-[#72383D]/40 px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#72383D]/10">
              <Plus className="h-3.5 w-3.5" /> Agregar servicio
            </button>
          </section>
        )}
        {servicePickerOpen && (
          <section className="mb-4 border border-[#D1C7BD] bg-white/70 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-[#6D625B]">Nuevo servicio</span>
              <button type="button" onClick={() => setServicePickerOpen(false)} className="rounded-md border border-[#D1C7BD] px-2 py-1 text-[11px] font-semibold text-[#6D625B]">
                Cerrar
              </button>
            </div>
            <div className="grid gap-2 md:grid-cols-5">
              <label className="text-[10px] font-semibold md:col-span-2">
                Descripción *
                <input
                  value={newService.description}
                  onChange={(event) =>
                    setNewService((prev) => ({
                      ...prev,
                      description: event.target.value,
                    }))
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="text-[10px] font-semibold">
                Cantidad
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={newService.quantity}
                  onChange={(event) =>
                    setNewService((prev) => ({
                      ...prev,
                      quantity: event.target.value,
                    }))
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="text-[10px] font-semibold">
                Precio
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newService.unitPrice}
                  onChange={(event) =>
                    setNewService((prev) => ({
                      ...prev,
                      unitPrice: event.target.value,
                    }))
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="text-[10px] font-semibold">
                Dto %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={newService.discountPercent}
                  onChange={(event) =>
                    setNewService((prev) => ({
                      ...prev,
                      discountPercent: event.target.value,
                    }))
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
              <label className="text-[10px] font-semibold">
                IVA %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={newService.taxRate}
                  onChange={(event) =>
                    setNewService((prev) => ({
                      ...prev,
                      taxRate: event.target.value,
                    }))
                  }
                  className={`${inputClass} mt-1`}
                />
              </label>
            </div>
            <label className="mt-2 block text-[10px] font-semibold">
              Observaciones
              <textarea
                rows={2}
                value={newService.notes}
                onChange={(event) =>
                  setNewService((prev) => ({
                    ...prev,
                    notes: event.target.value,
                  }))
                }
                className={`${inputClass} mt-1 h-auto py-1`}
              />
            </label>
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={addService} className="rounded-md bg-[#72383D] px-3 py-2 text-xs font-semibold text-white">
                Agregar servicio
              </button>
            </div>
          </section>
        )}
        {productPickerOpen && !selectedProduct && (
          <section className="mb-4 max-w-2xl border border-[#D1C7BD] bg-white/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[#6D625B]">Buscar producto</span>
              <button type="button" onClick={closeProductPicker} className="rounded-md border border-[#D1C7BD] px-2 py-1 text-[11px] font-semibold text-[#6D625B] hover:bg-[#EFE9E1]">
                Cerrar
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-[#AC9C8D]" />
              <input autoFocus value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Buscar por SKU, descripción o código de barra" className={`${inputClass} pl-7`} />
            </div>
            <div className="mt-2 max-h-[220px] overflow-y-auto divide-y divide-[#E5DDD4] border border-[#D1C7BD]">
              {visibleProducts.map((product) => (
                <button type="button" key={product.id} disabled={resolvingProduct} onClick={() => void selectProduct(product)} className="block w-full px-2 py-1.5 text-left text-xs hover:bg-[#EFE9E1]">
                  <span className="font-mono text-[#72383D]">{product.sku}</span> · {product.description} <span className="text-[#AC9C8D]">({product.barcode || 'sin código'})</span>
                </button>
              ))}
              {visibleProducts.length === 0 && (
                <div className="flex items-center justify-between gap-3 px-2 py-3 text-xs">
                  <span className="text-[#AC9C8D]">No encontramos el producto en el catálogo.</span>
                  {!commercial && <button type="button" onClick={() => setNewProductModalOpen(true)} className="whitespace-nowrap rounded-md bg-[#72383D] px-2.5 py-1.5 font-semibold text-white">
                    + Crear producto nuevo
                  </button>}
                </div>
              )}
            </div>
          </section>
        )}
        {productPickerOpen && selectedProduct && commercial && <PurchaseOrderCommercialProductForm key={selectedProduct.id} product={selectedProduct} configuration={productCommercial ? { unit: productCommercial.purchase_unit, factor: productCommercial.purchase_unit_factor, mappingId: productCommercial.mapping_id } : null} loading={resolvingProduct} showDiscounts={showDiscountColumns} currency={po.currency} onAdd={addCommercialProduct} onCancel={closeProductPicker} />}
        {productPickerOpen && selectedProduct && !commercial && (
          <section className="mb-4 border border-[#D1C7BD] bg-white/70 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold">{selectedProduct.description}</p>
                <p className="font-mono text-[11px] text-[#72383D]">{selectedProduct.sku}</p>
                {commercial && productCommercial && <p className="text-[11px]">{productCommercial.purchase_unit || 'Unidad'} × {productCommercial.purchase_unit_factor} {selectedProduct.unit_of_measure || 'unid.'}; ingresa cantidad y precio internos.</p>}
              </div>
              <input aria-label="Cantidad nuevo producto" type="number" min="0" step="0.01" value={newQuantity} onChange={(event) => setNewQuantity(event.target.value)} className={`${inputClass} w-24`} />
              <input aria-label="Precio nuevo producto" type="number" min="0" step="0.01" value={newUnitPrice} onChange={(event) => setNewUnitPrice(event.target.value)} className={`${inputClass} w-28`} />
              <button type="button" onClick={addProduct} className="rounded-md bg-[#72383D] px-3 py-2 text-xs font-semibold text-white">
                Agregar
              </button>
              <button type="button" onClick={closeProductPicker} className="rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-[#6D625B] hover:bg-[#EFE9E1]">
                Cancelar
              </button>
            </div>
          </section>
        )}

        {removedLines.length > 0 && (
          <section className="mb-4 border border-[#D1C7BD] bg-white/70 p-3">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#6D625B]">Productos no disponibles / eliminados</h2>
            <div className="overflow-x-auto">
              <table className="min-w-[820px] w-full text-xs">
                <thead>
                  <tr className="border-b border-[#D1C7BD] text-left text-[10px] uppercase text-[#AC9C8D]">
                    <th className="py-2">Estado</th>
                    <th>SKU</th>
                    <th>Descripción</th>
                    <th className="text-right">Cantidad</th>
                    <th className="text-right">Precio</th>
                    <th className="text-right">Total</th>
                    <th className="text-right">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {removedLines.map((line) => (
                    <tr key={line.item_id} className="border-b border-[#E5DDD4]">
                      <td className="py-2">
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusStyle('ELIMINADA')}`}>Eliminada</span>
                      </td>
                      <td className="font-mono">{line.original_item?.sku || '—'}</td>
                      <td>{line.original_item?.product_description || '—'}</td>
                      <td className="text-right">{line.original_item?.quantity ?? '—'}</td>
                      <td className="text-right">{currency(line.original_item?.unit_price, po.currency)}</td>
                      <td className="text-right font-semibold">{currency(line.original_item?.line_total, po.currency, commercial)}</td>
                      <td className="text-right">
                        <button type="button" onClick={() => restoreLine(line.original_item)} className="rounded border border-[#72383D]/40 px-2 py-1 text-[11px] font-semibold text-[#72383D] hover:bg-[#72383D]/10">
                          Restaurar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="flex justify-end border-t border-[#D1C7BD] pt-3">
          <div className="w-72 space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-[#AC9C8D]">Subtotal bruto</span>
              <span>{currency(preview.gross_total, po.currency, commercial)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#AC9C8D]">Descuentos</span>
              <span>{currency(preview.discount_total, po.currency, commercial)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#AC9C8D]">Neto final</span>
              <span>{currency(preview.net_total, po.currency, commercial)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#AC9C8D]">IVA</span>
              <span>{currency(preview.tax_total, po.currency, commercial)}</span>
            </div>
            <div className="flex justify-between border-t border-[#D1C7BD] pt-1 font-bold text-[#72383D]">
              <span>Total OC</span>
              <span>{currency(preview.grand_total, po.currency, commercial)}</span>
            </div>
          </div>
        </section>
        </fieldset>
        {confirmDialogOpen && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#322D29]/60 p-4">
            <section role="dialog" aria-modal="true" aria-labelledby="confirm-purchase-order-title" className="w-full max-w-md border border-[#D1C7BD] bg-[#EFE9E1] p-5 text-[#322D29] shadow-xl">
              <h2 id="confirm-purchase-order-title" className="text-base font-bold text-[#72383D]">
                Confirmar orden de compra
              </h2>
              <div className="mt-3 space-y-1 text-xs">
                <p>
                  <span className="font-semibold">OC:</span> {po.correlative}
                </p>
                <p>
                  <span className="font-semibold">Proveedor:</span> {po.supplier_name || '—'}
                </p>
                <p>
                  <span className="font-semibold">Total definitivo:</span> {currency(displayCurrentTotal, po.currency, commercial)}
                </p>
              </div>
              <div className="mt-3 border-y border-[#D1C7BD] py-3 text-xs">
                <p className="font-semibold">Resumen</p>
                <p>Modificadas: {commercial ? commercialStatuses.filter(s => s === 'MODIFICADA').length : summary.modified_count}</p>
                <p>Eliminadas: {commercial ? removedLines.length : summary.removed_count}</p>
                <p>Agregadas: {commercial ? commercialStatuses.filter(s => s === 'AGREGADA').length : summary.added_count}</p>
              </div>
              <p className="mt-3 text-xs text-[#6D625B]">Esta acción cerrará la revisión del proveedor y dejará esta versión como definitiva. Después de confirmar, la OC ya no podrá editarse desde esta pantalla.{commercial && commercialReceiptEnabled === false && ' La recepción comercial aún no está disponible.'}</p>
              {error && <p className="mt-3 border border-[#72383D]/30 bg-[#F5EDEE] px-3 py-2 text-xs text-[#72383D]">{error}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmDialogOpen(false)} disabled={confirming || confirmationUncertain} className="rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-[#6D625B] disabled:opacity-50">
                  Cancelar
                </button>
                <button type="button" onClick={() => void confirmReview()} disabled={confirming || Boolean(confirmDisabledReason)} className="rounded-md bg-[#72383D] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  {confirming ? 'Confirmando...' : 'Confirmar definitivamente'}
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
      <PurchaseOrderNewProductModal poId={poId} open={newProductModalOpen} onClose={() => setNewProductModalOpen(false)} onCreated={addCreatedProduct} />
    </div>
  )
}
