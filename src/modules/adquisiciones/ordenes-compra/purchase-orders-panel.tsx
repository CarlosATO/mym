'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Search, Plus, Filter, X, Eye, Edit, Download, FileSpreadsheet, Ban, PackageOpen, XCircle, CheckCircle2, BarChart3, RefreshCw, Loader2, ClipboardCheck, Send, Lock } from 'lucide-react'
import { AuthorizedPersonnelCombobox } from '@/components/ui/authorized-personnel-combobox'
import {
  getPurchaseOrders, getPurchaseOrderIndicators, getPurchaseOrderDetail, createPurchaseOrder, updateDraftPurchaseOrder,
  updatePurchaseOrderStatus, cancelPurchaseOrder, closePurchaseOrderWithPending, getAuthorizedPersonnel, createAuthorizedPersonnel,
  getNextCorrelative, getPurchaseOrderDocumentDetail, getPurchaseOrderInvoiceSummaries,
  type PurchaseOrder, type PurchaseOrderDetail, type PurchaseOrderFilters, type PurchaseOrderOperationalView, type PurchaseOrderInvoiceDocument, type PurchaseOrderInvoiceSummaries, type PurchaseOrderIndicators,
  type AuthorizedPersonnel
} from '@/app/actions/adquisiciones/purchase-orders'
import { getSuppliers, type Supplier } from '@/app/actions/adquisiciones/suppliers'
import { searchPurchaseOrderProducts } from '@/app/actions/adquisiciones/products'
import { getPurchaseOrderProductCatalogCached, prefetchPurchaseOrderProductCatalog } from './purchase-order-product-cache'
import { getPurchaseOrderWarehousesCached } from './warehouse-cache'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'
import type { Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { downloadPOBooklet, generatePdfBlob } from '@/lib/pdf/generate-po-pdf'
import { generatePurchaseOrderExcel } from '@/lib/excel/generate-po-excel'
import { buildPurchaseOrderFileNameBase } from '@/lib/adquisiciones/purchase-order-file-name'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { OperationalTableResizeHandle, shouldIgnoreOperationalRowDoubleClick, useOperationalTableWidths, type OperationalTableColumn } from '@/components/ui/operational-table'
import { ReplenishmentAnalysisPanel } from './replenishment-analysis-panel'
import { buildReplenishmentExcelPreparation, parseReplenishmentExcel, type ReplenishmentExcelImportPreview } from './replenishment-excel-import'
import { ReplenishmentExcelImportDialog } from './replenishment-excel-import-dialog'
import { PurchaseOrderSupplierReview } from './purchase-order-supplier-review'
import { PurchaseOrderInvoiceViewerModal } from './purchase-order-invoice-viewer-modal'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import { formatCivilDate } from '@/lib/datetime'
import { calculatePurchaseOrderLineTotals, calculatePurchaseOrderTotals } from '@/lib/adquisiciones/purchase-order-totals'
import { getPurchaseOrderDiscountDisplayValues, getPurchaseOrderDiscountPayload, resolvePurchaseOrderDiscountMode, type PurchaseOrderDiscountMode } from '@/lib/adquisiciones/purchase-order-discounts'

const STATUS_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  BORRADOR: { bg: 'bg-gray-500/10', text: 'text-gray-500', border: 'border-gray-500/20' },
  EMITIDA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  PENDIENTE_APROBACION: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  APROBADA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  ENVIADA_PROVEEDOR: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' },
  CONFIRMADA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  RECEPCION_PARCIAL: { bg: 'bg-amber-500/10', text: 'text-amber-600', border: 'border-amber-500/25' },
  RECEPCION_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  FACTURADA_PARCIAL: { bg: 'bg-purple-500/10', text: 'text-purple-500', border: 'border-purple-500/20' },
  FACTURADA_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  CERRADA: { bg: 'bg-gray-500/10', text: 'text-gray-500', border: 'border-gray-500/20' },
  CANCELADA: { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' },
  RECHAZADA: { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' },
}

const RECEIPT_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  PENDIENTE: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  RECEPCION_PARCIAL: { bg: 'bg-amber-500/10', text: 'text-amber-600', border: 'border-amber-500/25' },
  RECEPCION_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
}

const PURCHASE_ORDERS_TABLE_KEY = 'mym:table:adquisiciones:ordenes-compra:compact-v3a'
const REPLENISHMENT_PO_PREPARATION_KEY = 'mym:adquisiciones:replenishment-po-preparation'
const PURCHASE_ORDER_PRODUCT_PAGE_SIZE = 40
const PURCHASE_ORDER_LIST_CACHE_TTL = 30_000
const PURCHASE_ORDER_INDICATORS_CACHE_TTL = 30_000
const PURCHASE_ORDER_OPERATIONAL_VIEWS: Array<{ value: PurchaseOrderOperationalView; label: string }> = [
  { value: 'PENDING', label: 'Pendientes' },
  { value: 'RECEIVED', label: 'Recibidas' },
  { value: 'CLOSED', label: 'Cerradas' },
  { value: 'CANCELLED', label: 'Anuladas' },
  { value: 'ALL', label: 'Todas' },
]
const PURCHASE_ORDER_COLUMNS: OperationalTableColumn[] = [
  { id: 'correlative', defaultWidth: 100, minWidth: 88, maxWidth: 150 },
  { id: 'issueDate', defaultWidth: 95, minWidth: 88, maxWidth: 135 },
  { id: 'supplier', defaultWidth: 245, minWidth: 180, maxWidth: 430 },
  { id: 'requester', defaultWidth: 150, minWidth: 125, maxWidth: 280 },
  { id: 'status', defaultWidth: 130, minWidth: 115, maxWidth: 230 },
  { id: 'total', defaultWidth: 120, minWidth: 110, maxWidth: 175 },
  { id: 'receipt', defaultWidth: 125, minWidth: 115, maxWidth: 205 },
  { id: 'invoice', defaultWidth: 125, minWidth: 115, maxWidth: 205 },
  { id: 'actions', defaultWidth: 110, minWidth: 96, maxWidth: 155, sticky: 'right', resizable: false },
]

function formatCurrency(amount: number, currency = 'CLP') {
  return amount.toLocaleString('es-CL', { style: 'currency', currency })
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—'
  return formatCivilDate(dateStr) || '—'
}

function shortCorrelative(correlative: string) {
  return correlative.match(/\d+$/)?.[0] || correlative
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    BORRADOR: 'Borrador', EMITIDA: 'Emitida', PENDIENTE_APROBACION: 'Pendiente Aprob.', APROBADA: 'Aprobada',
    ENVIADA_PROVEEDOR: 'Enviada Prov.', CONFIRMADA: 'Confirmada', RECEPCION_PARCIAL: 'Recep. Parcial',
    RECEPCION_TOTAL: 'Recep. Total', FACTURADA_PARCIAL: 'Fact. Parcial',
    FACTURADA_TOTAL: 'Fact. Total', CERRADA: 'Cerrada', CANCELADA: 'Cancelada',
    RECHAZADA: 'Rechazada',
  }
  return map[s] || s
}

const CLOSED_WITH_PENDING_LABEL = 'Cerrada con saldo pendiente'

function purchaseOrderStatusLabel(po: Pick<PurchaseOrder, 'status' | 'closed_with_pending'>) {
  return po.status === 'CERRADA' && po.closed_with_pending ? CLOSED_WITH_PENDING_LABEL : undefined
}

type CachedPurchaseOrderList = { data: PurchaseOrder[]; total: number; updatedAt: number }

function purchaseOrderListCacheKey(scope: string, filters: PurchaseOrderFilters) {
  return JSON.stringify({
    scope,
    operational_view: filters.operational_view ?? 'PENDING',
    search: filters.search ?? '',
    status: filters.status ?? '',
    supplier_id: filters.supplier_id ?? '',
    po_type: filters.po_type ?? '',
    date_from: filters.date_from ?? '',
    date_to: filters.date_to ?? '',
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 50,
  })
}

function purchaseOrderInvoiceCacheKey(scope: string, poIds: string[]) {
  return `${scope}:${Array.from(new Set(poIds)).sort().join(',')}`
}

function Badge({ value, map, label }: { value: string | null; map: Record<string, { bg: string; text: string; border: string }>; label?: string }) {
  if (!value) return <span className="text-[11px] text-theme-text-muted/40">—</span>
  const s = map[value]
  if (!s) return <span className="text-[11px] text-theme-text-muted/40">{value}</span>
  return <span className={`inline-flex whitespace-nowrap text-[11px] font-semibold px-2 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}>{label ?? statusLabel(value)}</span>
}

function PurchaseOrderInvoiceCell({ documents, loading, onView }: { documents?: PurchaseOrderInvoiceDocument[]; loading: boolean; onView: () => void }) {
  if (!documents) return <span className="text-[11px] text-theme-text-muted/50">{loading ? 'Cargando...' : 'Pendiente'}</span>
  if (documents.length === 0) return <span className="inline-flex whitespace-nowrap rounded border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-500">Pendiente</span>
  const label = documents.length === 1 ? documents[0].document_number || 'Factura' : `${documents.length} facturas`
  return (
    <button type="button" onClick={event => { event.stopPropagation(); onView() }} className="inline-flex max-w-full items-center gap-1.5 text-left text-[11px] font-semibold text-theme-accent hover:text-theme-accent-hover hover:underline" title={documents.length === 1 ? documents[0].document_number || 'Ver factura' : 'Ver facturas'}>
      <span className="truncate">{label}</span><span className="shrink-0">Ver</span>
    </button>
  )
}

const inputClass = "w-full h-8 rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] placeholder:text-[#AC9C8D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15 focus:border-[#72383D]"
const selectClass = "w-full h-8 rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15 focus:border-[#72383D] appearance-none"
const textareaClass = "w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 py-1.5 text-xs text-[#322D29] placeholder:text-[#AC9C8D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15 focus:border-[#72383D] resize-none"

export function PurchaseOrdersPanel({ initialOpenPoId, onInitialOpenConsumed, prepareReplenishment = false }: { initialOpenPoId?: string | null, onInitialOpenConsumed?: () => void, prepareReplenishment?: boolean }) {
  const [view, setView] = useState<'list' | 'form' | 'detail' | 'analysis' | 'supplier-review'>('list')
  const [selectedPo, setSelectedPo] = useState<PurchaseOrder | null>(null)
  const detailCacheRef = useRef<Record<string, PurchaseOrderDetail>>({})
  const pendingRequestsRef = useRef<Record<string, Promise<PurchaseOrderDetail | null>>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const [data, setData] = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [invoiceSummaries, setInvoiceSummaries] = useState<PurchaseOrderInvoiceSummaries>({})
  const [invoiceSummariesLoading, setInvoiceSummariesLoading] = useState(false)
  const [indicators, setIndicators] = useState<PurchaseOrderIndicators | null>(null)
  const [indicatorsLoading, setIndicatorsLoading] = useState(false)
  const [invoiceViewerPo, setInvoiceViewerPo] = useState<PurchaseOrder | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [filters, setFilters] = useState<PurchaseOrderFilters>({ operational_view: 'PENDING', page: 1, pageSize: 50 })
  const [searchInput, setSearchInput] = useState('')
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)
  const [supplierReviewPoId, setSupplierReviewPoId] = useState<string | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [authorizedPersonnel, setAuthorizedPersonnel] = useState<AuthorizedPersonnel[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<PurchaseOrderCatalogProduct[]>([])
  const [productSearchLoading, setProductSearchLoading] = useState(false)
  const [productDropdownOpen, setProductDropdownOpen] = useState(false)
  const [productPage, setProductPage] = useState(0)
  const [productHasMore, setProductHasMore] = useState(false)
  const [productLoadingMore, setProductLoadingMore] = useState(false)
  const productSearchCacheRef = useRef(new Map<string, { data: PurchaseOrderCatalogProduct[]; has_more: boolean }>())
  const productSearchRequestSequence = useRef(0)
  const productSearchTimerRef = useRef<number | null>(null)
  const productLoadingMoreRef = useRef(false)
  const [showAuthorizerForm, setShowAuthorizerForm] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [authorizerForm, setAuthorizerForm] = useState({
    full_name: '', position: '', email: '', phone: '',
  })
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewDetailRef = useRef<any>(null)
  const [supplierSearch, setSupplierSearch] = useState('')
  const [logoBase64, setLogoBase64] = useState<string | undefined>(undefined)
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [replenishmentSupplierName, setReplenishmentSupplierName] = useState('')
  const [isReplenishmentPreparation, setIsReplenishmentPreparation] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isMarkingSent, setIsMarkingSent] = useState(false)
  const [closePendingPo, setClosePendingPo] = useState<PurchaseOrder | null>(null)
  const [closeReason, setCloseReason] = useState('')
  const [closeError, setCloseError] = useState('')
  const [closingPending, setClosingPending] = useState(false)
  const [cancelPendingPo, setCancelPendingPo] = useState<PurchaseOrder | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelError, setCancelError] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [downloadingExcel, setDownloadingExcel] = useState(false)
  const [excelImportPreview, setExcelImportPreview] = useState<ReplenishmentExcelImportPreview | null>(null)
  const [excelImportLoading, setExcelImportLoading] = useState(false)
  const [showAllExcelImportRows, setShowAllExcelImportRows] = useState(false)
  const submittingRef = useRef(false)
  const productInputRef = useRef<HTMLInputElement>(null)
  const excelImportInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/logo-transparent.png')
      .then(res => res.blob())
      .then(blob => {
        const reader = new FileReader()
        reader.onloadend = () => setLogoBase64(reader.result as string)
        reader.readAsDataURL(blob)
      })
      .catch(err => console.error('Error preloading logo for PDF:', err))

    getActiveCompany().then(comp => setActiveCompany(comp))
  }, [])
  const [supplierOpen, setSupplierOpen] = useState(false)
  const supplierRef = useRef<HTMLDivElement>(null)
  const productRef = useRef<HTMLDivElement>(null)
  const [warehouseSearch, setWarehouseSearch] = useState('')
  const [warehouseOpen, setWarehouseOpen] = useState(false)
  const warehouseRef = useRef<HTMLDivElement>(null)
  const requestSequence = useRef(0)
  const loaded = useRef(false)
  const purchaseOrderListCacheRef = useRef(new Map<string, CachedPurchaseOrderList>())
  const purchaseOrderListRequestsRef = useRef(new Map<string, Promise<CachedPurchaseOrderList>>())
  const purchaseOrderCacheScopeRef = useRef<string | null>(null)
  const purchaseOrderCacheGenerationRef = useRef(0)
  const purchaseOrderInvoiceCacheRef = useRef(new Map<string, PurchaseOrderInvoiceSummaries>())
  const purchaseOrderInvoiceRequestsRef = useRef(new Map<string, Promise<PurchaseOrderInvoiceSummaries>>())
  const purchaseOrderIndicatorsCacheRef = useRef(new Map<string, { data: PurchaseOrderIndicators; updatedAt: number }>())
  const purchaseOrderIndicatorsRequestsRef = useRef(new Map<string, Promise<PurchaseOrderIndicators | null>>())
  const { widths, setColumnWidth, persist, reset: resetWidths } = useOperationalTableWidths(PURCHASE_ORDERS_TABLE_KEY, PURCHASE_ORDER_COLUMNS)

  const [form, setForm] = useState({
    issue_date: new Date().toISOString().slice(0, 10),
    required_date: '',
    supplier_id: '',
    warehouse_id: '',
    po_type: 'PRODUCTOS',
    currency: 'CLP',
    payment_terms: '',
    authorized_by: '',
    notes: '',
  })

  interface LineItem {
    tempId: string
    item_type: 'PRODUCT' | 'SERVICE'
    product_id: string
    sku: string
    description: string
    unit: string
    quantity: number
    unit_price: number
    reference_unit_cost?: number
    discount_percent: number
    discount_unit_amount: number
    discount_mode: PurchaseOrderDiscountMode
    tax_rate: number
    warehouse_id: string
    notes: string
  }

  const [items, setItems] = useState<LineItem[]>([])
  const [showDiscountColumns, setShowDiscountColumns] = useState(false)
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [invalidPriceItemIds, setInvalidPriceItemIds] = useState<Set<string>>(new Set())
  const linePriceInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [pendingProduct, setPendingProduct] = useState<PurchaseOrderCatalogProduct | null>(null)
  const [pendingQuantity, setPendingQuantity] = useState('1')
  const [pendingUnitPrice, setPendingUnitPrice] = useState('')
  const [pendingDiscountPercent, setPendingDiscountPercent] = useState(0)
  const [pendingDiscountUnitAmount, setPendingDiscountUnitAmount] = useState(0)
  const [pendingDiscountMode, setPendingDiscountMode] = useState<PurchaseOrderDiscountMode>(null)
  const [showServiceForm, setShowServiceForm] = useState(false)
  const [serviceDraft, setServiceDraft] = useState({
    description: '', quantity: '1', unitPrice: '', discountPercent: '0', taxRate: '19', notes: '',
  })

  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  interface DraftPrompt {
    draftData: {
      version: number
      savedAt: string
      form: {
        issue_date: string
        required_date: string
        supplier_id: string
        warehouse_id: string
        po_type: string
        currency: string
        payment_terms: string
        authorized_by: string
        notes: string
      }
      items: LineItem[]
      isReplenishmentPreparation?: boolean
      replenishmentSupplierName?: string
    }
    supplierName: string
    itemCount: number
    savedAtFormatted: string
  }
  const [draftPrompt, setDraftPrompt] = useState<DraftPrompt | null>(null)
  const justEmittedRef = useRef(false)
  const draftHandledRef = useRef(false)

  useEffect(() => {
    const supabase = createBrowserClient()
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user?.id) setCurrentUserId(data.user.id)
    })
  }, [])

  const draftStorageKey = activeCompany?.id && currentUserId
    ? `mym:adquisiciones:purchase-order-draft:${activeCompany.id}:${currentUserId}`
    : null

  const tempIdCounter = useRef(0)
  function newTempId() { tempIdCounter.current += 1; return `ni_${tempIdCounter.current}` }

  async function buildLineItems(detailItems: PurchaseOrderDetail['items']): Promise<LineItem[]> {
    const productIds = detailItems
      .filter(item => item.item_type !== 'SERVICE' && item.product_id)
      .map(item => item.product_id as string)
    const productsById = new Map<string, PurchaseOrderCatalogProduct>()
    if (productIds.length > 0) {
      try {
        const catalog = await getPurchaseOrderProductCatalogCached()
        catalog.forEach(product => productsById.set(product.id, product))
      } catch {
        // A missing catalog must not prevent editing the purchase order.
      }
    }

    return detailItems.map(i => ({
      tempId: i.id,
      item_type: (i.item_type === 'SERVICE' ? 'SERVICE' : 'PRODUCT') as 'PRODUCT' | 'SERVICE',
      product_id: i.product_id || '',
      sku: i.item_type === 'SERVICE' ? '' : productsById.get(i.product_id || '')?.sku || '',
      description: i.product_description || '',
      unit: i.unit || 'UNIDAD',
      quantity: i.quantity || 0,
      unit_price: i.unit_price || 0,
      discount_percent: i.discount_percent || 0,
      discount_unit_amount: i.discount_unit_amount ?? 0,
      discount_mode: resolvePurchaseOrderDiscountMode(i.discount_percent, i.discount_unit_amount),
      tax_rate: i.tax_rate || 19,
      warehouse_id: i.warehouse_id || '',
      notes: i.notes || '',
    }))
  }

  interface ReplenishmentPreparationPayload {
    source: 'REPLENISHMENT' | 'EXCEL'
    supplier?: { id: string; name: string }
    items: Array<{
      product_id: string
      sku: string
      product_description: string
      unit: string
      quantity: number
      unit_price: number
      reference_unit_cost: number
      discount_percent: number
      discount_unit_amount?: number
      tax_rate: number
    }>
  }

  const totalPages = Math.ceil(total / (filters.pageSize ?? 50))

  const purchaseOrderCacheScope = `${currentUserId ?? 'anonymous'}:${activeCompany?.id ?? 'unknown'}`

  const fetchCachedPurchaseOrderIndicators = useCallback(async (force = false) => {
    const key = purchaseOrderCacheScope
    const cached = purchaseOrderIndicatorsCacheRef.current.get(key)
    if (!force && cached && Date.now() - cached.updatedAt < PURCHASE_ORDER_INDICATORS_CACHE_TTL) return cached.data
    if (!force) {
      const pending = purchaseOrderIndicatorsRequestsRef.current.get(key)
      if (pending) return pending
    }
    const request = getPurchaseOrderIndicators().then(result => {
      if (result) purchaseOrderIndicatorsCacheRef.current.set(key, { data: result, updatedAt: Date.now() })
      return result
    })
    const trackedRequest = request.finally(() => {
      if (purchaseOrderIndicatorsRequestsRef.current.get(key) === trackedRequest) purchaseOrderIndicatorsRequestsRef.current.delete(key)
    })
    purchaseOrderIndicatorsRequestsRef.current.set(key, trackedRequest)
    return trackedRequest
  }, [purchaseOrderCacheScope])

  const fetchCachedPurchaseOrders = useCallback(async (requestFilters: PurchaseOrderFilters, force = false) => {
    const key = purchaseOrderListCacheKey(purchaseOrderCacheScope, requestFilters)
    const generation = purchaseOrderCacheGenerationRef.current
    const cached = purchaseOrderListCacheRef.current.get(key)
    if (!force && cached && Date.now() - cached.updatedAt < PURCHASE_ORDER_LIST_CACHE_TTL) return cached
    if (!force) {
      const pending = purchaseOrderListRequestsRef.current.get(key)
      if (pending) return pending
    }

    const request = getPurchaseOrders(requestFilters)
      .then(result => {
        const next = { data: result.data, total: result.total, updatedAt: Date.now() }
        if (generation === purchaseOrderCacheGenerationRef.current) {
          purchaseOrderListCacheRef.current.set(key, next)
        }
        return next
      })
    const trackedRequest = request.finally(() => {
      if (purchaseOrderListRequestsRef.current.get(key) === trackedRequest) {
        purchaseOrderListRequestsRef.current.delete(key)
      }
    })
    purchaseOrderListRequestsRef.current.set(key, trackedRequest)
    return trackedRequest
  }, [purchaseOrderCacheScope])

  const fetchCachedPurchaseOrderInvoices = useCallback(async (poIds: string[], force = false) => {
    if (poIds.length === 0) return {}
    const key = purchaseOrderInvoiceCacheKey(purchaseOrderCacheScope, poIds)
    const generation = purchaseOrderCacheGenerationRef.current
    const cached = purchaseOrderInvoiceCacheRef.current.get(key)
    if (!force && cached) return cached
    if (!force) {
      const pending = purchaseOrderInvoiceRequestsRef.current.get(key)
      if (pending) return pending
    }
    const request = getPurchaseOrderInvoiceSummaries(poIds)
    const trackedRequest = request.finally(() => {
      if (purchaseOrderInvoiceRequestsRef.current.get(key) === trackedRequest) {
        purchaseOrderInvoiceRequestsRef.current.delete(key)
      }
    })
    trackedRequest.then(result => {
      if (generation === purchaseOrderCacheGenerationRef.current) {
        purchaseOrderInvoiceCacheRef.current.set(key, result)
      }
    }).catch(() => undefined)
    purchaseOrderInvoiceRequestsRef.current.set(key, trackedRequest)
    return trackedRequest
  }, [purchaseOrderCacheScope])

  const loadVisiblePurchaseOrderInvoices = useCallback((orders: PurchaseOrder[], requestId: number) => {
    const poIds = orders.map(order => order.id)
    if (poIds.length === 0) return
    setInvoiceSummariesLoading(true)
    void fetchCachedPurchaseOrderInvoices(poIds).then(result => {
      if (requestId !== requestSequence.current) return
      setInvoiceSummaries(previous => ({ ...previous, ...result }))
    }).catch(() => {
      if (requestId === requestSequence.current) setInvoiceSummaries(previous => ({ ...previous }))
    }).finally(() => {
      if (requestId === requestSequence.current) setInvoiceSummariesLoading(false)
    })
  }, [fetchCachedPurchaseOrderInvoices])

  const prefetchPurchaseOrderViews = useCallback((baseFilters: PurchaseOrderFilters) => {
    const secondaryViews = PURCHASE_ORDER_OPERATIONAL_VIEWS.filter(view => view.value !== baseFilters.operational_view)
    void Promise.all(secondaryViews.map(async view => {
      const result = await fetchCachedPurchaseOrders({ ...baseFilters, operational_view: view.value })
      await fetchCachedPurchaseOrderInvoices(result.data.map(order => order.id))
    })).catch(() => undefined)
  }, [fetchCachedPurchaseOrderInvoices, fetchCachedPurchaseOrders])

  const invalidatePurchaseOrderListCache = useCallback(() => {
    purchaseOrderCacheGenerationRef.current += 1
    purchaseOrderListCacheRef.current.clear()
    purchaseOrderListRequestsRef.current.clear()
    purchaseOrderInvoiceCacheRef.current.clear()
    purchaseOrderInvoiceRequestsRef.current.clear()
    purchaseOrderIndicatorsCacheRef.current.clear()
    purchaseOrderIndicatorsRequestsRef.current.clear()
    setInvoiceSummaries({})
    setIndicators(null)
    if (activeCompany?.id) {
      setIndicatorsLoading(true)
      void fetchCachedPurchaseOrderIndicators(true).then(result => setIndicators(result)).finally(() => setIndicatorsLoading(false))
    }
  }, [activeCompany?.id, fetchCachedPurchaseOrderIndicators])

  const load = useCallback(async ({ force = false } = {}) => {
    const requestId = ++requestSequence.current
    const key = purchaseOrderListCacheKey(purchaseOrderCacheScope, filters)
    const cached = !force ? purchaseOrderListCacheRef.current.get(key) : undefined
    const hasFreshCache = Boolean(cached && Date.now() - cached.updatedAt < PURCHASE_ORDER_LIST_CACHE_TTL)
    if (cached) {
      setData(cached.data)
      setTotal(cached.total)
      setInitialLoading(false)
      loaded.current = true
      loadVisiblePurchaseOrderInvoices(cached.data, requestId)
    } else if (loaded.current) setRefreshing(true)
    else setInitialLoading(true)

    if (cached && hasFreshCache && !force) {
      setRefreshing(false)
      prefetchPurchaseOrderViews(filters)
      return
    }

    if (cached && !force) setRefreshing(true)
    try {
      const res = await fetchCachedPurchaseOrders(filters, force)
      if (requestId !== requestSequence.current) return
      setData(res.data)
      setTotal(res.total)
      loaded.current = true
      loadVisiblePurchaseOrderInvoices(res.data, requestId)
      prefetchPurchaseOrderViews(filters)
    } catch {
      if (requestId === requestSequence.current) msg('No se pudieron actualizar las órdenes de compra.')
    } finally {
      if (requestId === requestSequence.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [fetchCachedPurchaseOrders, filters, loadVisiblePurchaseOrderInvoices, prefetchPurchaseOrderViews, purchaseOrderCacheScope])

  useEffect(() => {
    const previousScope = purchaseOrderCacheScopeRef.current
    if (previousScope && previousScope !== purchaseOrderCacheScope) {
      invalidatePurchaseOrderListCache()
      requestSequence.current += 1
      loaded.current = false
      setData([])
      setTotal(0)
    }
    purchaseOrderCacheScopeRef.current = purchaseOrderCacheScope
  }, [invalidatePurchaseOrderListCache, purchaseOrderCacheScope])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!activeCompany?.id) return
    setIndicatorsLoading(true)
    void fetchCachedPurchaseOrderIndicators().then(result => setIndicators(result)).finally(() => setIndicatorsLoading(false))
  }, [activeCompany?.id, fetchCachedPurchaseOrderIndicators])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchInput.trim() || undefined
      setFilters(previous => previous.search === search ? previous : { ...previous, search, page: 1 })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  function poColumn(id: string) { return PURCHASE_ORDER_COLUMNS.find(column => column.id === id)! }
  function resizeHandle(id: string) {
    const column = poColumn(id)
    return <OperationalTableResizeHandle column={column} width={widths[id] ?? column.defaultWidth} onResize={width => setColumnWidth(column, width)} onResizeEnd={persist} />
  }

  const openPOById = useCallback(async (poId: string, mode: 'detail' | 'edit' = 'detail') => {
    if (mode === 'detail' && selectedPo?.id === poId) return;
    if (mode === 'edit' && editId === poId) return;
    
    // Mientras carga mostramos el listado o dejamos la vista actual, 
    // pero si es edit mode podríamos mostrar form vacio. 
    // Lo más seguro es mantener la vista y esperar a tener datos.
    if (mode === 'detail') setDetail(null);
    
    const d = await getPurchaseOrderDetail(poId);
    if (d) {
      if (mode === 'detail') {
        setSelectedPo(d.po as PurchaseOrder);
        setDetail(d);
        detailCacheRef.current[poId] = d;
        setView('list');
      } else {
        setForm({
          issue_date: d.po.issue_date?.slice(0, 10) || '',
          required_date: d.po.required_date?.slice(0, 10) || '',
          supplier_id: d.po.supplier_id || '',
          warehouse_id: d.po.warehouse_id || '',
          po_type: d.po.po_type || 'PRODUCTOS',
          currency: d.po.currency || 'CLP',
          payment_terms: d.po.payment_terms || '',
          authorized_by: d.po.authorized_by || '',
          notes: d.po.notes || '',
        });
         setEditId(d.po.id);
         setIsReplenishmentPreparation(d.po.source_type === 'REPLENISHMENT');
         setItems(await buildLineItems(d.items));
        setSelectedPo(null);
        setView('form');
      }
      
      if (data.length === 0) load();
    } else {
      msg('Error al cargar detalle de la orden.');
    }
  }, [selectedPo?.id, editId, data.length, load]);

  const consumedOpenPoIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialOpenPoId && initialOpenPoId !== consumedOpenPoIdRef.current && initialOpenPoId !== editId) {
      consumedOpenPoIdRef.current = initialOpenPoId;
      openPOById(initialOpenPoId, 'edit').then(() => {
        onInitialOpenConsumed?.();
      });
    }
  }, [initialOpenPoId, editId, openPOById, onInitialOpenConsumed]);

  useEffect(() => {
    Promise.all([
      getSuppliers(),
      getPurchaseOrderWarehousesCached(),
      getAuthorizedPersonnel(),
    ]).then(([sup, warehouses, auth]) => {
      setSuppliers(sup)
      setWarehouses(warehouses)
      setAuthorizedPersonnel(auth)
    })
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (supplierRef.current && !supplierRef.current.contains(e.target as Node)) setSupplierOpen(false)
      if (warehouseRef.current && !warehouseRef.current.contains(e.target as Node)) setWarehouseOpen(false)
      if (productRef.current && !productRef.current.contains(e.target as Node)) setProductDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (!form.supplier_id) return
    prefetchPurchaseOrderProductCatalog()
    const supplier = suppliers.find(s => s.id === form.supplier_id)
    if (!supplier) return
    if (!isReplenishmentPreparation && supplier.discount_percent > 0) {
      setItems(prev => prev.map(it => ({
        ...it,
        discount_percent: supplier.discount_percent,
        discount_unit_amount: 0,
        discount_mode: 'percent',
      })))
    }
    if (supplier.payment_terms) {
      setForm(p => ({ ...p, payment_terms: supplier.payment_terms || p.payment_terms }))
    }
  }, [form.supplier_id, isReplenishmentPreparation, suppliers])

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  function applyReplenishmentPreparation(payload: ReplenishmentPreparationPayload) {
    sessionStorage.removeItem(REPLENISHMENT_PO_PREPARATION_KEY)
    setForm(prev => ({ ...prev, supplier_id: payload.supplier?.id ?? '', po_type: 'PRODUCTOS', currency: 'CLP' }))
    setReplenishmentSupplierName(payload.supplier?.name ?? '')
    setIsReplenishmentPreparation(payload.source === 'REPLENISHMENT')
    setItems(payload.items.map(item => ({
      tempId: newTempId(),
      item_type: 'PRODUCT' as const,
      product_id: item.product_id,
      sku: item.sku,
      description: item.product_description,
      unit: item.unit || 'UNIDAD',
      quantity: item.quantity,
       unit_price: item.unit_price,
       reference_unit_cost: item.reference_unit_cost ?? item.unit_price,
       discount_percent: item.discount_percent ?? 0,
       discount_unit_amount: item.discount_unit_amount ?? 0,
       discount_mode: resolvePurchaseOrderDiscountMode(item.discount_percent, item.discount_unit_amount),
       tax_rate: item.tax_rate,
      warehouse_id: '',
      notes: '',
    })))
    setEditId(null)
    draftHandledRef.current = true
    setView('form')
  }

  useEffect(() => {
    if (!prepareReplenishment || typeof window === 'undefined') return

    const raw = sessionStorage.getItem(REPLENISHMENT_PO_PREPARATION_KEY)
    try {
      const payload = raw ? JSON.parse(raw) as ReplenishmentPreparationPayload : null
      const valid = (payload?.source === 'REPLENISHMENT' || payload?.source === 'EXCEL')
        && (payload.source === 'EXCEL' || Boolean(payload.supplier?.id && payload.supplier?.name))
        && Array.isArray(payload.items)
        && payload.items.length > 0
        && payload.items.every(item => Boolean(item.product_id && item.sku && item.product_description)
          && Number.isFinite(item.quantity) && item.quantity > 0
          && Number.isFinite(item.unit_price) && Number.isFinite(item.reference_unit_cost ?? item.unit_price)
          && Number.isFinite(item.discount_percent) && Number.isFinite(item.tax_rate))
      if (!valid) {
        msg('La preparación de la orden de compra ya no está disponible.')
        return
      }

       applyReplenishmentPreparation(payload)
    } catch {
      msg('La preparación de la orden de compra ya no está disponible.')
    }
  }, [prepareReplenishment])

  async function handleExcelImportChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setExcelImportLoading(true)
    setMessage('')
    try {
      const catalog = await getPurchaseOrderProductCatalogCached()
      setExcelImportPreview(await parseReplenishmentExcel(file, catalog))
      setShowAllExcelImportRows(false)
    } catch (error) {
      setExcelImportPreview(null)
      setShowAllExcelImportRows(false)
      msg(error instanceof Error ? error.message : 'No se pudo analizar el archivo Excel.')
    } finally {
      setExcelImportLoading(false)
    }
  }

  async function handlePrepareExcelPurchaseOrder() {
    if (!excelImportPreview || excelImportPreview.validRows === 0) return
    setExcelImportLoading(true)
    setMessage('')
    try {
      const catalog = await getPurchaseOrderProductCatalogCached()
      const availableSuppliers = suppliers.length > 0 ? suppliers : await getSuppliers()
      const preparation = buildReplenishmentExcelPreparation(excelImportPreview, catalog, availableSuppliers)
      if (preparation.items.length === 0) return
      const payload: ReplenishmentPreparationPayload = {
        source: 'EXCEL',
        ...preparation,
      }
      sessionStorage.setItem(REPLENISHMENT_PO_PREPARATION_KEY, JSON.stringify(payload))
      setExcelImportPreview(null)
      setShowAllExcelImportRows(false)
      applyReplenishmentPreparation(payload)
    } catch (error) {
      msg(error instanceof Error ? error.message : 'No se pudo preparar la Orden de Compra desde el archivo.')
    } finally {
      setExcelImportLoading(false)
    }
  }

  // Auto-recovery check when opening New PO form
  useEffect(() => {
    if (view !== 'form' || editId !== null || !draftStorageKey || typeof window === 'undefined') return
    if (draftHandledRef.current) return
    if (prepareReplenishment) return
    const rawRepl = sessionStorage.getItem(REPLENISHMENT_PO_PREPARATION_KEY)
    if (rawRepl) return

    try {
      const raw = localStorage.getItem(draftStorageKey)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.form &&
        typeof parsed.form === 'object' &&
        Array.isArray(parsed.items)
      ) {
        const hasContent =
          Boolean(parsed.form.supplier_id) ||
          Boolean(parsed.form.warehouse_id) ||
          Boolean(parsed.form.required_date) ||
          Boolean(parsed.form.authorized_by) ||
          Boolean(parsed.form.notes?.trim()) ||
          parsed.items.length > 0

        if (!hasContent) {
          localStorage.removeItem(draftStorageKey)
          return
        }

        const savedDate = parsed.savedAt ? new Date(parsed.savedAt) : null
        const timeStr = savedDate && !isNaN(savedDate.getTime())
          ? savedDate.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
          : ''

        let supplierName = parsed.replenishmentSupplierName || ''
        if (!supplierName && parsed.form.supplier_id && suppliers.length > 0) {
          const sup = suppliers.find(s => s.id === parsed.form.supplier_id)
          if (sup) supplierName = sup.business_name
        }

        setDraftPrompt({
          draftData: parsed,
          supplierName,
          itemCount: parsed.items.length,
          savedAtFormatted: timeStr,
        })
      } else {
        localStorage.removeItem(draftStorageKey)
      }
    } catch {
      try { localStorage.removeItem(draftStorageKey) } catch {}
    }
  }, [view, editId, draftStorageKey, prepareReplenishment, suppliers])

  function handleRestoreDraft() {
    if (!draftPrompt) return
    const d = draftPrompt.draftData
    setForm(d.form)
    setItems(d.items.map(item => ({
      ...item,
      discount_percent: item.discount_percent ?? 0,
      discount_unit_amount: item.discount_unit_amount ?? 0,
      discount_mode: resolvePurchaseOrderDiscountMode(item.discount_percent, item.discount_unit_amount),
    })))
    setIsReplenishmentPreparation(Boolean(d.isReplenishmentPreparation))
    setReplenishmentSupplierName(d.replenishmentSupplierName || '')
    setLastSavedAt(draftPrompt.savedAtFormatted)
    setDraftPrompt(null)
    draftHandledRef.current = true
  }

  function handleDiscardDraft() {
    if (draftStorageKey) {
      try { localStorage.removeItem(draftStorageKey) } catch {}
    }
    setDraftPrompt(null)
    setLastSavedAt(null)
    draftHandledRef.current = true
  }

  // Autosave effect (Debounce 1000ms)
  useEffect(() => {
    if (
      view !== 'form' ||
      editId !== null ||
      !draftStorageKey ||
      draftPrompt !== null ||
      isSubmitting ||
      submittingRef.current ||
      justEmittedRef.current
    ) {
      return
    }

    const hasContent =
      Boolean(form.supplier_id) ||
      Boolean(form.warehouse_id) ||
      Boolean(form.required_date) ||
      Boolean(form.authorized_by) ||
      Boolean(form.notes?.trim()) ||
      items.length > 0

    if (!hasContent) return

    const timer = setTimeout(() => {
      const nowIso = new Date().toISOString()
      const draftPayload = {
        version: 1,
        savedAt: nowIso,
        form,
        items,
        isReplenishmentPreparation,
        replenishmentSupplierName: replenishmentSupplierName || undefined,
      }
      try {
        localStorage.setItem(draftStorageKey, JSON.stringify(draftPayload))
        const timeStr = new Date(nowIso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
        setLastSavedAt(timeStr)
      } catch (err) {
        console.error('Error auto-saving purchase order draft:', err)
      }
    }, 1000)

    return () => clearTimeout(timer)
  }, [
    form,
    items,
    isReplenishmentPreparation,
    replenishmentSupplierName,
    view,
    editId,
    draftStorageKey,
    draftPrompt,
    isSubmitting
  ])

  function resetForm() {
    setForm({
      issue_date: new Date().toISOString().slice(0, 10),
      required_date: '',
      supplier_id: '',
      warehouse_id: '',
      po_type: 'PRODUCTOS',
      currency: 'CLP',
      payment_terms: '',
      authorized_by: '',
      notes: '',
    })
    setItems([])
    setShowDiscountColumns(false)
    setEditingItem(null)
    setInvalidPriceItemIds(new Set())
    linePriceInputRefs.current = {}
    setEditId(null)
    setProductSearch('')
    setProductResults([])
    setProductDropdownOpen(false)
    setProductPage(0)
    setProductHasMore(false)
    setProductSearchLoading(false)
    setProductLoadingMore(false)
    setPendingProduct(null)
    setPendingQuantity('1')
    setPendingUnitPrice('')
    setPendingDiscountPercent(0)
    setPendingDiscountUnitAmount(0)
    setPendingDiscountMode(null)
    setShowServiceForm(false)
    setServiceDraft({ description: '', quantity: '1', unitPrice: '', discountPercent: '0', taxRate: '19', notes: '' })
    productLoadingMoreRef.current = false
    setShowAuthorizerForm(false)
    setReplenishmentSupplierName('')
    setIsReplenishmentPreparation(false)
    submittingRef.current = false
    setIsSubmitting(false)
    setLastSavedAt(null)
    setDraftPrompt(null)
    draftHandledRef.current = false
    setTimeout(() => { justEmittedRef.current = false }, 50)
  }

  function editPO(po: PurchaseOrder) {
    setForm({
      issue_date: po.issue_date?.slice(0, 10) || '',
      required_date: po.required_date?.slice(0, 10) || '',
      supplier_id: po.supplier_id || '',
      warehouse_id: po.warehouse_id || '',
      po_type: po.po_type || 'PRODUCTOS',
      currency: po.currency || 'CLP',
      payment_terms: po.payment_terms || '',
      authorized_by: po.authorized_by || '',
      notes: po.notes || '',
    })
    setEditId(po.id)
    setView('form')
    loadDetailItems(po.id)
  }

  async function loadDetailItems(poId: string) {
    const d = await getPurchaseOrderDetail(poId)
    if (d) {
      setItems(await buildLineItems(d.items))
    }
  }

  function openDetail(po: PurchaseOrder) {
    setSelectedPo(po)
    setView('list')
    setDetail(null)
    
    if (detailCacheRef.current[po.id]) {
      setDetail(detailCacheRef.current[po.id])
      return
    }
    
    if (!pendingRequestsRef.current[po.id]) {
      pendingRequestsRef.current[po.id] = getPurchaseOrderDetail(po.id)
    }
    
    pendingRequestsRef.current[po.id].then(d => {
      if (d) {
        detailCacheRef.current[po.id] = d
        setDetail(prev => d)
      }
    })
  }

  function openSupplierReview(poId: string) {
    setSupplierReviewPoId(poId)
    setSelectedPo(null)
    setDetail(null)
    setView('supplier-review')
  }

  function prefetchDetail(poId: string) {
    if (detailCacheRef.current[poId]) return
    if (!pendingRequestsRef.current[poId]) {
      pendingRequestsRef.current[poId] = getPurchaseOrderDetail(poId).then(d => {
        if (d) detailCacheRef.current[poId] = d
        return d
      })
    }
  }


  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submittingRef.current) return
    if (items.length === 0) { msg('Agrega al menos una línea a la orden'); return }
    const invalidPriceItems = items.filter(item => item.quantity > 0 && (!Number.isFinite(item.unit_price) || item.unit_price <= 0))
    if (invalidPriceItems.length > 0) {
      setInvalidPriceItemIds(new Set(invalidPriceItems.map(item => item.tempId)))
      msg('Hay líneas sin precio unitario. Complete el precio antes de emitir la orden.')
      linePriceInputRefs.current[invalidPriceItems[0].tempId]?.focus()
      return
    }
    const invalidLine = items.find(item => !item.description.trim() || item.quantity <= 0 || item.discount_percent < 0 || item.discount_percent > 100 || item.tax_rate < 0 || item.tax_rate > 100 || (item.item_type === 'SERVICE' ? Boolean(item.product_id) : !item.product_id))
    if (invalidLine) {
      msg('Revisa descripción, cantidad, descuento, IVA y tipo de línea antes de emitir la orden.')
      return
    }
    submittingRef.current = true
    setIsSubmitting(true)
    try {
       const payload = {
         issue_date: form.issue_date,
        required_date: form.required_date,
        supplier_id: form.supplier_id,
         source_type: isReplenishmentPreparation ? ('REPLENISHMENT' as const) : ('MANUAL' as const),
        warehouse_id: form.warehouse_id,
        payment_terms: form.payment_terms || undefined,
        authorized_by: form.authorized_by || undefined,
        notes: form.notes || undefined,
        currency: form.currency,
         status: 'EMITIDA' as const,
         items: items.map(it => ({
          item_type: it.item_type,
          product_id: it.product_id || null,
          product_description: it.description,
          unit: it.unit || null,
          quantity: it.quantity,
          unit_price: it.unit_price,
          ...getPurchaseOrderDiscountPayload(it),
          tax_rate: it.tax_rate,
          warehouse_id: it.warehouse_id || null,
           notes: it.notes || null,
         })),
       }
       const res = editId ? await updateDraftPurchaseOrder(editId, payload) : await createPurchaseOrder(payload)
      if ('error' in res && res.error) {
        msg(res.error)
        submittingRef.current = false
        setIsSubmitting(false)
        return
      }
      justEmittedRef.current = true
      if (draftStorageKey) {
        try { localStorage.removeItem(draftStorageKey) } catch {}
      }
       msg(editId ? 'Orden de compra actualizada' : 'Orden de compra creada')
       invalidatePurchaseOrderListCache(); setView('list'); resetForm(); load()
    } catch (error) {
      submittingRef.current = false
      setIsSubmitting(false)
      msg(error instanceof Error ? error.message : 'Error al crear la orden de compra')
    }
  }

  function requestCancellation(po: PurchaseOrder) {
    setCancelPendingPo(po)
    setCancelReason('')
    setCancelError('')
  }

  async function handleCancellation() {
    if (!cancelPendingPo || cancelling) return
    const reason = cancelReason.trim()
    if (!reason) {
      setCancelError('El motivo de anulación es obligatorio')
      return
    }
    const poId = cancelPendingPo.id
    setCancelling(true)
    setCancelError('')
    try {
      const res = await cancelPurchaseOrder(poId, reason)
      if ('error' in res && res.error) {
        setCancelError(res.error)
        return
      }
      delete detailCacheRef.current[poId]
      delete pendingRequestsRef.current[poId]
      setCancelPendingPo(null)
      setCancelReason('')
      msg('Orden de compra anulada correctamente')
      invalidatePurchaseOrderListCache()
      await load()
      const updatedDetail = await getPurchaseOrderDetail(poId)
      if (updatedDetail) {
        detailCacheRef.current[poId] = updatedDetail
        setDetail(updatedDetail)
        if (selectedPo?.id === poId) setSelectedPo(updatedDetail.po as PurchaseOrder)
      }
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'No se pudo anular la orden de compra')
    } finally {
      setCancelling(false)
    }
  }

  const cancellationModal = cancelPendingPo ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 px-4" role="dialog" aria-modal="true" aria-labelledby="cancel-po-title">
      <div className="w-full max-w-md rounded-2xl border border-[#D1C7BD] bg-[#F7F4F0] p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="cancel-po-title" className="text-base font-bold text-[#322D29]">Anular orden de compra</h2>
            <p className="mt-1 text-xs text-[#6D625B]">Esta operación conserva los datos y deja trazabilidad.</p>
          </div>
          <button type="button" onClick={() => setCancelPendingPo(null)} disabled={cancelling} className="rounded-lg p-1 text-[#6D625B] hover:bg-[#D1C7BD]/40 disabled:opacity-50" aria-label="Cerrar"><X className="h-4 w-4" /></button>
        </div>
        <div className="mb-4 rounded-xl border border-[#D1C7BD] bg-white px-3 py-2 text-xs text-[#322D29]">
          <p><span className="font-semibold">OC:</span> {cancelPendingPo.correlative}</p>
          <p className="mt-1"><span className="font-semibold">Proveedor:</span> {cancelPendingPo.supplier_name}</p>
        </div>
        <label htmlFor="cancel-reason" className="mb-1.5 block text-xs font-semibold text-[#322D29]">Motivo de anulación <span className="text-red-500">*</span></label>
        <textarea id="cancel-reason" value={cancelReason} onChange={event => { setCancelReason(event.target.value); setCancelError('') }} disabled={cancelling} autoFocus rows={3} maxLength={500} placeholder="Ingrese el motivo de anulación" className={textareaClass} />
        {cancelError && <p className="mt-2 text-xs text-red-600" role="alert">{cancelError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setCancelPendingPo(null)} disabled={cancelling} className="rounded-xl border border-[#D1C7BD] px-3.5 py-2 text-xs font-semibold text-[#6D625B] hover:bg-[#D1C7BD]/30 disabled:opacity-50">Volver</button>
          <button type="button" onClick={() => void handleCancellation()} disabled={cancelling} className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50">
            {cancelling && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {cancelling ? 'Procesando...' : 'Confirmar anulación'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  function requestCloseWithPending(po: PurchaseOrder) {
    setCloseError('')
    setCloseReason('')
    setClosePendingPo(po)
    if (!detail || detail.po.id !== po.id) {
      void openDetail(po)
    }
  }

  async function handleCloseWithPending() {
    if (!closePendingPo || closingPending) return
    const reason = closeReason.trim()
    if (!reason) {
      setCloseError('El motivo de cierre es obligatorio')
      return
    }
    const poId = closePendingPo.id
    setClosingPending(true)
    setCloseError('')
    const res = await closePurchaseOrderWithPending(poId, reason)
    setClosingPending(false)
    if ('error' in res && res.error) {
      setCloseError(res.error)
      return
    }
    delete detailCacheRef.current[poId]
    delete pendingRequestsRef.current[poId]
    setClosePendingPo(null)
    setCloseReason('')
    msg(res.already_closed ? 'La orden de compra ya estaba cerrada' : 'Orden de compra cerrada con saldo pendiente')
    invalidatePurchaseOrderListCache()
    await load()
    const d = await getPurchaseOrderDetail(poId)
    if (d) {
      detailCacheRef.current[poId] = d
      setDetail(d)
      if (selectedPo?.id === poId) setSelectedPo(d.po as PurchaseOrder)
    }
  }

  const closePendingSummary = detail && closePendingPo && detail.po.id === closePendingPo.id
    ? detail.items.reduce((acc, item) => {
        const ordered = Number(item.quantity || 0)
        const received = Number(item.quantity_received || 0)
        acc.ordered += ordered
        acc.received += received
        acc.pending += Math.max(0, ordered - received)
        return acc
      }, { ordered: 0, received: 0, pending: 0 })
    : null

  async function handleMarkSentToSupplier(poId: string) {
    if (isMarkingSent) return
    if (!confirm('¿Confirmas que esta orden de compra ya fue enviada al proveedor?\n\nAl continuar se guardará una copia histórica de la versión enviada.')) return

    setIsMarkingSent(true)
    try {
      const res = await updatePurchaseOrderStatus(poId, 'ENVIADA_PROVEEDOR')
      if ('error' in res && res.error) {
        msg(res.error)
        return
      }

      delete detailCacheRef.current[poId]
      delete pendingRequestsRef.current[poId]
      invalidatePurchaseOrderListCache()
      await load()
      const updatedDetail = await getPurchaseOrderDetail(poId)
      if (updatedDetail) {
        setDetail(updatedDetail)
        setSelectedPo(updatedDetail.po as PurchaseOrder)
      }
      msg('OC marcada como enviada al proveedor')
    } catch (error) {
      msg(error instanceof Error ? error.message : 'No se pudo marcar la OC como enviada al proveedor')
    } finally {
      setIsMarkingSent(false)
    }
  }

  async function handleSupplierReviewSaved(poId: string) {
    delete detailCacheRef.current[poId]
    delete pendingRequestsRef.current[poId]
    invalidatePurchaseOrderListCache()
    await load()
  }

  async function handleSupplierReviewConfirmed(poId: string) {
    delete detailCacheRef.current[poId]
    delete pendingRequestsRef.current[poId]
    invalidatePurchaseOrderListCache()
    await load()
    setSupplierReviewPoId(null)
    setView('list')
    setDetail(null)
    setSelectedPo(null)
    msg('Orden de compra confirmada.')
  }

  function handleSupplierChange(supplierId: string) {
    if (supplierId !== form.supplier_id && form.supplier_id && items.length > 0) {
      const confirmed = confirm('Cambiar el proveedor eliminará los productos agregados a esta orden.\n¿Deseas continuar?')
      if (!confirmed) return
      setItems([])
    }
    if (supplierId !== form.supplier_id) {
      setProductSearch('')
      setProductResults([])
      setProductDropdownOpen(false)
      setProductPage(0)
      setProductHasMore(false)
      setProductSearchLoading(false)
      setProductLoadingMore(false)
      productLoadingMoreRef.current = false
      if (productSearchTimerRef.current !== null) window.clearTimeout(productSearchTimerRef.current)
      productSearchRequestSequence.current += 1
    }
    setForm(p => ({ ...p, supplier_id: supplierId }))
  }

  async function loadProductPage(supplierId: string, query: string, page: number, requestId: number, append: boolean) {
    const cacheKey = `${supplierId}::${query}::${page}`
    const cachedPage = productSearchCacheRef.current.get(cacheKey)
    if (cachedPage) {
      if (requestId !== productSearchRequestSequence.current) return
      setProductResults(prev => append
        ? Array.from(new Map([...prev, ...cachedPage.data].map(product => [product.id, product])).values())
        : cachedPage.data)
      setProductPage(page)
      setProductHasMore(cachedPage.has_more)
      setProductSearchLoading(false)
      setProductLoadingMore(false)
      productLoadingMoreRef.current = false
      return
    }

    try {
      const catalog = await getPurchaseOrderProductCatalogCached()
      if (requestId !== productSearchRequestSequence.current) return
      const normalizedQuery = query.trim().toLowerCase()
      const matches = catalog.filter(product => !normalizedQuery
        || product.sku.toLowerCase().includes(normalizedQuery)
        || product.description.toLowerCase().includes(normalizedQuery)
        || (product.barcode ?? '').toLowerCase().includes(normalizedQuery))
      const from = (page - 1) * PURCHASE_ORDER_PRODUCT_PAGE_SIZE
      const pageData = matches.slice(from, from + PURCHASE_ORDER_PRODUCT_PAGE_SIZE)
      setProductResults(prev => append
        ? Array.from(new Map([...prev, ...pageData].map(product => [product.id, product])).values())
        : pageData)
      setProductPage(page)
      setProductHasMore(from + pageData.length < matches.length)
      setProductSearchLoading(false)
      setProductLoadingMore(false)
      productLoadingMoreRef.current = false
      return
    } catch {
      // Fall back to the supplier-scoped server search if the catalog preload failed.
    }

    if (append) {
      setProductLoadingMore(true)
      productLoadingMoreRef.current = true
    } else {
      setProductSearchLoading(true)
    }

    try {
      const response = await searchPurchaseOrderProducts({ real_supplier_id: supplierId, search: query, page, limit: 40 })
      if (requestId !== productSearchRequestSequence.current) return
      if (response.error) {
        setProductResults([])
        setProductSearchLoading(false)
        setProductLoadingMore(false)
        productLoadingMoreRef.current = false
        msg(response.error)
        return
      }

      const pageData = {
        data: response.data.map(product => ({
          id: product.id,
          sku: product.sku,
          barcode: product.barcode,
          description: product.description,
          unit_of_measure: product.unit_of_measure,
          tax_rate: product.tax_rate,
          bsale_variant_id: product.bsale_variant_id ?? null,
          last_purchase_unit_cost: null,
        })),
        has_more: response.has_more,
      }
      productSearchCacheRef.current.set(cacheKey, pageData)
      if (productSearchCacheRef.current.size > 40) {
        const oldestKey = productSearchCacheRef.current.keys().next().value
        if (oldestKey) productSearchCacheRef.current.delete(oldestKey)
      }
      setProductResults(prev => append
        ? Array.from(new Map([...prev, ...pageData.data].map(product => [product.id, product])).values())
        : pageData.data)
      setProductPage(page)
      setProductHasMore(pageData.has_more)
      setProductSearchLoading(false)
      setProductLoadingMore(false)
      productLoadingMoreRef.current = false
    } catch {
      if (requestId !== productSearchRequestSequence.current) return
      setProductResults([])
      setProductSearchLoading(false)
      setProductLoadingMore(false)
      productLoadingMoreRef.current = false
    }
  }

  function openProductDropdown() {
    if (!form.supplier_id) return
    setProductDropdownOpen(true)
    if (productPage > 0 || productSearchLoading || productLoadingMore) return
    const requestId = ++productSearchRequestSequence.current
    void loadProductPage(form.supplier_id, productSearch.trim().toLowerCase(), 1, requestId, false)
  }

  function handleProductSearch(text: string) {
    setProductSearch(text)
    setProductDropdownOpen(Boolean(form.supplier_id))
    if (productSearchTimerRef.current !== null) window.clearTimeout(productSearchTimerRef.current)

    const query = text.trim().toLowerCase()
    const requestId = ++productSearchRequestSequence.current
    setProductPage(0)
    setProductHasMore(false)
    setProductLoadingMore(false)
    productLoadingMoreRef.current = false
    if (!form.supplier_id) {
      setProductResults([])
      setProductSearchLoading(false)
      return
    }

    const cacheKey = `${form.supplier_id}::${query}::1`
    const cachedPage = productSearchCacheRef.current.get(cacheKey)
    if (cachedPage) {
      setProductResults(cachedPage.data)
      setProductPage(1)
      setProductHasMore(cachedPage.has_more)
      setProductSearchLoading(false)
      return
    }

    setProductResults([])
    setProductSearchLoading(true)
    productSearchTimerRef.current = window.setTimeout(() => {
      void loadProductPage(form.supplier_id, query, 1, requestId, false)
    }, 300)
  }

  function handleProductDropdownScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!form.supplier_id || !productHasMore || productLoadingMoreRef.current || productSearchLoading) return
    const element = e.currentTarget
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 48) return
    const requestId = productSearchRequestSequence.current
    void loadProductPage(form.supplier_id, productSearch.trim().toLowerCase(), productPage + 1, requestId, true)
  }

  function selectProductForAddition(p: PurchaseOrderCatalogProduct) {
    if (items.some(it => it.product_id === p.id)) { msg('Este producto ya está en la orden'); return }
    setPendingProduct(p)
    setPendingQuantity('1')
    setPendingUnitPrice(p.last_purchase_unit_cost === null ? '' : String(p.last_purchase_unit_cost))
    setPendingDiscountPercent(0)
    setPendingDiscountUnitAmount(0)
    setPendingDiscountMode(null)
    setProductDropdownOpen(false)
  }

  function updatePendingDiscount(field: 'discount_percent' | 'discount_unit_amount', value: string) {
    const numeric = Number(value)
    const nextValue = Number.isFinite(numeric) ? Math.max(numeric, 0) : 0
    const unitPrice = Math.max(Number(pendingUnitPrice) || 0, 0)
    if (field === 'discount_percent') {
      const percent = Math.min(nextValue, 100)
      setPendingDiscountPercent(percent)
      setPendingDiscountUnitAmount(0)
      setPendingDiscountMode(percent > 0 ? 'percent' : null)
      return
    }
    const unitAmount = Math.min(nextValue, unitPrice)
    setPendingDiscountUnitAmount(unitAmount)
    setPendingDiscountPercent(0)
    setPendingDiscountMode(unitAmount > 0 ? 'unit' : null)
  }

  function updatePendingUnitPrice(value: string) {
    const unitPrice = Math.max(Number(value) || 0, 0)
    setPendingUnitPrice(value)
    if (pendingDiscountMode === 'unit') setPendingDiscountUnitAmount(current => Math.min(current, unitPrice))
  }

  function addProductToItems() {
    if (!pendingProduct) return
    if (items.some(it => it.product_id === pendingProduct.id)) { msg('Este producto ya está en la orden'); setPendingProduct(null); return }
    const quantity = Number(pendingQuantity)
    const unitPrice = Number(pendingUnitPrice)
    if (!Number.isFinite(quantity) || quantity <= 0) { msg('Ingresa una cantidad mayor a 0.'); return }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { msg('Ingresa un precio unitario válido.'); return }
    const discountPayload = getPurchaseOrderDiscountPayload({
      unit_price: unitPrice,
      discount_percent: pendingDiscountPercent,
      discount_unit_amount: pendingDiscountUnitAmount,
      discount_mode: pendingDiscountMode,
    })
    setItems(prev => [...prev, {
      tempId: newTempId(),
      item_type: 'PRODUCT',
      product_id: pendingProduct.id,
      sku: pendingProduct.sku,
      description: pendingProduct.description,
      unit: pendingProduct.unit_of_measure || 'UNIDAD',
      quantity,
       unit_price: unitPrice,
        ...discountPayload,
        discount_mode: resolvePurchaseOrderDiscountMode(discountPayload.discount_percent, discountPayload.discount_unit_amount),
       tax_rate: pendingProduct.tax_rate || 19,
      warehouse_id: form.warehouse_id,
      notes: '',
    }])
    setPendingProduct(null)
    setPendingQuantity('1')
    setPendingUnitPrice('')
    setPendingDiscountPercent(0)
    setPendingDiscountUnitAmount(0)
    setPendingDiscountMode(null)
    setProductSearch('')
    setProductResults([])
    setProductDropdownOpen(false)
    setProductPage(0)
    setProductHasMore(false)
    setProductSearchLoading(false)
    if (productSearchTimerRef.current !== null) window.clearTimeout(productSearchTimerRef.current)
    productSearchRequestSequence.current += 1
  }

  function addServiceToItems() {
    const description = serviceDraft.description.trim()
    const quantity = Number(serviceDraft.quantity)
    const unitPrice = Number(serviceDraft.unitPrice)
    const discountPercent = Number(serviceDraft.discountPercent)
    const taxRate = Number(serviceDraft.taxRate)
    if (!description) { msg('La descripción del servicio es obligatoria.'); return }
    if (!Number.isFinite(quantity) || quantity <= 0) { msg('Ingresa una cantidad mayor a 0.'); return }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { msg('Ingresa un precio unitario válido.'); return }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) { msg('El descuento debe estar entre 0 y 100.'); return }
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) { msg('El IVA debe estar entre 0 y 100.'); return }
    setItems(prev => [...prev, {
      tempId: newTempId(), item_type: 'SERVICE', product_id: '', sku: '', description,
       unit: '', quantity, unit_price: unitPrice, discount_percent: discountPercent, discount_unit_amount: 0,
       discount_mode: discountPercent > 0 ? 'percent' : null, tax_rate: taxRate,
      warehouse_id: '', notes: serviceDraft.notes.trim(),
    }])
    setServiceDraft({ description: '', quantity: '1', unitPrice: '', discountPercent: '0', taxRate: '19', notes: '' })
    setShowServiceForm(false)
  }

  function focusProductSearch() {
    if (!form.supplier_id) {
      msg('Selecciona primero un proveedor para agregar productos.')
      return
    }
    productInputRef.current?.focus()
    openProductDropdown()
  }

  function updateItem(tempId: string, field: keyof LineItem, value: unknown) {
    setItems(prev => prev.map(it => {
      if (it.tempId !== tempId) return it
      if (field === 'discount_percent') {
        const percent = Math.min(Math.max(Number(value) || 0, 0), 100)
        return { ...it, discount_percent: percent, discount_unit_amount: 0, discount_mode: percent > 0 ? 'percent' : null }
      }
      if (field === 'discount_unit_amount') {
        const unitAmount = Math.min(Math.max(Number(value) || 0, 0), Math.max(it.unit_price, 0))
        return { ...it, discount_percent: 0, discount_unit_amount: unitAmount, discount_mode: unitAmount > 0 ? 'unit' : null }
      }
      if (field === 'unit_price') {
        const unitPrice = Math.max(Number(value) || 0, 0)
        const unitAmount = Math.min(it.discount_unit_amount, unitPrice)
        return { ...it, unit_price: unitPrice, discount_unit_amount: unitAmount, discount_mode: unitAmount > 0 ? 'unit' : null }
      }
      return { ...it, [field]: value }
    }))
    if (field === 'unit_price' || field === 'quantity') {
      setInvalidPriceItemIds(prev => {
        if (!prev.has(tempId)) return prev
        const next = new Set(prev)
        next.delete(tempId)
        return next
      })
    }
  }

  function removeItem(tempId: string) {
    setItems(prev => prev.filter(it => it.tempId !== tempId))
    if (editingItem === tempId) setEditingItem(null)
  }

  const orderTotals = calculatePurchaseOrderTotals(items)
  const {
    gross_total: grossTotal,
    discount_total: discountTotal,
    net_total: netTotal,
    tax_total: taxTotal,
    grand_total: grandTotal,
  } = orderTotals
  const pendingDiscountDisplay = getPurchaseOrderDiscountDisplayValues({
    unit_price: Number(pendingUnitPrice) || 0,
    discount_percent: pendingDiscountPercent,
    discount_unit_amount: pendingDiscountUnitAmount,
    discount_mode: pendingDiscountMode,
  })


  async function handleCreateAuthorizer(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    console.log('[AUTHORIZER_SAVE_CLICK]', authorizerForm)
    if (!authorizerForm.full_name) { msg('El nombre es obligatorio'); return }
    try {
      const res = await createAuthorizedPersonnel({
        full_name: authorizerForm.full_name,
        position: authorizerForm.position || undefined,
        email: authorizerForm.email || undefined,
        phone: authorizerForm.phone || undefined,
      })
      console.log('[AUTHORIZER_SAVE_RESULT]', res)
      if ('error' in res && res.error) { console.error('[AUTHORIZER_SAVE_ERROR]', res.error); msg(res.error); return }
      const reloaded = await getAuthorizedPersonnel()
      console.log('[AUTHORIZER_RELOADED]', reloaded)
      setAuthorizedPersonnel(reloaded)
      const created = reloaded.find(a => a.full_name === authorizerForm.full_name)
      if (created) setForm(p => ({ ...p, authorized_by: created.id }))
      setShowAuthorizerForm(false)
      setAuthorizerForm({ full_name: '', position: '', email: '', phone: '' })
      msg('Autorizador creado')
    } catch (err) {
      console.error('[AUTHORIZER_SAVE_EXCEPTION]', err)
      msg('Error al crear autorizador: ' + (err instanceof Error ? err.message : 'desconocido'))
    }
  }

  async function handleDownloadPDF() {
    if (!detail || downloadingPdf) return
    setDownloadingPdf(true)
    try {
      const result = await getPurchaseOrderDocumentDetail(detail.po.id)
      if ('error' in result) throw new Error(result.error)
      const document = result.data
      await downloadPOBooklet(document, `${buildPurchaseOrderFileNameBase(document.po.supplier_name, document.po.correlative)}.pdf`, undefined)
    } catch (error) {
      msg(error instanceof Error ? error.message : 'No se pudo generar el PDF.')
    } finally {
      setDownloadingPdf(false)
    }
  }

  async function handleDownloadExcel() {
    if (!detail || downloadingExcel) return
    setDownloadingExcel(true)
    try {
      const result = await getPurchaseOrderDocumentDetail(detail.po.id)
      if ('error' in result) throw new Error(result.error)
      generatePurchaseOrderExcel(result.data)
    } catch (error) {
      msg(error instanceof Error ? error.message : 'No se pudo generar el Excel.')
    } finally {
      setDownloadingExcel(false)
    }
  }

  async function handlePreviewPDF() {
    if (!form.supplier_id) { msg('Selecciona un proveedor antes de previsualizar'); return }
    if (items.length === 0) { msg('Agrega al menos una línea a la orden'); return }
    const supplier = suppliers.find(s => s.id === form.supplier_id)
    const warehouse = warehouses.find(w => w.id === form.warehouse_id)
    const authorized = authorizedPersonnel.find(a => a.id === form.authorized_by)
    const previewCorrelative = await getNextCorrelative()

    const previewDetail = {
      po: {
        id: 'preview',
        correlative: previewCorrelative || 'EMITIDA',
        issue_date: new Date().toISOString(),
        required_date: form.required_date || undefined,
        supplier_name: supplier?.business_name || '',
        supplier_rut: supplier?.rut || undefined,
        supplier_contact: supplier?.contact_name || undefined,
        supplier_email: supplier?.contact_email || undefined,
        supplier_phone: supplier?.contact_phone || undefined,
        supplier_address: supplier?.address || undefined,
        warehouse_name: warehouse?.name || undefined,
        po_type: items.some(item => item.item_type === 'SERVICE')
           ? items.some(item => item.item_type === 'PRODUCT') ? 'MIXTA' : 'SERVICIOS'
           : 'PRODUCTOS',
        currency: form.currency,
        payment_terms: form.payment_terms || undefined,
        requester_name: 'Usuario actual',
        authorized_name: authorized?.full_name || undefined,
        notes: form.notes || undefined,
        net_total: netTotal,
        discount_total: discountTotal,
        tax_total: taxTotal,
        exempt_total: 0,
        grand_total: grandTotal,
        status: 'EMITIDA',
        created_at: new Date().toISOString(),
        company_name: activeCompany?.business_name,
        company_rut: activeCompany?.rut,
        company_logo_url: activeCompany?.logo_url,
        company_phone: activeCompany?.phone,
        company_email: activeCompany?.email,
        company_address: activeCompany?.address
      },
         items: items.map((it, idx) => {
             const lineTotals = calculatePurchaseOrderLineTotals(it)
             const discountPayload = getPurchaseOrderDiscountPayload(it)
            return {
         line_number: idx + 1,
        item_type: it.item_type,
        product_id: it.product_id || undefined,
        sku: it.sku || undefined,
        product_description: it.description,
        unit: it.unit || undefined,
        quantity: it.quantity,
        unit_price: it.unit_price,
         ...discountPayload,
         discount_unit_amount: discountPayload.discount_unit_amount,
         discount_amount: lineTotals.discount_amount,
         tax_rate: it.tax_rate,
         tax_amount: lineTotals.tax_amount,
         line_total: lineTotals.line_total,
         warehouse_name: warehouse?.name || undefined,
         notes: it.notes || undefined,
           }
         }),
    }
    try {
      let previewLogoBase64 = logoBase64
      if (activeCompany?.logo_url) {
        try {
          const res = await fetch(activeCompany.logo_url)
          if (!res.ok) throw new Error(`Fetch failed for ${activeCompany.logo_url}`)
          const blob = await res.blob()
          previewLogoBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onloadend = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(blob)
          })
        } catch (logoErr) {
          console.error('Error fetching company logo for preview:', logoErr)
        }
      }

      const blob = generatePdfBlob(previewDetail, previewLogoBase64)
      const url = URL.createObjectURL(blob)
      previewDetailRef.current = previewDetail
      setPreviewUrl(url)
    } catch (err) {
      msg('Error al generar PDF: ' + (err instanceof Error ? err.message : 'desconocido'))
    }
  }

  if (previewUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }}>
        <div className="relative w-[90vw] h-[90vh] bg-theme-surface rounded-2xl border border-theme-border shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-3 border-b border-theme-border bg-theme-text/5 shrink-0">
            <h2 className="text-sm font-bold text-theme-text">Vista previa — Orden de Compra</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => { if (previewDetailRef.current) { downloadPOBooklet(previewDetailRef.current, `VistaPrevia_OC`, undefined); msg('PDF descargado') } }} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20">
                Descargar PDF
              </button>
              <button onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }} className="px-4 py-1.5 rounded-lg border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-xs font-semibold transition-colors">
                Cerrar
                </button>
                 </div>
           </div>
           <div className="flex-1 min-h-0">
               <iframe src={previewUrl} className="w-full h-full" title="Vista previa OC" />
             </div>
            </div>
          </div>
     )
   }

  if (view === 'form') {
    return (
       <div className="flex h-full flex-col overflow-hidden bg-[#EFE9E1] animate-in fade-in zoom-in-95 duration-200">
        {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto">
           <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-[#AC9C8D]/35 bg-[#322D29] px-4 py-2 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
               <button type="button" onClick={() => { setView('list'); resetForm() }} className="rounded-md p-1.5 text-[#D1C7BD] transition-colors hover:bg-white/10 hover:text-[#EFE9E1]">
                <ArrowLeft className="w-5 h-5" />
              </button>
             <div className="min-w-0">
                 <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#AC9C8D]">Adquisiciones</p>
                 <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <h2 className="truncate text-base font-bold uppercase tracking-wide text-[#EFE9E1]">{editId ? 'Editar orden de compra' : 'Nueva orden de compra'}</h2>
                   {!editId && lastSavedAt && (
                     <span className="text-[11px] font-normal text-[#AC9C8D] flex items-center gap-1 shrink-0">
                       • Guardado automáticamente · {lastSavedAt}
                     </span>
                   )}
                 </div>
              </div>
            </div>
             <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
               <button type="button" onClick={() => { setView('list'); resetForm() }} className="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold text-[#D1C7BD] transition-colors hover:bg-white/10 hover:text-[#EFE9E1] sm:flex-none">
                Cancelar
              </button>
               <button type="button" onClick={handlePreviewPDF} className="flex-1 rounded-md border border-[#AC9C8D]/55 px-3 py-1.5 text-xs font-semibold text-[#EFE9E1] transition-colors hover:border-[#D1C7BD] hover:bg-white/10 sm:flex-none">
                Vista previa PDF
              </button>
                <button type="submit" disabled={isSubmitting} className="flex-1 rounded-md bg-[#72383D] px-4 py-1.5 text-xs font-bold text-[#EFE9E1] transition-colors hover:bg-[#5D2E32] disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none">
                 {isSubmitting ? <><Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" />Emitiendo...</> : 'Emitir OC'}
               </button>
            </div>
          </div>
            <div className="min-w-0 space-y-4 px-4 py-4 sm:px-6 sm:py-5">
             {!editId && draftPrompt && (
               <div className="rounded-lg border border-[#AC9C8D]/40 bg-[#F7F4F0] p-3.5 shadow-sm text-[#322D29] animate-in fade-in duration-150">
                 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                   <div className="space-y-0.5">
                     <h4 className="text-xs font-bold text-[#322D29]">Tienes una Orden de Compra sin terminar</h4>
                     <p className="text-[11px] text-[#6D625B]">
                       {draftPrompt.supplierName ? `Proveedor: ${draftPrompt.supplierName} · ` : ''}
                       {draftPrompt.itemCount} {draftPrompt.itemCount === 1 ? 'producto' : 'productos'}
                       {draftPrompt.savedAtFormatted ? ` · Guardado: ${draftPrompt.savedAtFormatted}` : ''}
                     </p>
                   </div>
                   <div className="flex items-center gap-2 shrink-0">
                     <button
                       type="button"
                       onClick={handleRestoreDraft}
                       className="rounded-md bg-[#72383D] px-3 py-1.5 text-xs font-bold text-[#EFE9E1] transition-colors hover:bg-[#5D2E32]"
                     >
                       Continuar borrador
                     </button>
                     <button
                       type="button"
                       onClick={handleDiscardDraft}
                       className="rounded-md border border-[#D1C7BD] bg-white px-3 py-1.5 text-xs font-semibold text-[#6D625B] transition-colors hover:bg-[#EFE9E1]"
                     >
                       Descartar
                     </button>
                   </div>
                 </div>
               </div>
             )}
              <section className="rounded-xl border border-[#D1C7BD] bg-[#F7F4F0] p-4 shadow-sm">
                <div className="mb-3 border-b border-[#D1C7BD] pb-2">
                  <div>
                    <h3 className="text-sm font-bold text-[#322D29]">Información de la orden</h3>
                    <p className="mt-0.5 text-[10px] text-[#AC9C8D]">Información principal de la orden</p>
                  </div>
                </div>
              <div className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-2.5 md:grid-cols-2 xl:grid-cols-4">
                <div className="order-2 space-y-1 xl:order-2">
                  <label className="text-[10px] font-semibold text-[#6D625B]">Fecha emisión</label>
                  <div className="flex h-8 items-center justify-between rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2.5 text-xs text-[#6D625B]">
                   <span>{new Date().toLocaleDateString('es-CL')}</span><span className="text-[10px] text-[#AC9C8D]">automática</span>
                 </div>
               </div>
               <div className="order-3 space-y-1 xl:order-3">
                   <label className="text-[10px] font-semibold text-[#6D625B]">Fecha requerida</label>
                 <input type="date" value={form.required_date} onChange={e => setForm(p => ({ ...p, required_date: e.target.value }))} className={inputClass} />
               </div>
               <div ref={supplierRef} className="relative order-1 space-y-1 xl:order-1">
                  <label className="text-[10px] font-semibold text-[#6D625B]">Proveedor *</label>
                <input
                  type="text"
                  value={
                    !supplierOpen && form.supplier_id && !supplierSearch
                       ? (suppliers.find(s => s.id === form.supplier_id)?.business_name ?? replenishmentSupplierName)
                      : supplierSearch
                  }
                   onChange={e => { if (isReplenishmentPreparation) return; setSupplierSearch(e.target.value); setSupplierOpen(true) }}
                   onFocus={() => { if (!isReplenishmentPreparation) setSupplierOpen(true) }}
                   placeholder="Buscar proveedor..."
                   required
                   readOnly={isReplenishmentPreparation}
                     className="w-full h-8 rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] placeholder:text-[#AC9C8D] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15"
                 />
                 {isReplenishmentPreparation && <p className="mt-1 text-[10px] text-theme-text-muted">Proveedor definido por los productos seleccionados en Reposición.</p>}
                 {!isReplenishmentPreparation && supplierOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setSupplierOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 w-full max-h-48 overflow-y-auto bg-theme-surface border border-theme-border rounded-xl shadow-xl z-50 p-1 space-y-0.5">
                      {(() => {
                        const norm = supplierSearch.toUpperCase().trim()
                        const filtered = suppliers.filter(s =>
                          s.is_active && (
                            !norm ||
                            s.business_name.toUpperCase().includes(norm) ||
                            (s.fantasy_name && s.fantasy_name.toUpperCase().includes(norm)) ||
                            (s.rut && s.rut.toUpperCase().includes(norm))
                          )
                        ).slice(0, 20)
                        return filtered.length === 0
                          ? <p className="px-3 py-2 text-xs text-theme-text-muted/50">Sin resultados</p>
                          : filtered.map(s => (
                              <button
                                key={s.id}
                                type="button"
                                 onClick={() => { handleSupplierChange(s.id); setSupplierSearch(''); setSupplierOpen(false) }}
                                className="w-full text-left px-3 py-2 text-xs rounded-lg transition-colors text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                              >
                                <span className="font-medium">{s.business_name}</span>
                                {s.rut && <span className="text-theme-text-muted/50 ml-2">{s.rut}</span>}
                              </button>
                            ))
                      })()}
                    </div>
                  </>
                )}
              </div>
               <div className="relative order-4 space-y-1" ref={warehouseRef}>
                  <label className="text-[10px] font-semibold text-[#6D625B]">Bodega destino</label>
                {warehouses.length === 0 ? (
                  <div className="w-full rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-500 font-semibold">
                    No hay bodegas disponibles. Las bodegas deben ser creadas desde el módulo WMS.
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={
                        !warehouseOpen && form.warehouse_id && !warehouseSearch
                          ? (warehouses.find(w => w.id === form.warehouse_id)?.name ?? '')
                          : warehouseSearch
                      }
                      onChange={e => { setWarehouseSearch(e.target.value); setWarehouseOpen(true); if (form.warehouse_id) setForm(p => ({ ...p, warehouse_id: '' })) }}
                      onFocus={() => setWarehouseOpen(true)}
                      placeholder="Buscar bodega..."
                       className="w-full h-8 rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] placeholder:text-[#AC9C8D] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15"
                    />
                    {warehouseOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setWarehouseOpen(false)} />
                        <div className="absolute left-0 top-full mt-1 w-full max-h-48 overflow-y-auto bg-theme-surface border border-theme-border rounded-xl shadow-xl z-50 p-1 space-y-0.5">
                          {(() => {
                            const norm = warehouseSearch.toUpperCase().trim()
                            const filtered = warehouses.filter(w =>
                              w.is_active && (
                                !norm ||
                                w.name.toUpperCase().includes(norm) ||
                                (w.code && w.code.toUpperCase().includes(norm))
                              )
                            ).slice(0, 20)
                            return filtered.length === 0
                              ? <p className="px-3 py-2 text-xs text-theme-text-muted/50">Sin resultados</p>
                              : filtered.map(w => (
                                  <button
                                    key={w.id}
                                    type="button"
                                    onClick={() => { setForm(p => ({ ...p, warehouse_id: w.id })); setWarehouseSearch(''); setWarehouseOpen(false) }}
                                    className="w-full text-left px-3 py-2 text-xs rounded-lg transition-colors text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                                  >
                                    <span className="font-medium">{w.name}</span>
                                    {w.code && <span className="text-theme-text-muted/50 ml-2">{w.code}</span>}
                                  </button>
                                ))
                          })()}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
               <div className="order-5 space-y-1 xl:order-5 xl:max-w-[180px]">
                  <label className="text-[10px] font-semibold text-[#6D625B]">Moneda</label>
                <select value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))} className={selectClass}>
                  <option value="CLP" className="bg-white dark:bg-emerald-900">CLP</option>
                  <option value="USD" className="bg-white dark:bg-emerald-900">USD</option>
                  <option value="EUR" className="bg-white dark:bg-emerald-900">EUR</option>
                </select>
              </div>
               <div className="order-6 space-y-1 xl:col-span-1">
                  <label className="text-[10px] font-semibold text-[#6D625B]">Condiciones de pago</label>
                <input type="text" value={form.payment_terms} onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))} placeholder="Ej: 30 días" className={inputClass} />
              </div>
              {showAuthorizerForm ? (
                 <div className="col-span-1 border border-[#D1C7BD] bg-[#F7F4F0] p-3 space-y-3 md:col-span-2 xl:col-span-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider">Nuevo autorizador</h4>
                    <button type="button" onClick={() => setShowAuthorizerForm(false)} className="text-xs text-theme-text-muted hover:text-theme-text">Cancelar</button>
                  </div>
                     <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-2 xl:grid-cols-4">
                 <div className="order-7 space-y-1 xl:col-span-2 xl:max-w-[390px]">
                      <label className="text-xs text-theme-text-muted/70">Nombre completo *</label>
                      <input type="text" value={authorizerForm.full_name} onChange={e => setAuthorizerForm(p => ({ ...p, full_name: e.target.value }))} className={inputClass} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-theme-text-muted/70">Cargo</label>
                      <input type="text" value={authorizerForm.position} onChange={e => setAuthorizerForm(p => ({ ...p, position: e.target.value }))} className={inputClass} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-theme-text-muted/70">Email</label>
                      <input type="email" value={authorizerForm.email} onChange={e => setAuthorizerForm(p => ({ ...p, email: e.target.value }))} className={inputClass} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-theme-text-muted/70">Teléfono</label>
                      <input type="text" value={authorizerForm.phone} onChange={e => setAuthorizerForm(p => ({ ...p, phone: e.target.value }))} className={inputClass} />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowAuthorizerForm(false)} className="px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 transition-colors">Cancelar</button>
                    <button type="button" onClick={handleCreateAuthorizer} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20">Guardar</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <AuthorizedPersonnelCombobox
                    value={form.authorized_by}
                    onChange={v => setForm(p => ({ ...p, authorized_by: v }))}
                    items={authorizedPersonnel}
                    label="Autorizado por"
                    placeholder="Buscar autorizador..."
                    onCreateNew={(name) => { setAuthorizerForm(p => ({ ...p, full_name: name })); setShowAuthorizerForm(true) }}
                  />
                </div>
              )}
              </div>
            </section>

              <section className="min-w-0 border-b border-[#D1C7BD] pb-4">
                <div className="mb-2 flex min-w-0 flex-col justify-between gap-2 sm:flex-row sm:items-center">
                 <div>
                   <h3 className="text-sm font-bold uppercase tracking-wide text-[#322D29]">Líneas de la orden</h3>
                   <p className="mt-0.5 text-[10px] text-[#AC9C8D]">Productos y servicios incluidos</p>
                </div>
                   <div className="flex min-w-0 flex-wrap gap-1.5 self-start sm:justify-end sm:self-auto">
                     <button type="button" onClick={() => setShowDiscountColumns(value => !value)} className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-[#72383D]/40 bg-[#EFE9E1] px-2.5 text-[11px] font-semibold text-[#72383D] transition-colors hover:bg-[#F5EDEE]">
                      {showDiscountColumns ? 'Ocultar descuentos' : 'Agregar descuentos'}
                    </button>
                     <button type="button" onClick={focusProductSearch} className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-[#72383D]/40 bg-[#EFE9E1] px-2.5 text-[11px] font-semibold text-[#72383D] transition-colors hover:bg-[#F5EDEE]"><Plus className="h-3.5 w-3.5" />Agregar producto</button>
                    <button type="button" onClick={() => setShowServiceForm(value => !value)} className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-[#72383D]/40 bg-[#EFE9E1] px-2.5 text-[11px] font-semibold text-[#72383D] transition-colors hover:bg-[#F5EDEE]"><Plus className="h-3.5 w-3.5" />Agregar servicio</button>
                 </div>
               </div>

               {showServiceForm && <div className="mb-3 border border-[#D1C7BD] bg-[#F7F4F0] p-3">
                 <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(180px,1.5fr)_90px_120px_90px_90px] sm:items-end">
                   <label className="text-[10px] font-semibold text-[#6D625B]">Descripción del servicio *<input value={serviceDraft.description} onChange={event => setServiceDraft(prev => ({ ...prev, description: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-xs" /></label>
                   <label className="text-[10px] font-semibold text-[#6D625B]">Cantidad<input type="number" min="0.001" step="0.001" value={serviceDraft.quantity} onChange={event => setServiceDraft(prev => ({ ...prev, quantity: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs" /></label>
                   <label className="text-[10px] font-semibold text-[#6D625B]">Precio unitario<input type="number" min="0" step="0.01" value={serviceDraft.unitPrice} onChange={event => setServiceDraft(prev => ({ ...prev, unitPrice: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs" /></label>
                   <label className="text-[10px] font-semibold text-[#6D625B]">Descuento %<input type="number" min="0" max="100" step="0.01" value={serviceDraft.discountPercent} onChange={event => setServiceDraft(prev => ({ ...prev, discountPercent: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs" /></label>
                   <label className="text-[10px] font-semibold text-[#6D625B]">IVA %<input type="number" min="0" max="100" step="0.01" value={serviceDraft.taxRate} onChange={event => setServiceDraft(prev => ({ ...prev, taxRate: event.target.value }))} className="mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs" /></label>
                 </div>
                 <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="flex-1 text-[10px] font-semibold text-[#6D625B]">Observaciones<textarea value={serviceDraft.notes} onChange={event => setServiceDraft(prev => ({ ...prev, notes: event.target.value }))} rows={2} className="mt-1 w-full rounded-md border border-[#D1C7BD] bg-white px-2 py-1 text-xs" /></label><button type="button" onClick={addServiceToItems} className="h-8 rounded-md bg-[#72383D] px-3 text-xs font-bold text-white">Agregar servicio</button></div>
               </div>}

                <div ref={productRef} className="relative mb-2 min-w-0">
                   <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#AC9C8D]" />
                    <input ref={productInputRef} type="text" value={productSearch} onChange={e => handleProductSearch(e.target.value)}
                     onFocus={openProductDropdown}
                     disabled={!form.supplier_id}
                     placeholder={form.supplier_id ? "Buscar por SKU, descripción o código de barra..." : "Selecciona primero un proveedor"}
                       className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] pl-8 pr-3 text-xs text-[#322D29] placeholder:text-[#AC9C8D] focus:border-[#72383D] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#72383D]/15 disabled:cursor-not-allowed disabled:bg-[#D1C7BD]/30 disabled:opacity-65" />
                  {!form.supplier_id && <p className="mt-1.5 text-[10px] text-[#AC9C8D]">Debe seleccionar primero el proveedor para buscar productos.</p>}
                  {form.supplier_id && productDropdownOpen && (
                     <div onScroll={handleProductDropdownScroll} className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-y-auto border border-[#D1C7BD] bg-white shadow-lg">
                       {productSearchLoading ? <p className="px-4 py-2.5 text-xs text-theme-text-muted/60">Buscando...</p> : productResults.length === 0 ? (
                        <p className="px-4 py-2.5 text-xs text-theme-text-muted/60">
                          {productSearch.trim() ? 'No se encontraron productos para este proveedor.' : 'Este proveedor no tiene productos disponibles.'}
                        </p>
                       ) : productResults.map(p => (
                         <button key={p.id} type="button" onClick={() => selectProductForAddition(p)}
                           className="flex w-full items-center justify-between border-b border-[#E5DDD4] px-3 py-2 text-left text-xs text-[#322D29] last:border-0 hover:bg-[#F3EFE9]">
                          <span><span className="font-mono font-semibold">{p.sku}</span> — {p.description}</span>
                          <span className="text-theme-text-muted/50">{p.unit_of_measure || '—'}</span>
                        </button>
                      ))}
                       {productLoadingMore && <p className="border-t border-theme-border px-4 py-2.5 text-center text-[11px] text-theme-text-muted/60">Cargando más productos...</p>}
                     </div>
                   )}
               </div>

               {pendingProduct && (() => {
                  const pendingLineTotals = calculatePurchaseOrderLineTotals({
                    quantity: Number(pendingQuantity) || 0,
                    unit_price: Number(pendingUnitPrice) || 0,
                    discount_percent: Number(pendingDiscountDisplay.discount_percent) || 0,
                    discount_unit_amount: Number(pendingDiscountDisplay.discount_unit_amount) || 0,
                    tax_rate: Number(pendingProduct.tax_rate) || 19,
                  })
                  return (
                    <div className="mb-2 min-w-0 rounded-md border border-[#D1C7BD] bg-[#F7F4F0] p-2.5">
                      <div className={`grid min-w-0 grid-cols-1 gap-2 sm:items-end ${showDiscountColumns ? 'sm:grid-cols-[minmax(0,1.25fr)_minmax(82px,.55fr)_minmax(108px,.7fr)_minmax(82px,.55fr)_minmax(108px,.7fr)_minmax(60px,.45fr)_minmax(96px,.65fr)_auto]' : 'sm:grid-cols-[minmax(0,1.5fr)_minmax(95px,.65fr)_minmax(120px,.8fr)_minmax(64px,.45fr)_minmax(104px,.7fr)_auto]'}`}>
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#72383D]">Producto</p>
                          <p className="truncate text-xs font-semibold text-[#322D29]" title={pendingProduct.description}>{pendingProduct.description}</p>
                          <p className="mt-0.5 font-mono text-[10px] text-[#AC9C8D]">SKU {pendingProduct.sku}</p>
                          <p className="mt-1 text-[10px] text-[#AC9C8D]">Último costo de compra Bsale (CLP): {pendingProduct.last_purchase_unit_cost === null ? 'Sin precio disponible' : formatCurrency(pendingProduct.last_purchase_unit_cost, 'CLP')}</p>
                        </div>
                        <label className="text-[10px] font-semibold text-[#6D625B]">Cantidad<input type="number" min="0.001" step="0.001" value={pendingQuantity} onChange={event => setPendingQuantity(event.target.value)} className="mt-1 block h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" /></label>
                        <label className="text-[10px] font-semibold text-[#6D625B]">Precio unitario<input type="number" min="0" step="1" value={pendingUnitPrice} onChange={event => updatePendingUnitPrice(event.target.value)} placeholder="Ingresar manualmente" className="mt-1 block h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" /></label>
                        {showDiscountColumns && <>
                          <label className="text-[10px] font-semibold text-[#6D625B]">Dcto %<input type="number" min="0" max="100" step="0.01" value={pendingDiscountDisplay.discount_percent} onChange={event => updatePendingDiscount('discount_percent', event.target.value)} className="mt-1 block h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" /></label>
                          <label className="text-[10px] font-semibold text-[#6D625B]">Dcto por unidad<input type="number" min="0" max={Math.max(Number(pendingUnitPrice) || 0, 0)} step="0.01" value={pendingDiscountDisplay.discount_unit_amount} onChange={event => updatePendingDiscount('discount_unit_amount', event.target.value)} className="mt-1 block h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" /></label>
                        </>}
                        <div className="text-[10px] font-semibold text-[#6D625B]">IVA
                          <div className="mt-1 flex h-8 items-center justify-end rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2 text-xs text-[#6D625B]">{pendingProduct.tax_rate || 19}%</div>
                        </div>
                        <div className="text-[10px] font-semibold text-[#6D625B]">Neto
                          <div className="mt-1 flex h-8 items-center justify-end rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2 font-mono text-xs font-semibold text-[#322D29]">
                            {pendingLineTotals.net_amount.toLocaleString('es-CL', { style: 'currency', currency: form.currency, minimumFractionDigits: 0 })}
                          </div>
                        </div>
                        <button type="button" onClick={addProductToItems} className="h-8 whitespace-nowrap rounded-md border border-[#72383D]/40 bg-[#EFE9E1] px-2.5 text-[11px] font-bold text-[#72383D] hover:bg-[#F5EDEE]">Agregar producto</button>
                      </div>
                    </div>
                  )
                })()}

                  <div className="min-w-0 overflow-x-auto border border-[#D1C7BD] bg-white">
                   <table className="w-full min-w-[760px] table-fixed text-sm">
                    <colgroup>
                      <col />
                      <col className="w-20" />
                      <col className="w-28" />
                      {showDiscountColumns && <><col className="w-20" /><col className="w-24" /></>}
                      <col className="w-16" />
                      <col className="w-28" />
                      <col className="w-28" />
                      <col className="w-12" />
                   </colgroup>
                    <thead className="bg-[#322D29]">
                      <tr className="border-b border-[#AC9C8D]/35 text-[9px] uppercase tracking-[0.08em] text-[#EFE9E1]">
                         <th className="px-2.5 py-1.5 text-left font-semibold">Producto / Servicio</th>
                         <th className="px-2 py-1.5 text-center font-semibold">Cantidad</th>
                         <th className="px-2 py-1.5 text-center font-semibold">P. unitario</th>
                          {showDiscountColumns && <><th className="px-2 py-1.5 text-center font-semibold">Dcto %</th><th className="px-2 py-1.5 text-center font-semibold" title="Descuento por unidad">Dcto/u</th></>}
                         <th className="px-2 py-1.5 text-center font-semibold">IVA %</th>
                         <th className="px-2 py-1.5 text-right font-semibold">Neto</th>
                         <th className="px-2 py-1.5 text-right font-semibold">Total</th>
                         <th className="px-2 py-1.5 text-center font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                          <td colSpan={showDiscountColumns ? 9 : 7} className="py-6 text-center text-xs text-[#AC9C8D]">No hay líneas agregadas</td>
                      </tr>
                    ) : items.map(it => (
                         <tr key={it.tempId} className={`border-b border-[#E5DDD4] odd:bg-white even:bg-[#FBFAF8] hover:bg-[#F3EFE9] transition-colors ${invalidPriceItemIds.has(it.tempId) ? 'bg-red-50 ring-1 ring-inset ring-red-300' : ''}`}>
                           <td className="min-w-0 px-2.5 py-1.5 text-xs text-[#322D29]">
                           {editingItem === it.tempId ? (
                               <input type="text" value={it.description} onChange={e => updateItem(it.tempId, 'description', e.target.value)} className="h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                           ) : (
                             <span className="block truncate" title={it.description}>{it.description || <span className="text-theme-text-muted/40">—</span>}</span>
                           )}
                           <div className="mt-0.5 truncate text-[10px] text-[#AC9C8D]">
                             {it.sku && <span className="font-mono">SKU {it.sku}</span>}
                             {it.sku && <span> · </span>}
                             <span>{it.item_type === 'PRODUCT' ? 'Producto' : 'Servicio'}</span>
                             <span> · {it.unit || '—'}</span>
                           </div>
                         </td>
                           <td className="px-2 py-1.5 text-center">
                             <input type="number" min="0" step="0.001" value={it.quantity} onChange={e => updateItem(it.tempId, 'quantity', parseFloat(e.target.value) || 0)} className="mx-auto block h-8 w-[4.5rem] rounded-md border border-[#D1C7BD] bg-white px-1.5 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                         </td>
                           <td className="px-2 py-1.5 text-center">
                               <input ref={input => { linePriceInputRefs.current[it.tempId] = input }} aria-invalid={invalidPriceItemIds.has(it.tempId)} type="number" min="0" step="1" value={it.unit_price} onChange={e => updateItem(it.tempId, 'unit_price', parseFloat(e.target.value) || 0)} className={`mx-auto block h-8 w-[6.5rem] rounded-md border bg-white px-1.5 text-right text-xs text-[#322D29] focus:outline-none focus:ring-2 ${invalidPriceItemIds.has(it.tempId) ? 'border-red-500 focus:ring-red-300' : 'border-[#D1C7BD] focus:border-[#72383D] focus:ring-[#72383D]/15'}`} />
                             {invalidPriceItemIds.has(it.tempId) && <span className="block mt-0.5 text-[10px] font-semibold text-red-600">Complete el precio</span>}
                             {it.reference_unit_cost !== undefined && <span className="mt-0.5 block text-[10px] text-[#AC9C8D]">Ref. Bsale {formatCurrency(it.reference_unit_cost, 'CLP')}</span>}
                        </td>
                           {showDiscountColumns && (() => {
                             const discountDisplay = getPurchaseOrderDiscountDisplayValues(it)
                             return <>
                              <td className="px-2 py-1.5 text-center">
                                <input type="number" min="0" max="100" step="0.01" value={discountDisplay.discount_percent} onChange={e => updateItem(it.tempId, 'discount_percent', e.target.value)} className="mx-auto block h-8 w-[4.5rem] rounded-md border border-[#D1C7BD] bg-white px-1.5 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <input type="number" min="0" max={it.unit_price} step="0.01" value={discountDisplay.discount_unit_amount} onChange={e => updateItem(it.tempId, 'discount_unit_amount', e.target.value)} className="mx-auto block h-8 w-[5.5rem] rounded-md border border-[#D1C7BD] bg-white px-1.5 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                              </td>
                             </>
                           })()}
                           <td className="px-2 py-1.5 text-center">
                             <input type="number" min="0" max="100" step="0.01" value={it.tax_rate} onChange={e => updateItem(it.tempId, 'tax_rate', parseFloat(e.target.value) || 0)} className="mx-auto block h-8 w-[4rem] rounded-md border border-[#D1C7BD] bg-white px-1.5 text-right text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                        </td>
                          {(() => {
                            const lineTotals = calculatePurchaseOrderLineTotals(it)
                            return <>
                              <td className="px-2 py-1.5 text-right text-xs text-[#6D625B]">
                                {lineTotals.net_amount.toLocaleString('es-CL', { style: 'currency', currency: form.currency, minimumFractionDigits: 0 })}
                              </td>
                              <td className="px-2 py-1.5 text-right text-xs font-semibold text-[#322D29]">
                                {lineTotals.line_total.toLocaleString('es-CL', { style: 'currency', currency: form.currency, minimumFractionDigits: 0 })}
                              </td>
                            </>
                          })()}
                          <td className="px-2 py-1.5 text-center">
                           <button type="button" onClick={() => removeItem(it.tempId)} className="rounded-md p-1 text-[#AC9C8D] transition-colors hover:bg-red-500/10 hover:text-red-500">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

                <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.8fr)_minmax(280px,.9fr)]">
                  <div className="min-w-0 rounded-xl border border-[#D1C7BD] bg-[#F7F4F0] p-3.5">
                    <h3 className="mb-2 text-sm font-bold text-[#322D29]">Notas de la orden</h3>
                    <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={4} placeholder="Agregar notas adicionales..." className={`${textareaClass} min-h-[112px] bg-white`} />
                  </div>
                  <div className="min-w-0 rounded-xl border border-[#D1C7BD] bg-[#F7F4F0] p-3.5">
                   <h3 className="mb-2 text-sm font-bold text-[#322D29]">Resumen de la orden</h3>
                   <div className="space-y-1 text-xs">
                     <div className="flex justify-between py-0.5">
                       <span className="text-[#AC9C8D]">Subtotal bruto</span>
                       <span className="font-medium text-[#322D29]">{formatCurrency(grossTotal, form.currency)}</span>
                   </div>
                     <div className="flex justify-between py-0.5">
                       <span className="text-[#AC9C8D]">Descuentos</span>
                       <span className="text-red-500">-{formatCurrency(discountTotal, form.currency)}</span>
                     </div>
                   <div className="flex justify-between py-0.5">
                     <span className="text-[#AC9C8D]">Neto final</span>
                     <span className="font-medium text-[#322D29]">{formatCurrency(netTotal, form.currency)}</span>
                   </div>
                   <div className="flex justify-between py-0.5">
                        <span className="text-[#AC9C8D]">IVA</span>
                        <span className="font-medium text-[#322D29]">{formatCurrency(taxTotal, form.currency)}</span>
                   </div>
                    <div className="mt-1 flex justify-between border-t border-[#D1C7BD] py-1.5">
                       <span className="font-bold text-[#322D29]">Total OC</span>
                      <span className="text-base font-bold text-[#72383D]">{formatCurrency(grandTotal, form.currency)}</span>
                  </div>
                 </div>
               </div>
               </div>
               </section>
             </div>
         </form>
       </div>
    )
  }

   if (view === 'supplier-review' && supplierReviewPoId) {
     return (
       <PurchaseOrderSupplierReview
          poId={supplierReviewPoId}
          onBack={() => { setSupplierReviewPoId(null); setView('list'); setDetail(null); setSelectedPo(null) }}
          onSaved={() => handleSupplierReviewSaved(supplierReviewPoId)}
          onConfirmed={() => handleSupplierReviewConfirmed(supplierReviewPoId)}
        />
     )
   }

   if (view === 'detail' && detail) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in zoom-in-95 duration-200">
        {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}
        <div className="flex-1 overflow-auto">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => { setView('list'); setDetail(null) }} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-theme-text">OC {detail.po.correlative}</h2>
                <Badge value={detail.po.status} map={STATUS_BADGES} label={purchaseOrderStatusLabel(detail.po)} />
              </div>
            </div>
            <div className="flex gap-2">
              {(detail.po.status === 'BORRADOR') && (
                <button onClick={() => { editPO(detail.po) }} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5">
                  <Edit className="w-3.5 h-3.5" /> Editar
                </button>
              )}
              {detail.po.status === 'EMITIDA' && (
                <button onClick={() => void handleMarkSentToSupplier(detail.po.id)} disabled={isMarkingSent} className="px-4 py-2 rounded-xl border border-[#72383D]/35 text-[#72383D] hover:bg-[#72383D]/10 text-xs font-semibold transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50">
                  {isMarkingSent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  {isMarkingSent ? 'Marcando...' : 'Marcar enviada al proveedor'}
                </button>
              )}
              {detail.po.status === 'ENVIADA_PROVEEDOR' && (
                <button onClick={() => openSupplierReview(detail.po.id)} className="px-4 py-2 rounded-xl bg-[#72383D] text-[#EFE9E1] hover:bg-[#5D2E32] text-xs font-semibold transition-colors flex items-center gap-1.5">
                  <ClipboardCheck className="w-3.5 h-3.5" /> Revisar confirmación
                </button>
              )}
              {detail.po.status === 'RECEPCION_PARCIAL' && (
                <button onClick={() => requestCloseWithPending(detail.po as PurchaseOrder)} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5" /> Cerrar OC
                </button>
              )}
              <button onClick={() => void handleDownloadPDF()} disabled={downloadingPdf} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50">
                <Download className="w-3.5 h-3.5" /> {downloadingPdf ? 'PDF...' : 'PDF'}
              </button>
              <button onClick={() => void handleDownloadExcel()} disabled={downloadingExcel} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50">
                <FileSpreadsheet className="w-3.5 h-3.5" /> {downloadingExcel ? 'Excel...' : 'Excel'}
              </button>
               {['BORRADOR', 'EMITIDA', 'PENDIENTE_APROBACION', 'APROBADA', 'ENVIADA_PROVEEDOR', 'CONFIRMADA'].includes(detail.po.status) && (
                 <button onClick={() => requestCancellation(detail.po as PurchaseOrder)} className="px-4 py-2 rounded-xl border border-red-500/30 text-red-500 hover:bg-red-500/10 text-xs font-semibold transition-colors flex items-center gap-1.5">
                  <Ban className="w-3.5 h-3.5" /> Cancelar
                </button>
              )}
            </div>
          </div>
          <div className="p-6 lg:p-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-5">
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Proveedor</p>
                <p className="text-sm text-theme-text font-medium">{detail.po.supplier_name}</p>
                {detail.po.supplier_rut && <p className="text-xs text-theme-text-muted/50">{detail.po.supplier_rut}</p>}
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Fecha emisión</p>
                <p className="text-sm text-theme-text">{formatDate(detail.po.issue_date)}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Fecha requerida</p>
                <p className="text-sm text-theme-text">{formatDate(detail.po.required_date)}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Bodega destino</p>
                <p className="text-sm text-theme-text">{detail.po.warehouse_name || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Moneda</p>
                <p className="text-sm text-theme-text">{detail.po.currency}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Condiciones de pago</p>
                <p className="text-sm text-theme-text">{detail.po.payment_terms || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Autorizado por</p>
                <p className="text-sm text-theme-text">{detail.po.authorized_name || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Recepción</p>
                <p className="text-sm text-theme-text">—</p>
              </div>
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-0.5">Facturación</p>
                <p className="text-sm text-theme-text">—</p>
              </div>
            </div>

            {detail.po.notes && (
              <div>
                <p className="text-xs text-theme-text-muted/70 mb-1.5">Notas</p>
                <p className="text-sm text-theme-text bg-theme-text/5 rounded-xl px-4 py-3">{detail.po.notes}</p>
              </div>
            )}

            <div>
              <h3 className="text-sm font-bold text-theme-text mb-4">Líneas de la orden</h3>
              <div className="overflow-x-auto rounded-xl border border-theme-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                      <th className="text-left py-3 px-4 font-medium">#</th>
                      <th className="text-left py-3 px-4 font-medium">Producto/Servicio</th>
                      <th className="text-left py-3 px-4 font-medium">Descripción</th>
                      <th className="text-right py-3 px-4 font-medium">Cantidad</th>
                      <th className="text-right py-3 px-4 font-medium">P.Unitario</th>
                      <th className="text-right py-3 px-4 font-medium">Dto%</th>
                      <th className="text-right py-3 px-4 font-medium">IVA%</th>
                      <th className="text-right py-3 px-4 font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it, idx) => (
                      <tr key={it.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                        <td className="py-3 px-4 text-xs text-theme-text-muted/60">{idx + 1}</td>
                        <td className="py-3 px-4 text-xs font-mono text-theme-text">{it.item_type === 'PRODUCT' ? 'Producto' : 'Servicio'}</td>
                        <td className="py-3 px-4 text-xs text-theme-text">{it.product_description}</td>
                        <td className="py-3 px-4 text-xs text-theme-text text-right">{it.quantity}</td>
                        <td className="py-3 px-4 text-xs text-theme-text text-right">{formatCurrency(it.unit_price, detail.po.currency)}</td>
                        <td className="py-3 px-4 text-xs text-theme-text text-right">{it.discount_percent > 0 ? `${it.discount_percent}%` : '—'}</td>
                        <td className="py-3 px-4 text-xs text-theme-text text-right">{it.tax_rate}%</td>
                        <td className="py-3 px-4 text-xs text-theme-text font-semibold text-right">{formatCurrency(it.line_total, detail.po.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end mt-4">
                <div className="w-72 space-y-1.5 text-xs">
                  <div className="flex justify-between py-1">
                    <span className="text-theme-text-muted/70">Neto</span>
                    <span className="text-theme-text font-medium">{formatCurrency(detail.po.net_total, detail.po.currency)}</span>
                  </div>
                  {detail.po.discount_total > 0 && (
                    <div className="flex justify-between py-1">
                      <span className="text-theme-text-muted/70">Descuentos</span>
                      <span className="text-red-500">-{formatCurrency(detail.po.discount_total, detail.po.currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-1">
                    <span className="text-theme-text-muted/70">IVA</span>
                    <span className="text-theme-text font-medium">{formatCurrency(detail.po.tax_total, detail.po.currency)}</span>
                  </div>
                  <div className="flex justify-between py-2 border-t border-theme-border">
                    <span className="text-theme-text font-bold">Total</span>
                    <span className="text-theme-text font-bold text-sm">{formatCurrency(detail.po.grand_total, detail.po.currency)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
         </div>
         {cancellationModal}
         </div>
       )
   }

   if (view === 'analysis') {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
        <ReplenishmentAnalysisPanel onBack={() => { setView('list'); load() }} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[#EFE9E1]">
      <div className="flex flex-1 overflow-hidden">
        <div className={`flex flex-col h-full overflow-hidden transition-all duration-300 ${selectedPo ? "w-full md:w-1/3 lg:w-1/4 border-r border-theme-border" : "w-full"}`}>
      {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}

       <div className="shrink-0 flex flex-col gap-2 border-b border-[#D1C7BD] bg-[#EFE9E1] px-3 py-2">
          <div className="flex items-center gap-1 overflow-x-auto rounded-md border border-[#D1C7BD] bg-white p-1" aria-label="Vista operativa de órdenes de compra">
            {PURCHASE_ORDER_OPERATIONAL_VIEWS.map(option => (
             <button
               key={option.value}
               type="button"
               aria-pressed={(filters.operational_view ?? 'PENDING') === option.value}
               onClick={() => setFilters(previous => ({ ...previous, operational_view: option.value, page: 1 }))}
               className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-semibold transition-colors ${(filters.operational_view ?? 'PENDING') === option.value ? 'bg-[#72383D] text-white' : 'text-[#6D625B] hover:bg-[#F3EFE9] hover:text-[#322D29]'}`}
             >
               {option.label}
             </button>
            ))}
            <div className="ml-auto flex shrink-0 items-center gap-1 border-l border-[#D1C7BD] pl-2 text-[10px] text-[#6D625B]" aria-label="Indicadores de órdenes de compra">
              {indicatorsLoading && !indicators ? <Loader2 className="h-3 w-3 animate-spin" /> : indicators ? <>
                <span className="whitespace-nowrap" title="Órdenes pendientes según la vista Pendientes">Pend. <strong className="text-[#322D29]">{indicators.pending_count}</strong></span>
                <span className="whitespace-nowrap" title="Monto pendiente proporcional por líneas">Saldo <strong className="text-[#322D29]">{formatCurrency(indicators.pending_amount)}</strong></span>
                <span className="whitespace-nowrap" title="Órdenes con recepción completada en los últimos 30 días">30d OC <strong className="text-[#322D29]">{indicators.received_order_count}</strong></span>
                <span className="whitespace-nowrap" title="Monto bruto recibido en los últimos 30 días">30d $ <strong className="text-[#322D29]">{formatCurrency(indicators.received_amount)}</strong></span>
              </> : <span className="whitespace-nowrap text-[#AC9C8D]">Indicadores no disponibles</span>}
            </div>
          </div>
         <div className="flex flex-col md:flex-row items-center gap-2 w-full">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#AC9C8D]" />
             <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
              placeholder="Buscar por N° OC, proveedor..."
              className="h-8 w-full rounded-md border border-[#D1C7BD] bg-white pl-8 pr-3 text-xs text-[#322D29] placeholder:text-[#AC9C8D] transition-all focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
          </div>

          <div className="flex w-full items-center gap-1.5 md:w-auto">
            <button onClick={() => setShowFilters(!showFilters)} className={`flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-all ${showFilters ? 'border-[#72383D]/40 bg-[#72383D]/10 text-[#72383D]' : 'border-[#D1C7BD] bg-[#EFE9E1] text-[#6D625B] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'}`}>
              <Filter className="h-3.5 w-3.5" />
              <span>Filtros</span>
            </button>
             <button type="button" onClick={() => { invalidatePurchaseOrderListCache(); void load({ force: true }) }} className="flex h-8 items-center gap-1.5 rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2.5 text-xs font-semibold text-[#6D625B] transition-all hover:bg-[#D1C7BD]/40 hover:text-[#322D29]" title="Actualizar listado">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Actualizar</span>
            </button>
            <button type="button" onClick={resetWidths} className="hidden h-8 rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2.5 text-[11px] font-semibold text-[#6D625B] transition-all hover:bg-[#D1C7BD]/40 hover:text-[#322D29] lg:inline-flex lg:items-center">
              Restablecer anchos
            </button>

            <button onClick={() => setView('analysis')} className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#72383D]/35 px-2.5 text-xs font-semibold text-[#72383D] transition-all hover:bg-[#72383D]/10">
              <BarChart3 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Análisis de reposición</span>
            </button>
            <button type="button" onClick={() => excelImportInputRef.current?.click()} className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#72383D]/35 px-2.5 text-xs font-semibold text-[#72383D] transition-all hover:bg-[#72383D]/10">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Crear OC desde archivo</span>
            </button>
            <button onClick={() => { resetForm(); setView('form') }} className="ml-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#72383D] px-3 text-xs font-bold text-[#EFE9E1] transition-all hover:bg-[#5D2E32] md:ml-0">
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Crear OC</span>
            </button>
          </div>
        </div>

        {showFilters && (
           <div className="border-t border-[#D1C7BD] pt-2 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between mb-4">
                 <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">Filtros avanzados</h4>
               <button onClick={() => { setSearchInput(''); setFilters({ operational_view: 'PENDING', page: 1, pageSize: 50 }); setShowFilters(false) }} className="text-xs font-semibold text-theme-text-accent hover:text-theme-text flex items-center gap-1 transition-colors">
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              <select value={filters.supplier_id ?? ''} onChange={e => setFilters(p => ({ ...p, supplier_id: e.target.value || undefined, page: 1 }))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="" className="bg-white dark:bg-emerald-900">Todos los proveedores</option>
                {suppliers.filter(s => s.is_active).map(s => <option key={s.id} value={s.id} className="bg-white dark:bg-emerald-900">{s.business_name}</option>)}
              </select>
              <select value={filters.status ?? ''} onChange={e => setFilters(p => ({ ...p, status: e.target.value || undefined, page: 1 }))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="" className="bg-white dark:bg-emerald-900">Todos los estados</option>
                {Object.keys(STATUS_BADGES).map(s => <option key={s} value={s} className="bg-white dark:bg-emerald-900">{statusLabel(s)}</option>)}
              </select>
              <select value={filters.po_type ?? ''} onChange={e => setFilters(p => ({ ...p, po_type: e.target.value || undefined, page: 1 }))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="" className="bg-white dark:bg-emerald-900">Todos los tipos</option>
                <option value="PRODUCTOS" className="bg-white dark:bg-emerald-900">Productos</option>
                <option value="SERVICIOS" className="bg-white dark:bg-emerald-900">Servicios</option>
                <option value="MIXTA" className="bg-white dark:bg-emerald-900">Mixta</option>
              </select>
              <div className="space-y-1">
                <label className="text-[10px] text-theme-text-muted/50">Desde</label>
                <input type="date" value={filters.date_from ?? ''} onChange={e => setFilters(p => ({ ...p, date_from: e.target.value || undefined, page: 1 }))} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-theme-text-muted/50">Hasta</label>
                <input type="date" value={filters.date_to ?? ''} onChange={e => setFilters(p => ({ ...p, date_to: e.target.value || undefined, page: 1 }))} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" />
              </div>
            </div>
          </div>
        )}
      </div>

      <input ref={excelImportInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelImportChange} className="hidden" />
      {excelImportPreview && (
        <ReplenishmentExcelImportDialog
          preview={excelImportPreview}
          loading={excelImportLoading}
          showAll={showAllExcelImportRows}
          onShowAllChange={setShowAllExcelImportRows}
          onClose={() => { setExcelImportPreview(null); setShowAllExcelImportRows(false) }}
          onPrepare={handlePrepareExcelPurchaseOrder}
        />
      )}

      {refreshing && <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-20 z-50 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface/95 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted shadow-md">Actualizando...</div>}

       {initialLoading ? (
         <div className="p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : data.length === 0 ? (
         <div className="p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay órdenes de compra.</p>
        </div>
      ) : (
         <div className="min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-x-contain bg-white">
            <table className="min-w-[1080px] w-full table-fixed whitespace-nowrap border-collapse text-sm">
              <colgroup>{PURCHASE_ORDER_COLUMNS.map(column => <col key={column.id} style={{ width: widths[column.id] ?? column.defaultWidth }} />)}</colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-[#D1C7BD] bg-[#322D29] text-[9px] font-bold uppercase tracking-[0.08em] text-[#EFE9E1]">
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">N° OC{resizeHandle('correlative')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Fecha{resizeHandle('issueDate')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Proveedor{resizeHandle('supplier')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Solicitante{resizeHandle('requester')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Estado{resizeHandle('status')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-right">Total{resizeHandle('total')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Recepción{resizeHandle('receipt')}</th>
                  <th className="relative border-r border-[#AC9C8D]/35 px-2.5 py-2 text-left">Factura{resizeHandle('invoice')}</th>
                  <th className="sticky right-0 z-20 border-l border-[#AC9C8D]/35 bg-[#322D29] px-2.5 py-2 text-right">Acciones</th>
                </tr>
             </thead>
             <tbody>
               {data.map(po => (
                 <tr key={po.id} className={`cursor-pointer border-b border-[#E5DDD4] transition-colors hover:bg-[#F3EFE9] ${selectedPo?.id === po.id ? "bg-[#F5EDEE] border-l-2 border-l-[#72383D]" : "bg-white"}`} onClick={() => openDetail(po)} onDoubleClick={event => { if (!shouldIgnoreOperationalRowDoubleClick(event.target)) openDetail(po) }} onMouseEnter={() => prefetchDetail(po.id)}>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5 text-xs font-mono font-semibold tabular-nums text-[#72383D]" title={po.correlative}>{shortCorrelative(po.correlative)}</td>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5 text-xs tabular-nums text-[#322D29]" title={formatDate(po.issue_date)}>{formatDate(po.issue_date)}</td>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5 text-xs text-[#322D29]" title={po.supplier_name}>{po.supplier_name}</td>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5 text-xs text-[#6D625B]" title={po.requester_name}>{po.requester_name}</td>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5"><Badge value={po.status} map={STATUS_BADGES} label={purchaseOrderStatusLabel(po)} /></td>
                    <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5 text-right text-xs font-medium tabular-nums text-[#322D29]" title={formatCurrency(po.grand_total, po.currency)}>{formatCurrency(po.grand_total, po.currency)}</td>
                   <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5"><Badge value={po.receipt_status} map={RECEIPT_BADGES} /></td>
                   <td className="border-r border-[#E5DDD4] truncate px-2.5 py-1.5"><PurchaseOrderInvoiceCell documents={invoiceSummaries[po.id]} loading={invoiceSummariesLoading} onView={() => setInvoiceViewerPo(po)} /></td>
                    <td className="sticky right-0 z-[5] whitespace-nowrap border-l border-[#D1C7BD] bg-white px-2.5 py-1.5 text-right" onClick={e => e.stopPropagation()}>
                    <button onClick={() => openDetail(po)} className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors" title="Ver detalle">
                      <Eye className="w-4 h-4" />
                    </button>
                    {po.status === 'BORRADOR' && (
                      <button onClick={() => editPO(po)} className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors" title="Editar">
                        <Edit className="w-4 h-4" />
                      </button>
                    )}
                    {['BORRADOR', 'EMITIDA', 'PENDIENTE_APROBACION', 'APROBADA', 'ENVIADA_PROVEEDOR', 'CONFIRMADA'].includes(po.status) && (
                       <button onClick={() => requestCancellation(po)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-theme-text-muted hover:text-red-500 transition-colors" title="Cancelar">
                        <Ban className="w-4 h-4" />
                      </button>
                    )}
                    {po.status === 'RECEPCION_PARCIAL' && (
                      <button onClick={() => requestCloseWithPending(po)} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted hover:text-theme-text transition-colors" title="Cerrar OC con saldo pendiente">
                        <Lock className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
      </div>
      )}

      {totalPages > 1 && (
        <div className="shrink-0 flex items-center justify-between text-xs p-3 border-t border-theme-border/60 bg-theme-text/[0.01]">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
             <select value={filters.pageSize} onChange={e => setFilters(p => ({ ...p, pageSize: parseInt(e.target.value) as 25 | 50 | 100, page: 1 }))} className="h-8 rounded-lg border border-theme-border bg-theme-text/5 px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40">
              <option value={25} className="bg-white dark:bg-emerald-900">25</option>
              <option value={50} className="bg-white dark:bg-emerald-900">50</option>
              <option value={100} className="bg-white dark:bg-emerald-900">100</option>
            </select>
            <span className="text-theme-text-muted/50">de {total} registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) - 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="text-theme-text-muted/50">Pág. {filters.page ?? 1} de {totalPages}</span>
            <button disabled={(filters.page ?? 1) >= totalPages} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) + 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}
        </div>
        
        {selectedPo && (
          <div className="hidden md:flex flex-col flex-1 bg-theme-surface animate-in slide-in-from-right-4 duration-300 overflow-hidden">
             <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02] border-b border-theme-border/70 shrink-0">
               <div className="flex items-center gap-3">
                 <div className="w-7 h-7 rounded-lg bg-theme-accent/10 flex items-center justify-center shrink-0"><PackageOpen className="w-4 h-4 text-theme-accent" /></div>
                 <div>
                   <div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-theme-accent">{selectedPo.correlative}</span><Badge value={selectedPo.status} map={STATUS_BADGES} label={purchaseOrderStatusLabel(selectedPo)} /></div>
                    <p className="text-xs text-theme-text-muted truncate">{selectedPo.supplier_name}</p>
                  </div>
               </div>
               <div className="flex items-center gap-2 shrink-0">
                 <button onClick={() => setSelectedPo(null)} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors"><X className="w-3.5 h-3.5" /></button>
               </div>
             </div>
             <div className="flex-1 overflow-auto p-6 lg:p-8">
               {detail ? (
                 <div className="space-y-8">
                    <div className="flex gap-2">
                       <button onClick={() => void handleDownloadPDF()} disabled={downloadingPdf} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"><Download className="w-3.5 h-3.5" /> {downloadingPdf ? 'PDF...' : 'PDF'}</button>
                       <button onClick={() => void handleDownloadExcel()} disabled={downloadingExcel} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"><FileSpreadsheet className="w-3.5 h-3.5" /> {downloadingExcel ? 'Excel...' : 'Excel'}</button>
                      {detail.po.status === 'EMITIDA' && <button onClick={() => void handleMarkSentToSupplier(detail.po.id)} disabled={isMarkingSent} className="px-4 py-2 rounded-xl border border-[#72383D]/35 text-[#72383D] hover:bg-[#72383D]/10 text-xs font-semibold transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50">{isMarkingSent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}{isMarkingSent ? 'Marcando...' : 'Marcar enviada al proveedor'}</button>}
                       {detail.po.status === 'ENVIADA_PROVEEDOR' && <button onClick={() => openSupplierReview(detail.po.id)} className="px-4 py-2 rounded-xl bg-[#72383D] text-[#EFE9E1] hover:bg-[#5D2E32] text-xs font-semibold transition-colors flex items-center gap-1.5"><ClipboardCheck className="w-3.5 h-3.5" /> Revisar confirmación</button>}
                       {detail.po.status === 'RECEPCION_PARCIAL' && <button onClick={() => requestCloseWithPending(detail.po as PurchaseOrder)} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Cerrar OC</button>}
                       {['BORRADOR', 'EMITIDA', 'PENDIENTE_APROBACION', 'APROBADA', 'ENVIADA_PROVEEDOR', 'CONFIRMADA'].includes(detail.po.status) && <button onClick={() => requestCancellation(detail.po as PurchaseOrder)} className="px-4 py-2 rounded-xl border border-red-500/30 text-red-500 hover:bg-red-500/10 text-xs font-semibold transition-colors flex items-center gap-1.5"><Ban className="w-3.5 h-3.5" /> Anular</button>}
                    </div>
                   {detail.po.status === 'CERRADA' && detail.po.closed_with_pending && (
                     <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-700 dark:text-amber-200">
                       <p className="font-semibold">Cerrada con saldo pendiente</p>
                       {detail.po.closure_reason && <p className="mt-1">Motivo: {detail.po.closure_reason}</p>}
                       {detail.po.closed_at && <p className="mt-1 opacity-80">Cerrada el {formatDate(detail.po.closed_at)}</p>}
                     </div>
                   )}
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-5">
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Fecha emisión</p><p className="text-sm text-theme-text">{formatDate(selectedPo.issue_date)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total Neto</p><p className="text-sm text-theme-text">{formatCurrency(selectedPo.net_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total IVA</p><p className="text-sm text-theme-text">{formatCurrency(selectedPo.tax_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total Compra</p><p className="text-sm text-theme-text font-bold">{formatCurrency(selectedPo.grand_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Bodega destino</p><p className="text-sm text-theme-text">{selectedPo.warehouse_name || "—"}</p></div>
                   </div>
                   <h3 className="text-sm font-bold text-theme-text mb-4 mt-8">Líneas de la orden</h3>
                   <div className="overflow-x-auto rounded-xl border border-theme-border">
                     <table className="w-full text-sm">
                       <thead><tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider"><th className="text-left py-3 px-4">Producto/Servicio</th><th className="text-right py-3 px-4">Cantidad</th><th className="text-right py-3 px-4">Total</th></tr></thead>
                       <tbody>
                         {detail.items.map(it => (
                           <tr key={it.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                             <td className="py-3 px-4 text-xs text-theme-text">{it.product_description}</td>
                             <td className="py-3 px-4 text-xs text-theme-text text-right">{it.quantity}</td>
                             <td className="py-3 px-4 text-xs text-theme-text font-semibold text-right">{formatCurrency(it.line_total, detail.po.currency)}</td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </div>
                 </div>
               ) : (
                 <div className="animate-pulse flex flex-col items-center justify-center h-40">
                   <div className="w-8 h-8 border-4 border-theme-text/10 border-t-theme-accent rounded-full animate-spin mb-4" />
                   <p className="text-sm font-medium text-theme-text-muted">Cargando detalle de orden de compra...</p>
                 </div>
                )}
              </div>
           </div>
         )}
       </div>

        {cancellationModal}
        {invoiceViewerPo && (
          <PurchaseOrderInvoiceViewerModal
            correlative={invoiceViewerPo.correlative}
            supplierName={invoiceViewerPo.supplier_name}
            documents={invoiceSummaries[invoiceViewerPo.id] ?? []}
            onClose={() => setInvoiceViewerPo(null)}
          />
        )}
        {closePendingPo && (
        <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Cerrar orden de compra con saldo pendiente">
          <div className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface p-5 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-theme-text">Cerrar OC {closePendingPo.correlative}</h3>
                <p className="mt-1 text-xs text-theme-text-muted">El cierre es definitivo y distinto de una cancelación. No modifica cantidades, documentos, Kardex ni stock.</p>
              </div>
              <button type="button" onClick={() => setClosePendingPo(null)} disabled={closingPending} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-50" aria-label="Cerrar">
                <X className="h-4 w-4" />
              </button>
            </div>
            {closePendingSummary && (
              <div className="mt-4 grid grid-cols-3 gap-3 rounded-xl border border-theme-border bg-theme-text/[0.02] p-3 text-center">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">Solicitado</p>
                  <p className="text-sm font-semibold text-theme-text">{closePendingSummary.ordered}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">Recibido</p>
                  <p className="text-sm font-semibold text-theme-text">{closePendingSummary.received}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">Pendiente</p>
                  <p className="text-sm font-semibold text-amber-600">{closePendingSummary.pending}</p>
                </div>
              </div>
            )}
            <div className="mt-4">
              <label className="mb-1 block text-xs font-semibold text-theme-text">Motivo de cierre</label>
              <textarea value={closeReason} onChange={e => setCloseReason(e.target.value)} rows={3} placeholder="Indica por qué se cierra la OC con saldo pendiente..." className={textareaClass} />
            </div>
            {closeError && <p className="mt-2 text-xs font-semibold text-red-500">{closeError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setClosePendingPo(null)} disabled={closingPending} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void handleCloseWithPending()} disabled={closingPending} className="flex items-center gap-1.5 rounded-lg bg-[#72383D] px-3 py-2 text-xs font-semibold text-white hover:bg-[#5D2E32] disabled:opacity-50">
                {closingPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                {closingPending ? 'Cerrando...' : 'Cerrar OC'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
