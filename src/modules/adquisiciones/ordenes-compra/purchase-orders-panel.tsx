'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Search, Plus, Filter, X, Eye, Edit, Download, Ban, PackageOpen, XCircle, CheckCircle2, BarChart3 } from 'lucide-react'
import { AuthorizedPersonnelCombobox } from '@/components/ui/authorized-personnel-combobox'
import {
  getPurchaseOrders, getPurchaseOrderDetail, createPurchaseOrder,
  updatePurchaseOrderStatus, getAuthorizedPersonnel, createAuthorizedPersonnel,
  getNextCorrelative,
  type PurchaseOrder, type PurchaseOrderDetail, type PurchaseOrderFilters,
  type AuthorizedPersonnel
} from '@/app/actions/adquisiciones/purchase-orders'
import { getSuppliers, type Supplier } from '@/app/actions/adquisiciones/suppliers'
import { searchPurchaseOrderProducts, type Product } from '@/app/actions/adquisiciones/products'
import { getWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { downloadPOBooklet, generatePdfBlob } from '@/lib/pdf/generate-po-pdf'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { OperationalTableResizeHandle, shouldIgnoreOperationalRowDoubleClick, useOperationalTableWidths, type OperationalTableColumn } from '@/components/ui/operational-table'
import { ReplenishmentAnalysisPanel } from './replenishment-analysis-panel'
import { formatCivilDate } from '@/lib/datetime'

const STATUS_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  BORRADOR: { bg: 'bg-gray-500/10', text: 'text-gray-500', border: 'border-gray-500/20' },
  EMITIDA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  PENDIENTE_APROBACION: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  APROBADA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  ENVIADA_PROVEEDOR: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' },
  RECEPCION_PARCIAL: { bg: 'bg-cyan-500/10', text: 'text-cyan-500', border: 'border-cyan-500/20' },
  RECEPCION_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  FACTURADA_PARCIAL: { bg: 'bg-purple-500/10', text: 'text-purple-500', border: 'border-purple-500/20' },
  FACTURADA_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  CERRADA: { bg: 'bg-gray-500/10', text: 'text-gray-500', border: 'border-gray-500/20' },
  CANCELADA: { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' },
  RECHAZADA: { bg: 'bg-red-500/10', text: 'text-red-500', border: 'border-red-500/20' },
}

const RECEIPT_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  PENDIENTE: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  RECEPCION_PARCIAL: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/20' },
  RECEPCION_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
}

const INVOICE_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  PENDIENTE: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/20' },
  FACTURADA_PARCIAL: { bg: 'bg-purple-500/10', text: 'text-purple-500', border: 'border-purple-500/20' },
  FACTURADA_TOTAL: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
  PAGADA: { bg: 'bg-emerald-500/10', text: 'text-emerald-500', border: 'border-emerald-500/20' },
}

const PURCHASE_ORDERS_TABLE_KEY = 'mym:table:adquisiciones:ordenes-compra'
const REPLENISHMENT_PO_PREPARATION_KEY = 'mym:adquisiciones:replenishment-po-preparation'
const PURCHASE_ORDER_COLUMNS: OperationalTableColumn[] = [
  { id: 'correlative', defaultWidth: 120, minWidth: 100, maxWidth: 190 },
  { id: 'issueDate', defaultWidth: 105, minWidth: 95, maxWidth: 150 },
  { id: 'supplier', defaultWidth: 250, minWidth: 190, maxWidth: 420 },
  { id: 'type', defaultWidth: 95, minWidth: 85, maxWidth: 170 },
  { id: 'warehouse', defaultWidth: 165, minWidth: 130, maxWidth: 300 },
  { id: 'requester', defaultWidth: 150, minWidth: 120, maxWidth: 260 },
  { id: 'authorized', defaultWidth: 150, minWidth: 120, maxWidth: 260 },
  { id: 'status', defaultWidth: 125, minWidth: 110, maxWidth: 210 },
  { id: 'total', defaultWidth: 125, minWidth: 110, maxWidth: 190 },
  { id: 'receipt', defaultWidth: 125, minWidth: 110, maxWidth: 210 },
  { id: 'invoice', defaultWidth: 125, minWidth: 110, maxWidth: 210 },
  { id: 'actions', defaultWidth: 115, minWidth: 105, maxWidth: 170, sticky: 'right', resizable: false },
]

function formatCurrency(amount: number, currency = 'CLP') {
  return amount.toLocaleString('es-CL', { style: 'currency', currency })
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—'
  return formatCivilDate(dateStr) || '—'
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    BORRADOR: 'Borrador', EMITIDA: 'Emitida', PENDIENTE_APROBACION: 'Pendiente Aprob.', APROBADA: 'Aprobada',
    ENVIADA_PROVEEDOR: 'Enviada Prov.', RECEPCION_PARCIAL: 'Recep. Parcial',
    RECEPCION_TOTAL: 'Recep. Total', FACTURADA_PARCIAL: 'Fact. Parcial',
    FACTURADA_TOTAL: 'Fact. Total', CERRADA: 'Cerrada', CANCELADA: 'Cancelada',
    RECHAZADA: 'Rechazada',
  }
  return map[s] || s
}

function Badge({ value, map }: { value: string | null; map: Record<string, { bg: string; text: string; border: string }> }) {
  if (!value) return <span className="text-[11px] text-theme-text-muted/40">—</span>
  const s = map[value]
  if (!s) return <span className="text-[11px] text-theme-text-muted/40">{value}</span>
  return <span className={`inline-flex whitespace-nowrap text-[11px] font-semibold px-2 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}>{statusLabel(value)}</span>
}

const inputClass = "w-full h-9 rounded-lg border border-[#778B96]/30 bg-white px-3 text-xs text-[#28353E] placeholder:text-[#778B96] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:border-[#45567D]"
const selectClass = "w-full h-9 rounded-lg border border-[#778B96]/30 bg-white px-3 text-xs text-[#28353E] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:border-[#45567D] appearance-none"
const textareaClass = "w-full rounded-lg border border-[#778B96]/30 bg-white px-3 py-2 text-xs text-[#28353E] placeholder:text-[#778B96] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:border-[#45567D] resize-none"

export function PurchaseOrdersPanel({ initialOpenPoId, onInitialOpenConsumed }: { initialOpenPoId?: string | null, onInitialOpenConsumed?: () => void }) {
  const [view, setView] = useState<'list' | 'form' | 'detail' | 'analysis'>('list')
  const [selectedPo, setSelectedPo] = useState<PurchaseOrder | null>(null)
  const detailCacheRef = useRef<Record<string, PurchaseOrderDetail>>({})
  const pendingRequestsRef = useRef<Record<string, Promise<PurchaseOrderDetail | null>>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const [data, setData] = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [filters, setFilters] = useState<PurchaseOrderFilters>({ page: 1, pageSize: 50 })
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [authorizedPersonnel, setAuthorizedPersonnel] = useState<AuthorizedPersonnel[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<Product[]>([])
  const [productSearchLoading, setProductSearchLoading] = useState(false)
  const [productDropdownOpen, setProductDropdownOpen] = useState(false)
  const [productPage, setProductPage] = useState(0)
  const [productHasMore, setProductHasMore] = useState(false)
  const [productLoadingMore, setProductLoadingMore] = useState(false)
  const productSearchCacheRef = useRef(new Map<string, { data: Product[]; has_more: boolean }>())
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
    tax_rate: number
    warehouse_id: string
    notes: string
  }

  const [items, setItems] = useState<LineItem[]>([])
  const [editingItem, setEditingItem] = useState<string | null>(null)

  const tempIdCounter = useRef(0)
  function newTempId() { tempIdCounter.current += 1; return `ni_${tempIdCounter.current}` }

  interface ReplenishmentPreparationPayload {
    source: 'REPLENISHMENT'
    supplier: { id: string; name: string }
    items: Array<{
      product_id: string
      sku: string
      product_description: string
      unit: string
      quantity: number
      unit_price: number
      reference_unit_cost: number
      discount_percent: number
      tax_rate: number
    }>
  }

  const totalPages = Math.ceil(total / (filters.pageSize ?? 50))

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current
    if (loaded.current) setRefreshing(true)
    else setInitialLoading(true)
    try {
      const res = await getPurchaseOrders(filters)
      if (requestId !== requestSequence.current) return
      setData(res.data)
      setTotal(res.total)
      loaded.current = true
    } catch {
      if (requestId === requestSequence.current) msg('No se pudieron actualizar las órdenes de compra.')
    } finally {
      if (requestId === requestSequence.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [filters])

  useEffect(() => { load() }, [load])

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
        setItems(d.items.map(i => ({
          tempId: i.id,
          item_type: (i.item_type === 'SERVICE' ? 'SERVICE' : 'PRODUCT') as 'PRODUCT' | 'SERVICE',
          product_id: i.product_id || '',
          sku: '', // Podríamos recuperarlo si viniera, pero se deja vacio en base al modelo
          description: i.product_description || '',
          unit: i.unit || 'UNIDAD',
          quantity: i.quantity || 0,
          unit_price: i.unit_price || 0,
          discount_percent: i.discount_percent || 0,
          tax_rate: i.tax_rate || 19,
          warehouse_id: i.warehouse_id || '',
          notes: i.notes || '',
        })));
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
      getWarehouses(),
      getAuthorizedPersonnel(),
    ]).then(([sup, wh, auth]) => {
      setSuppliers(sup)
      setWarehouses(wh.data)
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
    const supplier = suppliers.find(s => s.id === form.supplier_id)
    if (!supplier) return
    if (!isReplenishmentPreparation && supplier.discount_percent > 0) {
      setItems(prev => prev.map(it => ({
        ...it,
        discount_percent: supplier.discount_percent,
      })))
    }
    if (supplier.payment_terms) {
      setForm(p => ({ ...p, payment_terms: supplier.payment_terms || p.payment_terms }))
    }
  }, [form.supplier_id, isReplenishmentPreparation, suppliers])

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  useEffect(() => {
    if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('prepare') !== 'replenishment') return

    const raw = sessionStorage.getItem(REPLENISHMENT_PO_PREPARATION_KEY)
    try {
      const payload = raw ? JSON.parse(raw) as ReplenishmentPreparationPayload : null
      const valid = payload?.source === 'REPLENISHMENT'
        && Boolean(payload.supplier?.id && payload.supplier?.name)
        && Array.isArray(payload.items)
        && payload.items.length > 0
        && payload.items.every(item => Boolean(item.product_id && item.sku && item.product_description)
          && Number.isFinite(item.quantity) && item.quantity > 0
          && Number.isFinite(item.unit_price) && Number.isFinite(item.reference_unit_cost)
          && Number.isFinite(item.discount_percent) && Number.isFinite(item.tax_rate))
      if (!valid) {
        msg('La preparación de la orden de compra ya no está disponible.')
        return
      }

      sessionStorage.removeItem(REPLENISHMENT_PO_PREPARATION_KEY)
      setForm(prev => ({ ...prev, supplier_id: payload.supplier.id, po_type: 'PRODUCTOS', currency: 'CLP' }))
      setReplenishmentSupplierName(payload.supplier.name)
      setIsReplenishmentPreparation(true)
      setItems(payload.items.map(item => ({
        tempId: newTempId(),
        item_type: 'PRODUCT' as const,
        product_id: item.product_id,
        sku: item.sku,
        description: item.product_description,
        unit: item.unit || 'UNIDAD',
        quantity: item.quantity,
        unit_price: item.unit_price,
        reference_unit_cost: item.reference_unit_cost,
        discount_percent: item.discount_percent ?? 0,
        tax_rate: item.tax_rate,
        warehouse_id: '',
        notes: '',
      })))
      setEditId(null)
      setView('form')
    } catch {
      msg('La preparación de la orden de compra ya no está disponible.')
    }
  }, [])

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
    setEditingItem(null)
    setEditId(null)
    setProductSearch('')
    setProductResults([])
    setProductDropdownOpen(false)
    setProductPage(0)
    setProductHasMore(false)
    setProductSearchLoading(false)
    setProductLoadingMore(false)
    productLoadingMoreRef.current = false
    setShowAuthorizerForm(false)
    setReplenishmentSupplierName('')
    setIsReplenishmentPreparation(false)
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
      setItems(d.items.map(i => ({
        tempId: i.id,
        item_type: (i.item_type === 'SERVICE' ? 'SERVICE' : 'PRODUCT') as 'PRODUCT' | 'SERVICE',
        product_id: i.product_id || '',
        sku: '',
        description: i.product_description || '',
        unit: i.unit || 'UNIDAD',
        quantity: i.quantity || 0,
        unit_price: i.unit_price || 0,
        discount_percent: i.discount_percent || 0,
        tax_rate: i.tax_rate || 19,
        warehouse_id: i.warehouse_id || '',
        notes: i.notes || '',
      })))
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
    if (items.length === 0) { msg('Agrega al menos una línea a la orden'); return }
    const res = await createPurchaseOrder({
      issue_date: form.issue_date,
      required_date: form.required_date,
      supplier_id: form.supplier_id,
      source_type: isReplenishmentPreparation ? 'REPLENISHMENT' : 'MANUAL',
      warehouse_id: form.warehouse_id,
      payment_terms: form.payment_terms || undefined,
      authorized_by: form.authorized_by || undefined,
      notes: form.notes || undefined,
      currency: form.currency,
      items: items.map(it => ({
        item_type: it.item_type,
        product_id: it.product_id || null,
        product_description: it.description,
        unit: it.unit || null,
        quantity: it.quantity,
        unit_price: it.unit_price,
        discount_percent: it.discount_percent,
        tax_rate: it.tax_rate,
        warehouse_id: it.warehouse_id || null,
        notes: it.notes || null,
      })),
    })
    if ('error' in res && res.error) { msg(res.error); return }
    msg('Orden de compra creada')
    setView('list'); resetForm(); load()
  }

  async function handleStatusUpdate(poId: string, newStatus: string, reason?: string) {
    if (newStatus === 'CANCELADA' && !confirm('¿Cancelar esta orden de compra?')) return
    const res = await updatePurchaseOrderStatus(poId, newStatus, reason)
    if ('error' in res && res.error) { msg(res.error); return }
    msg(`Estado actualizado a ${statusLabel(newStatus)}`)
    const d = await getPurchaseOrderDetail(poId)
    if (d) setDetail(d)
    load()
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

      const pageData = { data: response.data, has_more: response.has_more }
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

  function addProductToItems(p: Product) {
    if (items.some(it => it.product_id === p.id)) { msg('Este producto ya está en la orden'); return }
    setItems(prev => [...prev, {
      tempId: newTempId(),
      item_type: 'PRODUCT',
      product_id: p.id,
      sku: p.sku,
      description: p.description,
      unit: p.unit_of_measure || 'UNIDAD',
      quantity: 1,
      unit_price: 0,
      discount_percent: 0,
      tax_rate: p.tax_rate || 19,
      warehouse_id: form.warehouse_id,
      notes: '',
    }])
    setProductSearch('')
    setProductResults([])
    setProductDropdownOpen(false)
    setProductPage(0)
    setProductHasMore(false)
    setProductSearchLoading(false)
    if (productSearchTimerRef.current !== null) window.clearTimeout(productSearchTimerRef.current)
    productSearchRequestSequence.current += 1
  }

  function updateItem(tempId: string, field: keyof LineItem, value: unknown) {
    setItems(prev => prev.map(it => it.tempId === tempId ? { ...it, [field]: value } : it))
  }

  function removeItem(tempId: string) {
    setItems(prev => prev.filter(it => it.tempId !== tempId))
    if (editingItem === tempId) setEditingItem(null)
  }

  const netTotal = items.reduce((sum, it) => sum + (it.quantity * it.unit_price), 0)
  const discountTotal = items.reduce((sum, it) => sum + (it.quantity * it.unit_price * it.discount_percent / 100), 0)
  const taxableAmount = items.reduce((sum, it) => {
    const lineNet = it.quantity * it.unit_price
    const lineDiscount = lineNet * it.discount_percent / 100
    return sum + (lineNet - lineDiscount)
  }, 0)
  const taxTotal = items.reduce((sum, it) => {
    const lineNet = it.quantity * it.unit_price
    const lineDiscount = lineNet * it.discount_percent / 100
    return sum + ((lineNet - lineDiscount) * it.tax_rate / 100)
  }, 0)
  const grandTotal = netTotal - discountTotal + taxTotal


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
    if (!detail) return
    const it = detail.items
    const net = it.reduce((s, i) => s + (i.quantity * i.unit_price), 0)
    const disc = it.reduce((s, i) => s + (i.quantity * i.unit_price * i.discount_percent / 100), 0)
    const tax = it.reduce((s, i) => {
      const ln = i.quantity * i.unit_price
      const ld = ln * i.discount_percent / 100
      return s + ((ln - ld) * i.tax_rate / 100)
    }, 0)
    const pdfDetail = {
      po: {
        id: detail.po.id,
        correlative: detail.po.correlative,
        issue_date: detail.po.issue_date,
        required_date: detail.po.required_date || undefined,
        supplier_name: detail.po.supplier_name,
        supplier_rut: detail.po.supplier_rut || undefined,
        supplier_contact: detail.po.supplier_contact || undefined,
        supplier_email: detail.po.supplier_email || undefined,
        supplier_phone: detail.po.supplier_phone || undefined,
        supplier_address: detail.po.supplier_address || undefined,
        warehouse_name: detail.po.warehouse_name || undefined,
        po_type: detail.po.po_type,
        currency: detail.po.currency,
        payment_terms: detail.po.payment_terms || undefined,
        requester_name: detail.po.requester_name || '',
        authorized_name: detail.po.authorized_name || undefined,
        notes: detail.po.notes || undefined,
        net_total: net,
        discount_total: disc,
        tax_total: tax,
        exempt_total: detail.po.exempt_total || 0,
        grand_total: net - disc + tax,
        status: detail.po.status,
        receipt_status: detail.po.receipt_status || undefined,
        invoice_status: detail.po.invoice_status || undefined,
        created_at: detail.po.created_at,
        company_name: detail.po.company_name,
        company_rut: detail.po.company_rut,
        company_logo_url: detail.po.company_logo_url,
        company_phone: detail.po.company_phone,
        company_email: detail.po.company_email,
        company_address: detail.po.company_address
      },
      items: it.map((i, idx) => ({
        line_number: idx + 1,
        item_type: i.item_type,
        product_id: i.product_id || undefined,
        product_description: i.product_description,
        unit: i.unit || undefined,
        quantity: i.quantity,
        unit_price: i.unit_price,
        discount_percent: i.discount_percent,
        discount_amount: i.discount_amount,
        tax_rate: i.tax_rate,
        tax_amount: i.tax_amount,
        line_total: i.line_total,
        warehouse_name: i.warehouse_name || undefined,
        cost_center: i.cost_center || undefined,
        notes: i.notes || undefined,
      })),
    }
    await downloadPOBooklet(pdfDetail, `OC_${detail.po.correlative}`, undefined)
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
        po_type: form.po_type,
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
      items: items.map((it, idx) => ({
        line_number: idx + 1,
        item_type: it.item_type,
        product_id: it.product_id || undefined,
        product_description: it.description,
        unit: it.unit || undefined,
        quantity: it.quantity,
        unit_price: it.unit_price,
        discount_percent: it.discount_percent,
        discount_amount: it.quantity * it.unit_price * it.discount_percent / 100,
        tax_rate: it.tax_rate,
        tax_amount: ((it.quantity * it.unit_price) - (it.quantity * it.unit_price * it.discount_percent / 100)) * it.tax_rate / 100,
        line_total: it.quantity * it.unit_price,
        warehouse_name: warehouse?.name || undefined,
        notes: it.notes || undefined,
      })),
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
      <div className="flex flex-col h-full overflow-hidden bg-[#DFEBF7]/30 animate-in fade-in zoom-in-95 duration-200">
        {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto">
          <div className="px-4 sm:px-6 py-3 border-b border-[#778B96]/25 bg-[#28353E] flex flex-wrap items-center justify-between gap-3 sticky top-0 z-10 shadow-md shadow-[#28353E]/10">
            <div className="flex items-center gap-3 min-w-0">
              <button type="button" onClick={() => { setView('list'); resetForm() }} className="p-1.5 rounded-lg text-[#DFEBF7]/75 hover:bg-white/10 hover:text-white transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A4C7D5]">Adquisiciones</p>
                <h2 className="truncate text-base sm:text-lg font-bold text-white">{editId ? 'Editar orden de compra' : 'Nueva orden de compra'}</h2>
              </div>
            </div>
            <div className="flex w-full sm:w-auto gap-2">
              <button type="button" onClick={() => { setView('list'); resetForm() }} className="flex-1 sm:flex-none px-3.5 py-1.5 rounded-lg border border-white/20 text-[#DFEBF7]/80 hover:text-white hover:bg-white/10 text-xs font-semibold transition-colors">
                Cancelar
              </button>
              <button type="button" onClick={handlePreviewPDF} className="flex-1 sm:flex-none px-3.5 py-1.5 rounded-lg border border-[#A4C7D5]/45 text-[#DFEBF7] hover:bg-[#45567D] text-xs font-semibold transition-colors">
                Vista previa PDF
              </button>
              <button type="submit" className="flex-1 sm:flex-none px-4 py-1.5 rounded-lg bg-[#A4C7D5] hover:bg-[#DFEBF7] text-[#28353E] text-xs font-bold transition-colors shadow-lg shadow-[#A4C7D5]/20">
                Emitir OC
              </button>
            </div>
          </div>
          <div className="p-4 sm:p-5 lg:p-6 space-y-5 sm:space-y-6">
            <section className="rounded-xl border border-[#778B96]/25 bg-white/70 p-4 sm:p-5 shadow-sm backdrop-blur-sm">
              <div className="mb-4 flex items-center justify-between border-b border-[#778B96]/20 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-[#28353E]">Datos generales</h3>
                  <p className="mt-0.5 text-[11px] text-[#778B96]">Información principal de la orden</p>
                </div>
                <span className="hidden sm:block rounded-full bg-[#DFEBF7] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#45567D]">Cabecera OC</span>
              </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-3.5">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-[#45567D]">Fecha emisión</label>
                <div className="h-9 rounded-lg border border-[#778B96]/25 bg-[#DFEBF7]/55 px-3 flex items-center text-xs text-[#45567D]">
                  {new Date().toLocaleDateString('es-CL')}
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-[#45567D]">Fecha requerida</label>
                <input type="date" value={form.required_date} onChange={e => setForm(p => ({ ...p, required_date: e.target.value }))} className={inputClass} />
              </div>
              <div ref={supplierRef} className="relative space-y-1">
                 <label className="text-[11px] font-semibold text-[#45567D]">Proveedor *</label>
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
                    className="w-full h-9 rounded-lg border border-[#778B96]/30 bg-white px-3 text-xs text-[#28353E] placeholder:text-[#778B96] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:border-[#45567D]"
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
              <div className="relative space-y-1" ref={warehouseRef}>
                 <label className="text-[11px] font-semibold text-[#45567D]">Bodega destino</label>
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
                       className="w-full h-9 rounded-lg border border-[#778B96]/30 bg-white px-3 text-xs text-[#28353E] placeholder:text-[#778B96] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:border-[#45567D]"
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
              <div className="space-y-1">
                 <label className="text-[11px] font-semibold text-[#45567D]">Tipo OC</label>
                <select value={form.po_type} onChange={e => setForm(p => ({ ...p, po_type: e.target.value }))} className={selectClass}>
                  <option value="PRODUCTOS" className="bg-white dark:bg-emerald-900">Productos</option>
                  <option value="SERVICIOS" className="bg-white dark:bg-emerald-900">Servicios</option>
                  <option value="MIXTA" className="bg-white dark:bg-emerald-900">Mixta</option>
                </select>
              </div>
              <div className="space-y-1">
                 <label className="text-[11px] font-semibold text-[#45567D]">Moneda</label>
                <select value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))} className={selectClass}>
                  <option value="CLP" className="bg-white dark:bg-emerald-900">CLP</option>
                  <option value="USD" className="bg-white dark:bg-emerald-900">USD</option>
                  <option value="EUR" className="bg-white dark:bg-emerald-900">EUR</option>
                </select>
              </div>
              <div className="space-y-1">
                 <label className="text-[11px] font-semibold text-[#45567D]">Condiciones de pago</label>
                <input type="text" value={form.payment_terms} onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))} placeholder="Ej: 30 días" className={inputClass} />
              </div>
              {showAuthorizerForm ? (
                <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 border border-theme-border rounded-xl p-4 space-y-4 bg-theme-text/5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider">Nuevo autorizador</h4>
                    <button type="button" onClick={() => setShowAuthorizerForm(false)} className="text-xs text-theme-text-muted hover:text-theme-text">Cancelar</button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-4">
                    <div className="space-y-1">
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
              <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1">
                 <label className="text-[11px] font-semibold text-[#45567D]">Notas</label>
                  <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} className={`${textareaClass} min-h-16 border-[#778B96]/30 bg-white focus:ring-2 focus:ring-[#A4C7D5]/60`} />
               </div>
             </div>
           </section>

            <section className="rounded-xl border border-[#778B96]/25 bg-white/75 p-4 sm:p-5 shadow-sm backdrop-blur-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-sm font-bold text-[#28353E]">Líneas de la orden</h3>
                  <p className="mt-0.5 text-[11px] text-[#778B96]">Productos y servicios incluidos</p>
                </div>
              </div>

              <div ref={productRef} className="mb-4 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                    <input type="text" value={productSearch} onChange={e => handleProductSearch(e.target.value)}
                     onFocus={openProductDropdown}
                     disabled={!form.supplier_id}
                     placeholder={form.supplier_id ? "Buscar por SKU, descripción o código de barra..." : "Selecciona primero un proveedor"}
                      className="w-full h-9 pl-10 pr-4 rounded-lg border border-[#778B96]/30 bg-[#DFEBF7]/35 text-xs text-[#28353E] placeholder:text-[#778B96] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60 focus:bg-white disabled:cursor-not-allowed disabled:opacity-65 disabled:bg-[#E7E7E7]/70" />
                  {!form.supplier_id && <p className="mt-1.5 text-[10px] text-[#778B96]">Debe seleccionar primero el proveedor para buscar productos.</p>}
                  {form.supplier_id && productDropdownOpen && (
                    <div onScroll={handleProductDropdownScroll} className="absolute top-full left-0 right-0 mt-1 bg-theme-surface border border-theme-border rounded-xl shadow-xl z-20 max-h-80 overflow-y-auto">
                      {productSearchLoading ? <p className="px-4 py-2.5 text-xs text-theme-text-muted/60">Buscando...</p> : productResults.length === 0 ? (
                        <p className="px-4 py-2.5 text-xs text-theme-text-muted/60">
                          {productSearch.trim() ? 'No se encontraron productos para este proveedor.' : 'Este proveedor no tiene productos disponibles.'}
                        </p>
                      ) : productResults.map(p => (
                        <button key={p.id} type="button" onClick={() => addProductToItems(p)}
                          className="w-full text-left px-4 py-2.5 text-xs text-theme-text hover:bg-theme-text/5 border-b border-theme-border last:border-0 flex items-center justify-between">
                          <span><span className="font-mono font-semibold">{p.sku}</span> — {p.description}</span>
                          <span className="text-theme-text-muted/50">{p.unit_of_measure || '—'}</span>
                        </button>
                      ))}
                      {productLoadingMore && <p className="border-t border-theme-border px-4 py-2.5 text-center text-[11px] text-theme-text-muted/60">Cargando más productos...</p>}
                    </div>
                  )}
              </div>

                <div className="overflow-x-auto rounded-lg border border-[#778B96]/25">
                 <table className="w-full min-w-[1120px] table-fixed text-sm">
                   <colgroup>
                     <col className="w-10" />
                     <col className="w-24" />
                     <col />
                     <col className="w-20" />
                     <col className="w-24" />
                     <col className="w-32" />
                     <col className="w-20" />
                     <col className="w-32" />
                     <col className="w-20" />
                     <col className="w-32" />
                     <col className="w-12" />
                   </colgroup>
                   <thead className="bg-[#28353E]">
                     <tr className="border-b border-[#45567D] text-[10px] text-[#DFEBF7]/80 uppercase tracking-wider">
                       <th className="text-center py-2.5 px-3 font-semibold">#</th>
                       <th className="text-center py-2.5 px-3 font-semibold">Tipo</th>
                       <th className="text-left py-2.5 px-3 font-semibold">Producto/Servicio</th>
                       <th className="text-center py-2.5 px-3 font-semibold">Unidad</th>
                       <th className="text-center py-2.5 px-3 font-semibold">Cantidad</th>
                       <th className="text-center py-2.5 px-3 font-semibold">P.Unitario</th>
                       <th className="text-center py-2.5 px-3 font-semibold">Dto%</th>
                       <th className="text-right py-2.5 px-3 font-semibold">Descuento</th>
                       <th className="text-center py-2.5 px-3 font-semibold">IVA%</th>
                       <th className="text-right py-2.5 px-3 font-semibold">Total</th>
                       <th className="text-center py-2.5 px-3 font-medium">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="py-8 text-center text-xs text-theme-text-muted/40">No hay líneas agregadas</td>
                      </tr>
                    ) : items.map((it, idx) => (
                       <tr key={it.tempId} className="border-b border-[#778B96]/15 odd:bg-white even:bg-[#DFEBF7]/20 hover:bg-[#DFEBF7]/60 transition-colors">
                         <td className="py-2 px-3 text-center text-xs text-[#778B96]">{idx + 1}</td>
                         <td className="py-2 px-3 text-center">
                           <span className="text-[10px] font-semibold px-2 py-0.5 rounded border bg-[#DFEBF7] text-[#45567D] border-[#A4C7D5]/70">{it.item_type === 'PRODUCT' ? 'Producto' : 'Servicio'}</span>
                        </td>
                         <td className="py-2 px-3 text-xs text-[#28353E]">
                          {editingItem === it.tempId ? (
                             <input type="text" value={it.description} onChange={e => updateItem(it.tempId, 'description', e.target.value)} className="w-full h-8 rounded-lg border border-[#778B96]/30 bg-white px-2 text-xs text-[#28353E] focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60" />
                          ) : (
                            <span>{it.description || <span className="text-theme-text-muted/40">—</span>}</span>
                          )}
                        </td>
                         <td className="py-2 px-3 text-center text-xs text-[#778B96]">{it.unit}</td>
                         <td className="py-2 px-3 text-center">
                           <input type="number" min="0" step="0.001" value={it.quantity} onChange={e => updateItem(it.tempId, 'quantity', parseFloat(e.target.value) || 0)} className="mx-auto block w-20 h-8 rounded-lg border border-[#778B96]/30 bg-white px-2 text-xs text-[#28353E] text-right focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60" />
                        </td>
                         <td className="py-2 px-3 text-center">
                            <input type="number" min="0" step="1" value={it.unit_price} onChange={e => updateItem(it.tempId, 'unit_price', parseFloat(e.target.value) || 0)} className="mx-auto block w-24 h-8 rounded-lg border border-[#778B96]/30 bg-white px-2 text-xs text-[#28353E] text-right focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60" />
                            {it.reference_unit_cost !== undefined && <span className="block mt-0.5 text-[10px] text-[#778B96]">Ref. Bsale {formatCurrency(it.reference_unit_cost, 'CLP')}</span>}
                        </td>
                         <td className="py-2 px-3 text-center">
                           <input type="number" min="0" max="100" step="0.01" value={it.discount_percent} onChange={e => updateItem(it.tempId, 'discount_percent', parseFloat(e.target.value) || 0)} className="mx-auto block w-16 h-8 rounded-lg border border-[#778B96]/30 bg-white px-2 text-xs text-[#28353E] text-right focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60" />
                        </td>
                        <td className="py-2.5 px-3 text-xs text-theme-text-muted/60 text-right">{(it.quantity * it.unit_price * it.discount_percent / 100).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })}</td>
                         <td className="py-2 px-3 text-center">
                           <input type="number" min="0" max="100" step="0.01" value={it.tax_rate} onChange={e => updateItem(it.tempId, 'tax_rate', parseFloat(e.target.value) || 0)} className="mx-auto block w-16 h-8 rounded-lg border border-[#778B96]/30 bg-white px-2 text-xs text-[#28353E] text-right focus:outline-none focus:ring-2 focus:ring-[#A4C7D5]/60" />
                        </td>
                        <td className="py-2.5 px-3 text-xs text-theme-text font-semibold text-right">
                          {(() => {
                            const lineNet = it.quantity * it.unit_price
                            const lineDisc = lineNet * it.discount_percent / 100
                            const lineTax = (lineNet - lineDisc) * it.tax_rate / 100
                            return (lineNet - lineDisc + lineTax).toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
                          })()}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <button type="button" onClick={() => removeItem(it.tempId)} className="p-1 rounded-lg hover:bg-red-500/10 text-theme-text-muted hover:text-red-500 transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

               <div className="flex justify-end mt-4">
                 <div className="w-full sm:w-80 rounded-lg border border-[#778B96]/25 bg-[#DFEBF7]/45 p-3.5 space-y-1 text-xs">
                   <div className="flex justify-between py-1">
                     <span className="text-[#778B96]">Neto</span>
                     <span className="text-[#28353E] font-medium">{formatCurrency(netTotal, form.currency)}</span>
                  </div>
                  {discountTotal > 0 && (
                    <div className="flex justify-between py-1">
                      <span className="text-theme-text-muted/70">Descuentos</span>
                      <span className="text-red-500">-{formatCurrency(discountTotal, form.currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-1">
                       <span className="text-[#778B96]">IVA</span>
                       <span className="text-[#28353E] font-medium">{formatCurrency(taxTotal, form.currency)}</span>
                  </div>
                   <div className="flex justify-between py-2 mt-1 border-t border-[#778B96]/25">
                     <span className="text-[#28353E] font-bold">Total</span>
                     <span className="text-[#45567D] font-bold text-base">{formatCurrency(grandTotal, form.currency)}</span>
                  </div>
                </div>
              </div>
              </section>
             </div>
         </form>
       </div>
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
                <Badge value={detail.po.status} map={STATUS_BADGES} />
              </div>
            </div>
            <div className="flex gap-2">
              {(detail.po.status === 'BORRADOR') && (
                <button onClick={() => { editPO(detail.po) }} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5">
                  <Edit className="w-3.5 h-3.5" /> Editar
                </button>
              )}
              <button onClick={handleDownloadPDF} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" /> PDF
              </button>
              {['EMITIDA', 'BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA'].includes(detail.po.status) && (
                <button onClick={() => handleStatusUpdate(detail.po.id, 'CANCELADA')} className="px-4 py-2 rounded-xl border border-red-500/30 text-red-500 hover:bg-red-500/10 text-xs font-semibold transition-colors flex items-center gap-1.5">
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
    <div className="relative flex h-full flex-col overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface shadow-sm">
      <div className="flex flex-1 overflow-hidden">
        <div className={`flex flex-col h-full overflow-hidden transition-all duration-300 ${selectedPo ? "w-full md:w-1/3 lg:w-1/4 border-r border-theme-border" : "w-full"}`}>
      {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}

      <div className="shrink-0 flex flex-col gap-2.5 p-3 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex flex-col md:flex-row items-center gap-2 w-full">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
            <input type="text" value={filters.search ?? ''} onChange={e => setFilters(p => ({ ...p, search: e.target.value || undefined, page: 1 }))}
              placeholder="Buscar por N° OC, proveedor..."
              className="w-full h-9 pl-10 pr-4 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" />
          </div>

          <div className="flex items-center gap-1.5 w-full md:w-auto">
            <button onClick={() => setShowFilters(!showFilters)} className={`h-9 px-2.5 md:px-3 rounded-lg border transition-all flex items-center justify-center gap-1.5 text-sm font-semibold ${showFilters ? 'bg-theme-text/10 border-theme-border text-theme-text' : 'bg-theme-surface border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}>
              <Filter className="w-4 h-4" />
              <span className="hidden md:inline">Filtros</span>
            </button>
            <button type="button" onClick={resetWidths} className="h-9 px-2.5 rounded-lg border border-theme-border bg-theme-surface text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text transition-all">
              Restablecer anchos
            </button>

            <button onClick={() => setView('analysis')} className="h-9 px-3.5 rounded-lg border border-theme-accent/30 text-theme-accent hover:bg-theme-accent/10 text-sm font-semibold transition-all flex items-center justify-center gap-1.5 shadow-sm">
              <BarChart3 className="w-4 h-4" />
              <span className="hidden sm:inline">Realizar Análisis</span>
            </button>
            <button onClick={() => { resetForm(); setView('form') }} className="h-9 px-3.5 md:px-4 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center justify-center gap-1.5 ml-auto md:ml-0">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Crear OC</span>
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="p-3.5 rounded-xl border border-theme-border bg-theme-text/5 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider">Filtros Avanzados</h4>
              <button onClick={() => { setFilters({ page: 1, pageSize: 50 }); setShowFilters(false) }} className="text-xs font-semibold text-theme-text-accent hover:text-theme-text flex items-center gap-1 transition-colors">
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

      {refreshing && <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-20 z-50 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface/95 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted shadow-md">Actualizando...</div>}

      {initialLoading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay órdenes de compra.</p>
        </div>
      ) : (
        <div className="min-w-0 flex-1 overflow-x-auto overflow-y-auto">
          <table className="min-w-[1650px] w-full table-fixed whitespace-nowrap border-collapse text-sm">
            <colgroup>{PURCHASE_ORDER_COLUMNS.map(column => <col key={column.id} style={{ width: widths[column.id] ?? column.defaultWidth }} />)}</colgroup>
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">N° OC{resizeHandle('correlative')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Fecha{resizeHandle('issueDate')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Proveedor{resizeHandle('supplier')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Tipo{resizeHandle('type')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Bodega{resizeHandle('warehouse')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Solicitante{resizeHandle('requester')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Autoriza{resizeHandle('authorized')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Estado{resizeHandle('status')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-right font-medium">Total{resizeHandle('total')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Recepción{resizeHandle('receipt')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-2.5 text-left font-medium">Factura{resizeHandle('invoice')}</th>
                <th className={`sticky right-0 z-20 border-l border-theme-border bg-theme-surface px-4 py-2.5 text-right font-medium ${selectedPo ? "hidden" : ""}`}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.map(po => (
                <tr key={po.id} className={`border-b border-theme-border hover:bg-theme-text/5 transition-colors cursor-pointer ${selectedPo?.id === po.id ? "bg-theme-accent/5 border-l-2 border-l-theme-accent" : ""}`} onClick={() => openDetail(po)} onDoubleClick={event => { if (!shouldIgnoreOperationalRowDoubleClick(event.target)) openDetail(po) }} onMouseEnter={() => prefetchDetail(po.id)}>
                  <td className="px-4 py-2.5 truncate text-xs font-mono font-semibold text-theme-text-accent" title={po.correlative}>{po.correlative}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text" title={formatDate(po.issue_date)}>{formatDate(po.issue_date)}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text" title={po.supplier_name}>{po.supplier_name}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text-muted/60" title={po.po_type}>{po.po_type}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text-muted/60" title={po.warehouse_name || '—'}>{po.warehouse_name || '—'}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text-muted/60" title={po.requester_name}>{po.requester_name}</td>
                  <td className="px-4 py-2.5 truncate text-xs text-theme-text-muted/60" title={po.authorized_name || '—'}>{po.authorized_name || '—'}</td>
                  <td className="px-4 py-2.5 truncate"><Badge value={po.status} map={STATUS_BADGES} /></td>
                  <td className="px-4 py-2.5 truncate text-right text-xs tabular-nums text-theme-text font-medium" title={formatCurrency(po.grand_total, po.currency)}>{formatCurrency(po.grand_total, po.currency)}</td>
                  <td className="px-4 py-2.5 truncate"><Badge value={po.receipt_status} map={RECEIPT_BADGES} /></td>
                  <td className="px-4 py-2.5 truncate"><Badge value={po.invoice_status} map={INVOICE_BADGES} /></td>
                  <td className={`sticky right-0 z-[5] border-l border-theme-border bg-theme-surface whitespace-nowrap px-4 py-2.5 text-right ${selectedPo ? "hidden" : ""}`} onClick={e => e.stopPropagation()}>
                    <button onClick={() => openDetail(po)} className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors" title="Ver detalle">
                      <Eye className="w-4 h-4" />
                    </button>
                    {po.status === 'BORRADOR' && (
                      <button onClick={() => editPO(po)} className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors" title="Editar">
                        <Edit className="w-4 h-4" />
                      </button>
                    )}
                    {['EMITIDA', 'BORRADOR', 'PENDIENTE_APROBACION'].includes(po.status) && (
                      <button onClick={() => handleStatusUpdate(po.id, 'CANCELADA')} className="p-1.5 rounded-lg hover:bg-red-500/10 text-theme-text-muted hover:text-red-500 transition-colors" title="Cancelar">
                        <Ban className="w-4 h-4" />
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
            <select value={filters.pageSize} onChange={e => setFilters(p => ({ ...p, pageSize: parseInt(e.target.value) as 25 | 50 | 100 }))} className="h-8 rounded-lg border border-theme-border bg-theme-text/5 px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40">
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
                   <div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-theme-accent">{selectedPo.correlative}</span><Badge value={selectedPo.status} map={STATUS_BADGES} /></div>
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
                     <button onClick={handleDownloadPDF} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> PDF</button>
                   </div>
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
    </div>
  )
}
