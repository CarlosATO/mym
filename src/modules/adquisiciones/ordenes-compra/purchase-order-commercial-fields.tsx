'use client'

import { validatePriceDecimal } from '@/lib/adquisiciones/purchase-order-decimal'

type CommercialFieldProps = {
  description: string
  unit?: string | null
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}

export function PurchaseCommercialPresentation({ unit, factor }: { unit?: string | null; factor?: number }) {
  if (factor === undefined) return <div className="flex h-8 items-center justify-center">—</div>
  return <div className="text-xs"><div className="flex h-8 items-center justify-center">{unit || <span className="text-orange-600">Pendiente</span>}</div><span className="text-[10px] text-[#6D625B]">{unit ? `${unit} de ${factor} unidades` : `Factor ${factor}`}</span></div>
}

export function PurchaseCommercialQuantity({ description, unit, value, disabled, onChange }: CommercialFieldProps) {
  return <label className="flex flex-col text-[10px] text-[#6D625B]"><span className="order-2">Total {unit || 'unidad'}</span><input aria-label={`Cantidad comercial ${description}`} disabled={disabled} type="number" min="0" step="any" value={value} onChange={event => onChange(event.target.value)} className="block h-8 w-full rounded-md border border-[#D1C7BD] px-1 text-right text-xs" /></label>
}

export function PurchaseCommercialPrice({ description, unit, value, disabled, onChange }: CommercialFieldProps) {
  const valid = validatePriceDecimal(value, 4).isValid
  return <label className="flex flex-col text-[10px] text-[#6D625B]"><span className="order-2">Precio {unit || 'unidad'}</span><input aria-label={`Precio comercial ${description}`} aria-invalid={!valid} disabled={disabled} type="text" inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} className="block h-8 w-full rounded-md border border-[#D1C7BD] px-1 text-right text-xs" />{!valid && <span className="order-3 text-red-600">Precio comercial inválido</span>}</label>
}
