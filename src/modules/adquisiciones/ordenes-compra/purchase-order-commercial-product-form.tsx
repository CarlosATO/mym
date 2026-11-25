'use client'

import { useEffect, useRef, useState } from 'react'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'
import { convertPurchaseDecimal, isPurchaseMultiple } from '@/lib/adquisiciones/purchase-commercial-decimal'
import { calculateCommercialDraftLineTotals } from '@/lib/adquisiciones/purchase-commercial-totals'
import { validatePriceDecimal } from '@/lib/adquisiciones/purchase-order-decimal'
import { getPurchaseOrderDiscountDisplayValues, getPurchaseOrderDiscountPayload, type PurchaseOrderDiscountMode } from '@/lib/adquisiciones/purchase-order-discounts'

export type CommercialProductConfiguration = { unit: string | null; factor: number; mappingId: string | null }
export type CommercialProductAddition = {
  quantity: number; unitPrice: number; internalPrice: string; commercialQuantity: string; commercialPrice: string
  discountPercent: number; discountUnitAmount: number; discountMode: PurchaseOrderDiscountMode
  configuration: CommercialProductConfiguration
}

function converted(value: string, factor: number, direction: 'multiply' | 'divide', internal = false) {
  const exact = convertPurchaseDecimal(value, factor, direction, internal)
  if (exact.ok) return exact.value
  const n = Number(value.replace(',', '.'))
  if (!value.trim() || !Number.isFinite(n) || n < 0 || direction === 'multiply') return ''
  return String(Number((n / factor).toFixed(4)))
}

export function PurchaseOrderCommercialProductForm({ product, configuration, loading = false, configurationError = '', showDiscounts, currency, onAdd, onCancel }: {
  product: PurchaseOrderCatalogProduct; configuration: CommercialProductConfiguration | null; loading?: boolean; configurationError?: string
  showDiscounts: boolean; currency: string; onAdd: (value: CommercialProductAddition) => void; onCancel?: () => void
}) {
  const [quantity, setQuantity] = useState('')
  const [commercialQuantity, setCommercialQuantity] = useState('')
  const [price, setPrice] = useState(product.last_purchase_unit_cost === null ? '' : String(product.last_purchase_unit_cost))
  const [commercialPrice, setCommercialPrice] = useState('')
  const [percent, setPercent] = useState(0)
  const [fixed, setFixed] = useState(0)
  const [fixedRaw, setFixedRaw] = useState<string | null>(null)
  const [mode, setMode] = useState<PurchaseOrderDiscountMode>(null)
  const [error, setError] = useState('')
  const quantityRef = useRef<HTMLInputElement>(null)
  const priceRef = useRef<HTMLInputElement>(null)
  const percentRef = useRef<HTMLInputElement>(null)
  useEffect(() => { quantityRef.current?.focus() }, [product.id])
  useEffect(() => {
    if (configuration && product.last_purchase_unit_cost !== null) setCommercialPrice(converted(String(product.last_purchase_unit_cost), configuration.factor, 'multiply'))
  }, [configuration?.factor, product.last_purchase_unit_cost])
  const priceValidation = validatePriceDecimal(price, 4)
  const fixedValidation = fixedRaw !== null ? validatePriceDecimal(fixedRaw, 2) : null
  const priceValue = Number(commercialPrice.replace(',', '.')) / (configuration?.factor ?? 1)
  const display = getPurchaseOrderDiscountDisplayValues({ unit_price: Number.isFinite(priceValue) ? priceValue : 0, discount_percent: percent, discount_unit_amount: fixed, discount_mode: mode })
  const totals = calculateCommercialDraftLineTotals({ quantity: Number(quantity) || 0, unit_price: Number.isFinite(priceValue) ? priceValue : 0, commercial_factor: configuration?.factor, commercial_price_raw: commercialPrice, discount_percent: mode === 'percent' ? percent : 0, discount_unit_amount: mode === 'unit' ? display.discount_unit_amount : 0, tax_rate: product.tax_rate ?? 19 })
  const money = (value: number, code: string) => value.toLocaleString('es-CL', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const input = 'mt-1 block h-8 w-full rounded-md border border-[#D1C7BD] bg-white px-2 text-right text-xs font-mono text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15'
  function submit() {
    if (!configuration || loading || configurationError) { setError(configurationError || 'Espere la resolución comercial del producto.'); return }
    if (!isPurchaseMultiple(quantity, configuration.factor)) { setError(`Debe ser múltiplo de ${configuration.factor}`); return }
    if (!priceValidation.isValid || !validatePriceDecimal(commercialPrice, 4).isValid || !/^\d+(?:[.,]\d{0,4})?$/.test(commercialPrice)) { setError('Ingresa un precio válido de hasta 4 decimales.'); return }
    if (mode === 'unit' && fixedValidation && !fixedValidation.isValid) { setError('Ingresa un descuento unitario válido de hasta 2 decimales.'); return }
    const discounts = getPurchaseOrderDiscountPayload({ unit_price: priceValue, discount_percent: percent, discount_unit_amount: fixed, discount_mode: mode })
    onAdd({ quantity: Number(quantity), unitPrice: priceValue, internalPrice: price, commercialQuantity, commercialPrice: commercialPrice.replace(',', '.'), discountPercent: discounts.discount_percent, discountUnitAmount: discounts.discount_unit_amount, discountMode: mode, configuration })
  }
  return <div className="mb-3 min-w-0 overflow-x-auto rounded-xl border border-[#72383D]/30 bg-white p-3.5 shadow-sm border-l-4 border-l-[#72383D]">
    <div className="flex min-w-0 flex-wrap items-end gap-x-2 gap-y-3 lg:min-w-[1050px] lg:flex-nowrap">
      <div className="w-full min-w-0 lg:min-w-[200px] lg:flex-1"><div className="flex items-center gap-1.5"><span className="rounded bg-[#72383D]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#72383D]">Producto</span><span className="font-mono text-[10px] font-semibold text-[#72383D]">SKU {product.sku}</span></div><p className="mt-1 line-clamp-2 text-xs font-bold text-[#322D29]" title={product.description}>{product.description}</p><p className="mt-0.5 text-[10px] text-[#6D625B]">Último costo Bsale: <span className="font-mono font-medium text-[#322D29]">{product.last_purchase_unit_cost === null ? 'Sin precio disponible' : money(product.last_purchase_unit_cost, 'CLP')}</span></p>{loading && <p className="text-[10px] text-[#6D625B]">Consultando presentación...</p>}{configurationError && <p className="text-[10px] text-red-700">{configurationError}</p>}{configuration && (configuration.unit ? <p className="text-[10px] font-semibold text-blue-700">Se compra por {configuration.unit} de {configuration.factor} unidades</p> : <p className="text-[10px] font-semibold text-orange-600">Presentación de compra pendiente de configurar</p>)}{error && <p role="alert" className="text-[10px] text-red-700">{error}</p>}</div>
      <label className="relative w-[68px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Cantidad<input ref={quantityRef} type="number" min="0.001" step="0.001" value={quantity} onChange={e => { setQuantity(e.target.value); if (configuration) setCommercialQuantity(converted(e.target.value, configuration.factor, 'divide')) }} onFocus={e => e.currentTarget.select()} onClick={e => e.currentTarget.select()} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); priceRef.current?.focus(); priceRef.current?.select() } }} placeholder="0" className={input} />{configuration && quantity && Number(quantity) > 0 && !isPurchaseMultiple(quantity, configuration.factor) && <span className="block text-[10px] text-red-600">Debe ser múltiplo de {configuration.factor}</span>}</label>
      {configuration && <label className="w-[78px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Total {configuration.unit || 'unidad'}<input aria-label="Cantidad comercial" type="number" min="0" step="any" value={commercialQuantity} onChange={e => { setCommercialQuantity(e.target.value); setQuantity(converted(e.target.value, configuration.factor, 'multiply', true)) }} className={input} /></label>}
      <label className="relative w-[86px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Precio unitario<input ref={priceRef} type="text" inputMode="decimal" value={price} onChange={e => { setPrice(e.target.value); if (configuration) setCommercialPrice(converted(e.target.value, configuration.factor, 'multiply')) }} onFocus={e => e.currentTarget.select()} onClick={e => e.currentTarget.select()} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (showDiscounts) { percentRef.current?.focus(); percentRef.current?.select() } else submit() } }} placeholder="0,00" className={input} />{!priceValidation.isValid && !priceValidation.isEmpty && <span className="block text-[10px] text-red-600">Precio inválido</span>}</label>
      {configuration && <label className="relative w-[88px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Precio {configuration.unit || 'unidad'}<input aria-label="Precio comercial" type="text" inputMode="decimal" value={commercialPrice} onChange={e => { setCommercialPrice(e.target.value); setPrice(converted(e.target.value, configuration.factor, 'divide')) }} className={input} />{commercialPrice && !convertPurchaseDecimal(commercialPrice, configuration.factor, 'divide', true).ok && <span className="block whitespace-normal text-[10px] text-amber-700">Precio unitario aproximado; precio comercial exacto.</span>}</label>}
      {showDiscounts && <><label className="w-[58px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Dcto %<input ref={percentRef} type="number" min="0" max="100" step="0.01" value={display.discount_percent || ''} onChange={e => { const n = Math.min(Math.max(Number(e.target.value) || 0, 0), 100); setPercent(n); setFixed(0); setFixedRaw(null); setMode(n > 0 ? 'percent' : null) }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="0" className={input} /></label><label className="relative w-[86px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Dcto por unidad<input type="text" inputMode="decimal" value={fixedRaw ?? (display.discount_unit_amount || '')} onChange={e => { const raw = e.target.value; setFixedRaw(raw); const parsed = validatePriceDecimal(raw, 2); if (parsed.isValid && parsed.value !== null) { const n = Math.min(parsed.value, Math.max(priceValue, 0)); setFixed(n); setPercent(0); setMode(n > 0 ? 'unit' : null) } else if (parsed.isEmpty) { setFixed(0); setPercent(0); setMode(null) } }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} placeholder="0,00" className={input} />{fixedValidation?.error === 'EXCEEDS_MAX_DECIMALS' && <span className="block text-[10px] text-amber-600">Máx. 2 decimales</span>}</label></>}
      <div className="w-[45px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">IVA<div className="mt-1 flex h-8 items-center justify-end rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2 text-xs font-mono text-[#6D625B]">{product.tax_rate ?? 19}%</div></div>
      <div className="w-[108px] shrink-0 whitespace-nowrap text-[10px] font-semibold text-[#6D625B]">Neto<div className="mt-1 flex h-8 items-center justify-end rounded-md border border-[#72383D]/25 bg-[#FAF7F4] px-2 font-mono text-xs font-bold text-[#72383D]">{money(totals.net_amount, currency)}</div></div>
      <button type="button" disabled={loading || Boolean(configurationError)} onClick={submit} className="h-8 shrink-0 whitespace-nowrap rounded-md border border-[#72383D]/40 bg-[#EFE9E1] px-2.5 text-[11px] font-bold text-[#72383D] hover:bg-[#F5EDEE] disabled:opacity-50">Agregar producto</button>
      {onCancel && <button type="button" onClick={onCancel} className="h-8 shrink-0 rounded-md border border-[#D1C7BD] px-2.5 text-[11px] font-bold text-[#6D625B]">Cancelar</button>}
    </div>
  </div>
}
