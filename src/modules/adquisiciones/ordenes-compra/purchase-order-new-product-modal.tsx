'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  createPurchaseOrderBsaleProduct,
  getPurchaseOrderNewProductContext,
  preflightPurchaseOrderNewProduct,
  type ProductCreationContext,
} from '@/app/actions/adquisiciones/bsale-product-creation'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'
import type { LocalCreatedProduct } from '@/lib/integraciones/bsale-product-creation-core'

export type NewProductLine = PurchaseOrderCatalogProduct & { product_id: string }

interface PurchaseOrderNewProductModalProps {
  poId: string
  open: boolean
  onClose: () => void
  onCreated: (product: LocalCreatedProduct, quantity: number, unitPrice: number) => void
}

function statusMessage(status: string, error: string) {
  if (status === 'BSALE_PRODUCT_TAX_MISMATCH') return 'El producto fue creado en Bsale, pero el impuesto predeterminado no coincide con IVA esperado. Revisa el producto en Bsale antes de continuar.'
  if (status === 'RECONCILIATION_REQUIRED') return 'No se puede determinar con seguridad el estado final en Bsale. No vuelvas a crear el producto manualmente desde este formulario hasta verificar/reintentar.'
  if (status === 'BSALE_VARIANT_EXISTS') return error || 'La variante ya existe en Bsale y requiere revisión.'
  if (status === 'MAPPING_FAILED' || status === 'ERP_PERSIST_FAILED') return `${status === 'MAPPING_FAILED' ? 'No se pudo completar la asociación con el proveedor' : 'No se pudo persistir el producto en MYM'}: ${error}`
  return error || 'No se pudo crear el producto.'
}

export function PurchaseOrderNewProductModal({ poId, open, onClose, onCreated }: PurchaseOrderNewProductModalProps) {
  const [context, setContext] = useState<ProductCreationContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [description, setDescription] = useState('')
  const [productTypeId, setProductTypeId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('0')
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [error, setError] = useState('')
  const [recoveryProductId, setRecoveryProductId] = useState<number | null>(null)

  function reset() {
    setContext(null); setContextError(''); setSku(''); setBarcode(''); setDescription('')
    setProductTypeId(''); setQuantity('1'); setUnitPrice('0'); setError(''); setRecoveryProductId(null)
    setContextLoading(false); setCreatingProduct(false)
  }

  useEffect(() => {
    reset()
  }, [poId])

  useEffect(() => {
    if (!open || context || contextLoading) return
    setContextLoading(true)
    void getPurchaseOrderNewProductContext(poId).then(result => {
      if (result.data) setContext(result.data)
      else setContextError(result.error || 'No se pudo cargar el contexto de creación.')
    }).catch(reason => setContextError(reason instanceof Error ? reason.message : 'No se pudo cargar el contexto de creación.'))
      .finally(() => setContextLoading(false))
  }, [open, poId, context, contextLoading])

  function close() {
    if (creatingProduct) return
    onClose()
  }

  async function submit() {
    if (creatingProduct || !context) return
    const cleanSku = sku.trim()
    const cleanDescription = description.trim()
    const parsedType = Number(productTypeId)
    const parsedQuantity = Number(quantity)
    const parsedPrice = Number(unitPrice)
    if (!cleanSku) return setError('El SKU es obligatorio.')
    if (!cleanDescription) return setError('La descripción es obligatoria.')
    if (!Number.isInteger(parsedType) || parsedType <= 0) return setError('Selecciona un tipo de producto Bsale.')
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) return setError('La cantidad debe ser mayor que cero.')
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) return setError('El precio de compra no puede ser negativo.')
    setCreatingProduct(true); setError('')
    try {
      const preflight = await preflightPurchaseOrderNewProduct(poId, { sku: cleanSku, barcode: barcode.trim() || null, bsale_product_type_id: parsedType })
      if (!preflight.can_create) { setError(preflight.blocking_reason || preflight.error || 'El preflight bloqueó la creación.'); return }
      const result = await createPurchaseOrderBsaleProduct(poId, {
        sku: cleanSku, barcode: barcode.trim() || null, description: cleanDescription,
        bsale_product_type_id: parsedType, bsale_product_id: recoveryProductId,
      })
      if (result.success === true && result.status === 'CREATED' && result.product) {
        onCreated(result.product, parsedQuantity, parsedPrice)
        return
      }
      if (result.success === true) {
        setError('La creación no devolvió un estado utilizable. Revisa Bsale antes de continuar.')
        return
      }
      if ('bsale_product_id' in result && result.bsale_product_id) setRecoveryProductId(result.bsale_product_id)
      if ('product' in result && result.product) setRecoveryProductId(result.product.bsale_product_id)
      setError(statusMessage(result.status, result.error))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo completar la creación.')
    } finally {
      setCreatingProduct(false)
    }
  }

  if (!open) return null
  const typeCounts = new Map<string, number>()
  for (const type of context?.product_types ?? []) typeCounts.set(type.name, (typeCounts.get(type.name) ?? 0) + 1)
  const brandText = context?.brand.status === 'NONE' ? 'Sin vínculo configurado' : context?.brand.status === 'MULTIPLE' ? 'Múltiples Brands vinculadas' : `Brand #${context?.brand.expected_bsale_brand_id}`

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3" role="dialog" aria-modal="true" aria-labelledby="new-product-title">
    <div className="w-full max-w-3xl rounded-lg border border-[#D1C7BD] bg-[#EFE9E1] p-4 text-[#322D29] shadow-xl">
      <div className="mb-3 flex items-center justify-between border-b border-[#D1C7BD] pb-3"><h2 id="new-product-title" className="text-sm font-bold">Crear producto nuevo</h2><button type="button" onClick={close} disabled={creatingProduct} aria-label="Cerrar" className="rounded p-1 hover:bg-[#D1C7BD]/50 disabled:opacity-40"><X className="h-4 w-4" /></button></div>
      {contextLoading && <div className="flex items-center gap-2 py-8 text-xs text-[#6D625B]"><Loader2 className="h-4 w-4 animate-spin" /> Cargando datos Bsale...</div>}
      {contextError && <div className="border border-[#72383D]/30 bg-[#F5EDEE] p-3 text-xs text-[#72383D]">{contextError}</div>}
      {context && <>
        <div className="grid grid-cols-2 gap-3 rounded-md border border-[#D1C7BD] bg-white/60 p-3 text-xs"><div><p className="text-[10px] uppercase text-[#AC9C8D]">Proveedor</p><p className="font-semibold">{context.supplier.business_name}</p></div><div><p className="text-[10px] uppercase text-[#AC9C8D]">RUT</p><p className="font-semibold">{context.supplier.rut || '—'}</p></div><div className="col-span-2"><p className="text-[10px] uppercase text-[#AC9C8D]">Marca Bsale</p><p>{brandText} <span className="text-[#72383D]">· Asignación manual pendiente</span></p></div></div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4"><label className="md:col-span-1">SKU<input value={sku} onChange={e => setSku(e.target.value)} disabled={creatingProduct} className={inputClass} required /></label><label>Código de barras<input type="text" value={barcode} onChange={e => setBarcode(e.target.value)} disabled={creatingProduct} className={inputClass} /></label><label className="md:col-span-2">Nombre / descripción<input value={description} onChange={e => setDescription(e.target.value)} disabled={creatingProduct} className={inputClass} required /></label><label className="md:col-span-2">Tipo de producto Bsale<select value={productTypeId} onChange={e => setProductTypeId(e.target.value)} disabled={creatingProduct} className={inputClass} required><option value="">Seleccionar...</option>{context.product_types.map(type => <option key={type.id} value={type.id}>{type.name}{(typeCounts.get(type.name) ?? 0) > 1 ? ` · ID ${type.id}` : ''}</option>)}</select></label><label>Cantidad OC<input type="number" min="0.01" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={creatingProduct} className={inputClass} required /></label><label>Precio compra<input type="number" min="0" step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} disabled={creatingProduct} className={inputClass} required /></label></div>
        <p className="mt-2 text-[11px] text-[#6D625B]">IVA esperado: {context.defaults.tax_rate}% · La Brand se asignará manualmente.</p>
        {recoveryProductId && <p className="mt-2 border border-[#AC9C8D]/50 bg-white/50 p-2 text-xs text-[#72383D]">Producto Bsale #{recoveryProductId} creado parcialmente. El reintento continuará sobre el mismo producto.</p>}
        {error && <p className="mt-3 border border-[#72383D]/30 bg-[#F5EDEE] p-2 text-xs text-[#72383D]">{error}{recoveryProductId && <span className="ml-1">Producto ID Bsale: {recoveryProductId}</span>}</p>}
        <div className="mt-4 flex justify-end gap-2 border-t border-[#D1C7BD] pt-3"><button type="button" onClick={close} disabled={creatingProduct} className="rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-[#6D625B] disabled:opacity-40">Cancelar</button><button type="button" onClick={() => void submit()} disabled={creatingProduct} className="rounded-md bg-[#72383D] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{creatingProduct ? 'Creando en Bsale...' : 'Crear y agregar a la OC'}</button></div>
      </>}
    </div>
  </div>
}

const inputClass = 'mt-1 h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15'
