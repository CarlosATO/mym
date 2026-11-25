export type PurchaseOrderLineEconomics = {
  quantity: number
  unitPrice: number
  discountPercent?: number | null
  discountUnitAmount?: number | null
  discountAmount?: number | null
  taxRate?: number | null
}

export type ReceiptEconomics = {
  netAmount: number
  taxAmount: number
  grossAmount: number
  netUnitCost: number
}

export type ConfirmedCommercialEconomics = {
  snapshotId: string
  quantity: number
  commercialGrossAmount: number
  discountAmount: number
  taxAmount: number
  lineTotal: number
  discountPercent?: number | null
  discountUnitAmount?: number | null
  taxRate?: number | null
}

export type CommercialSliceEconomics = {
  cumulativeBefore: number
  cumulativeAfter: number
  grossBeforeDiscount: number
  discountAmount: number
  netAmount: number
  taxAmount: number
  grossAmount: number
  netUnitCost: number
}

export type WorksheetSplitInput = {
  id: string
  quantity: number
  condition: 'CONFORME' | 'DANADO' | 'RECHAZADO' | 'FALTANTE'
}

const ACCEPTED_RECEIPT_CONDITIONS = new Set(['CONFORME', 'DANADO'])
const BI_ZERO = BigInt(0)
const BI_ONE = BigInt(1)
const BI_TWO = BigInt(2)
const BI_TEN = BigInt(10)
const BI_HUNDRED = BigInt(100)

function pow10BigInt(exp: number): bigint {
  let result = BI_ONE
  for (let i = 0; i < exp; i += 1) {
    result = result * BI_TEN
  }
  return result
}

function decimalToScaledBigInt(value: number | string): { num: bigint; scale: bigint } {
  const raw = typeof value === 'number'
    ? (Number.isFinite(value) ? (Math.abs(value) < 1e-6 && value !== 0 ? value.toFixed(12) : String(value)) : '0')
    : String(value ?? '0').trim()
  if (!raw || raw === '0' || raw === '-0') return { num: BI_ZERO, scale: BI_ONE }

  if (/e/i.test(raw)) {
    const asFixed = Number(raw).toFixed(12)
    return decimalToScaledBigInt(asFixed)
  }

  const negative = raw.startsWith('-')
  const unsigned = raw.replace(/^[+-]/, '')
  const [intPart = '0', fracPart = ''] = unsigned.split('.')
  const cleanInt = intPart.replace(/[^0-9]/g, '') || '0'
  const cleanFrac = fracPart.replace(/[^0-9]/g, '')
  const combined = BigInt(cleanInt + cleanFrac)
  const scale = pow10BigInt(cleanFrac.length)
  return { num: negative ? -combined : combined, scale }
}

function roundRationalToCents(numerator: bigint, denominator: bigint): bigint {
  if (numerator === BI_ZERO || denominator === BI_ZERO) return BI_ZERO
  const sign = (numerator < BI_ZERO) !== (denominator < BI_ZERO) ? -BI_ONE : BI_ONE
  const absNum = numerator < BI_ZERO ? -numerator : numerator
  const absDen = denominator < BI_ZERO ? -denominator : denominator
  const scaled = absNum * BI_HUNDRED
  let quotient = scaled / absDen
  const remainder = scaled % absDen
  if (remainder * BI_TWO >= absDen) {
    quotient = quotient + BI_ONE
  }
  return sign * quotient
}

export function roundCurrencyCents(value: number): number {
  if (!Number.isFinite(value) || value === 0) return 0
  const parsed = decimalToScaledBigInt(value)
  return Number(roundRationalToCents(parsed.num, parsed.scale)) / 100
}

/**
 * Exact replica of SQL `logistica.commercial_receipt_amount(p_total, p_before, p_after, p_quantity)`:
 * `round(p_total * p_after / p_quantity, 2) - round(p_total * p_before / p_quantity, 2)`
 * using exact base-10 rational arithmetic (half away from zero).
 */
export function commercialReceiptAmount(
  total: number,
  before: number,
  after: number,
  quantity: number,
): number {
  if (!Number.isFinite(total) || !Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(quantity)) {
    return 0
  }
  if (quantity <= 0 || after === before || total === 0) return 0
  const t = decimalToScaledBigInt(total)
  const b = decimalToScaledBigInt(before)
  const a = decimalToScaledBigInt(after)
  const q = decimalToScaledBigInt(quantity)
  if (q.num <= BI_ZERO) return 0

  const afterCents = roundRationalToCents(t.num * a.num * q.scale, t.scale * a.scale * q.num)
  const beforeCents = roundRationalToCents(t.num * b.num * q.scale, t.scale * b.scale * q.num)
  return Number(afterCents - beforeCents) / 100
}

export function isCommercialPurchaseOrder(
  po: { commercial_draft_revision?: number | string | null; is_commercial?: boolean | null } | null | undefined,
  items?: Array<{
    purchase_unit_factor_snapshot?: number | string | null
    commercial_unit_price_snapshot?: number | string | null
    is_commercial_item?: boolean | null
  }> | null,
): boolean {
  if (po?.is_commercial === true) return true
  if (Number(po?.commercial_draft_revision || 0) > 0) return true
  if (!Array.isArray(items)) return false
  return items.some(
    item =>
      item?.is_commercial_item === true ||
      item?.purchase_unit_factor_snapshot != null ||
      item?.commercial_unit_price_snapshot != null,
  )
}

export function findWorksheetOverflowItems<
  TItem extends { id: string; quantity_pending?: number | null },
>(
  items: TItem[] | null | undefined,
  itemInputs: Record<string, WorksheetSplitInput[]>,
): TItem[] {
  if (!Array.isArray(items)) return []
  return items.filter(item => {
    const pending = Math.max(0, Number(item.quantity_pending || 0))
    const splits = itemInputs[item.id] || []
    const acceptedSum = splits.reduce(
      (sum, split) => (ACCEPTED_RECEIPT_CONDITIONS.has(split.condition) ? sum + Math.max(0, Number(split.quantity || 0)) : sum),
      0,
    )
    return acceptedSum > pending
  })
}

export function calculateCommercialSliceEconomics(
  confirmed: ConfirmedCommercialEconomics,
  cumulativeBefore: number,
  receivedQuantity: number,
): CommercialSliceEconomics {
  const orderedQty = Math.max(0, Number(confirmed.quantity || 0))
  const before = Math.max(0, Number(cumulativeBefore || 0))
  const received = Math.max(0, Number(receivedQuantity || 0))
  const after = before + received

  if (orderedQty <= 0 || received <= 0) {
    return {
      cumulativeBefore: before,
      cumulativeAfter: before,
      grossBeforeDiscount: 0,
      discountAmount: 0,
      netAmount: 0,
      taxAmount: 0,
      grossAmount: 0,
      netUnitCost: 0,
    }
  }

  const confirmedGross = Number(confirmed.commercialGrossAmount || 0)
  const confirmedDiscount = Number(confirmed.discountAmount || 0)
  const confirmedNet = roundCurrencyCents(confirmedGross - confirmedDiscount)
  const confirmedTax = Number(confirmed.taxAmount || 0)

  const netAmount = commercialReceiptAmount(confirmedNet, before, after, orderedQty)
  const discountAmount = commercialReceiptAmount(confirmedDiscount, before, after, orderedQty)
  const taxAmount = commercialReceiptAmount(confirmedTax, before, after, orderedQty)
  const grossBeforeDiscount = roundCurrencyCents(netAmount + discountAmount)
  const grossAmount = roundCurrencyCents(netAmount + taxAmount)

  return {
    cumulativeBefore: before,
    cumulativeAfter: after,
    grossBeforeDiscount,
    discountAmount,
    netAmount,
    taxAmount,
    grossAmount,
    netUnitCost: received > 0 ? netAmount / received : 0,
  }
}

export function calculateReceiptEconomics(
  line: PurchaseOrderLineEconomics,
  receivedQuantity: number,
): ReceiptEconomics {
  const quantity = Math.max(0, Number(line.quantity || 0))
  const received = Math.max(0, Number(receivedQuantity || 0))
  const unitPrice = Number(line.unitPrice || 0)
  const taxRate = Number(line.taxRate ?? 19)
  const fullBase = quantity * unitPrice
  const persistedDiscount = Number(line.discountAmount || 0)
  const percentageDiscount = fullBase * Number(line.discountPercent || 0) / 100
  const unitDiscount = quantity * Number(line.discountUnitAmount || 0)
  const fullDiscount = persistedDiscount > 0
    ? persistedDiscount
    : percentageDiscount > 0
      ? percentageDiscount
      : unitDiscount
  const base = received * unitPrice
  const discount = quantity > 0 ? fullDiscount * received / quantity : 0
  const netAmount = Math.max(0, base - discount)
  const taxAmount = netAmount * taxRate / 100
  const grossAmount = netAmount + taxAmount

  return {
    netAmount,
    taxAmount,
    grossAmount,
    netUnitCost: received > 0 ? netAmount / received : 0,
  }
}

export type WorksheetLinePreview = {
  acceptedQuantity: number
  grossBeforeDiscount: number
  discountAmount: number
  netAmount: number
  taxAmount: number
  grossAmount: number
  netUnitCost: number
  splitSlices: Array<CommercialSliceEconomics & { splitId: string; condition: WorksheetSplitInput['condition']; quantity: number }>
}

export function calculateWorksheetLinePreview(
  item: {
    id: string
    quantity?: number | null
    quantity_received?: number | null
    accounted_quantity_before?: number | null
    quantity_pending?: number | null
    unit_price?: number | null
    discount_percent?: number | null
    discount_unit_amount?: number | null
    discount_amount?: number | null
    tax_rate?: number | null
    confirmed_commercial_economics?: ConfirmedCommercialEconomics | null
  },
  splits: WorksheetSplitInput[],
  isCommercialOrder: boolean,
): WorksheetLinePreview {
  const pending = Number(item.quantity_pending ?? Math.max(0, Number(item.quantity || 0) - Number(item.accounted_quantity_before ?? item.quantity_received ?? 0)))
  if (pending <= 0) {
    return {
      acceptedQuantity: 0,
      grossBeforeDiscount: 0,
      discountAmount: 0,
      netAmount: 0,
      taxAmount: 0,
      grossAmount: 0,
      netUnitCost: 0,
      splitSlices: [],
    }
  }

  if (isCommercialOrder && item.confirmed_commercial_economics) {
    const initialBefore = Math.max(0, Number(item.accounted_quantity_before ?? item.quantity_received ?? 0))
    let cursor = initialBefore
    let acceptedQuantity = 0
    let grossBeforeDiscount = 0
    let discountAmount = 0
    let netAmount = 0
    let taxAmount = 0
    let grossAmount = 0
    const splitSlices: WorksheetLinePreview['splitSlices'] = []

    for (const split of splits) {
      const qty = Math.max(0, Number(split.quantity || 0))
      const accepted = ACCEPTED_RECEIPT_CONDITIONS.has(split.condition) ? qty : 0
      const slice = calculateCommercialSliceEconomics(item.confirmed_commercial_economics, cursor, accepted)
      cursor = slice.cumulativeAfter
      acceptedQuantity += accepted
      grossBeforeDiscount = roundCurrencyCents(grossBeforeDiscount + slice.grossBeforeDiscount)
      discountAmount = roundCurrencyCents(discountAmount + slice.discountAmount)
      netAmount = roundCurrencyCents(netAmount + slice.netAmount)
      taxAmount = roundCurrencyCents(taxAmount + slice.taxAmount)
      grossAmount = roundCurrencyCents(grossAmount + slice.grossAmount)
      splitSlices.push({
        ...slice,
        splitId: split.id,
        condition: split.condition,
        quantity: qty,
      })
    }

    return {
      acceptedQuantity,
      grossBeforeDiscount,
      discountAmount,
      netAmount,
      taxAmount,
      grossAmount,
      netUnitCost: acceptedQuantity > 0 ? netAmount / acceptedQuantity : 0,
      splitSlices,
    }
  }

  // Traditional PO fallback (exact legacy formula)
  const quantity = Number(item.quantity || 0)
  const unitPrice = Number(item.unit_price || 0)
  let acceptedQuantity = 0
  let grossBeforeDiscount = 0
  let netAmount = 0
  let taxAmount = 0
  const splitSlices: WorksheetLinePreview['splitSlices'] = []
  let cursor = Math.max(0, Number(item.accounted_quantity_before ?? item.quantity_received ?? 0))

  for (const split of splits) {
    const qty = Math.max(0, Number(split.quantity || 0))
    if (ACCEPTED_RECEIPT_CONDITIONS.has(split.condition)) {
      const econ = calculateReceiptEconomics({
        quantity,
        unitPrice,
        discountPercent: item.discount_percent,
        discountUnitAmount: item.discount_unit_amount,
        discountAmount: item.discount_amount,
        taxRate: item.tax_rate,
      }, qty)
      const splitGrossBefore = qty * unitPrice
      const splitDiscount = Math.max(0, splitGrossBefore - econ.netAmount)
      acceptedQuantity += qty
      grossBeforeDiscount += splitGrossBefore
      netAmount += econ.netAmount
      taxAmount += econ.taxAmount
      splitSlices.push({
        splitId: split.id,
        condition: split.condition,
        quantity: qty,
        cumulativeBefore: cursor,
        cumulativeAfter: cursor + qty,
        grossBeforeDiscount: splitGrossBefore,
        discountAmount: splitDiscount,
        netAmount: econ.netAmount,
        taxAmount: econ.taxAmount,
        grossAmount: econ.grossAmount,
        netUnitCost: econ.netUnitCost,
      })
      cursor += qty
    } else {
      splitSlices.push({
        splitId: split.id,
        condition: split.condition,
        quantity: qty,
        cumulativeBefore: cursor,
        cumulativeAfter: cursor,
        grossBeforeDiscount: 0,
        discountAmount: 0,
        netAmount: 0,
        taxAmount: 0,
        grossAmount: 0,
        netUnitCost: 0,
      })
    }
  }

  const discountAmount = Math.max(0, grossBeforeDiscount - netAmount)
  const grossAmount = netAmount + taxAmount
  const referenceUnitNetCost = quantity > 0
    ? calculateReceiptEconomics({
        quantity,
        unitPrice,
        discountPercent: item.discount_percent,
        discountUnitAmount: item.discount_unit_amount,
        discountAmount: item.discount_amount,
        taxRate: item.tax_rate,
      }, 1).netUnitCost
    : 0

  return {
    acceptedQuantity,
    grossBeforeDiscount,
    discountAmount,
    netAmount,
    taxAmount,
    grossAmount,
    netUnitCost: acceptedQuantity > 0 ? netAmount / acceptedQuantity : referenceUnitNetCost,
    splitSlices,
  }
}

export function formatReceiptMoney(value: number | null | undefined, options?: { alwaysShowCents?: boolean }): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = roundCurrencyCents(value)
  const hasCents = Math.abs(rounded - Math.round(rounded)) > 1e-6
  const digits = options?.alwaysShowCents || hasCents ? 2 : 0
  const sign = rounded < 0 ? '-' : ''
  const formatted = Math.abs(rounded).toLocaleString('es-CL', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${sign}$${formatted}`
}

export function formatCommercialPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const rounded2 = Math.round(abs * 100) / 100
  const hasSubCent = Math.abs(abs - rounded2) > 1e-6
  const hasCents = Math.abs(abs - Math.round(abs)) > 1e-6
  const minDigits = hasSubCent ? 4 : hasCents ? 2 : 0
  const maxDigits = hasSubCent ? 4 : 2
  const sign = value < 0 ? '-' : ''
  return `${sign}$${abs.toLocaleString('es-CL', {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
  })}`
}

type RawSnapshotRecord = {
  id: string
  items_snapshot?: unknown
} | null | undefined

/**
 * Permission-safe server projection for commercial and traditional POs in receptions.
 * Ensures pure Bodega users (`!canViewEconomics && !canViewReceiptAmounts`) receive
 * ONLY operational commercial metadata (presentation, factor, confirmed commercial quantity,
 * internal quantities) and ZERO prices, discounts, taxes or economic amounts.
 */
export function projectPurchaseOrderReceiptData<
  TPo extends Record<string, unknown>,
  TItem extends Record<string, unknown> & { id: string },
>(input: {
  po: TPo
  items: TItem[]
  confirmedSnapshot: RawSnapshotRecord
  accountedByItem: Map<string, number>
  canViewEconomics: boolean
  canViewReceiptAmounts: boolean
}) {
  const { po, items, confirmedSnapshot, accountedByItem, canViewEconomics, canViewReceiptAmounts } = input
  const isCommercial = isCommercialPurchaseOrder(
    po as { commercial_draft_revision?: number | null },
    items as Array<{ purchase_unit_factor_snapshot?: number | null; commercial_unit_price_snapshot?: number | null }>,
  )

  const snapshotByItemId = new Map<string, Record<string, unknown>>()
  if (isCommercial && confirmedSnapshot && Array.isArray(confirmedSnapshot.items_snapshot)) {
    for (const rawEntry of confirmedSnapshot.items_snapshot) {
      if (rawEntry && typeof rawEntry === 'object' && typeof (rawEntry as { item_id?: unknown }).item_id === 'string') {
        snapshotByItemId.set((rawEntry as { item_id: string }).item_id, rawEntry as Record<string, unknown>)
      }
    }
  }

  const hasConfirmedSnapshot = !isCommercial || Boolean(confirmedSnapshot?.id && snapshotByItemId.size > 0)

  const projectedItems = items.map(rawItem => {
    const snap = snapshotByItemId.get(rawItem.id)
    const orderedQty = Number((snap?.quantity ?? rawItem.quantity) || 0)
    const rawReceived = Number(rawItem.quantity_received || 0)
    const accountedBefore = accountedByItem.has(rawItem.id) ? accountedByItem.get(rawItem.id)! : rawReceived
    const quantityPending = Math.max(0, orderedQty - accountedBefore)

    const factorRaw = snap?.purchase_unit_factor_snapshot ?? rawItem.purchase_unit_factor_snapshot
    const factor = factorRaw != null && Number(factorRaw) > 0 ? Number(factorRaw) : null
    const unitSnapshotRaw = (snap?.purchase_unit_snapshot ?? rawItem.purchase_unit_snapshot) as string | null | undefined
    const purchaseUnitSnapshot = isCommercial && rawItem.item_type === 'PRODUCT'
      ? (unitSnapshotRaw?.trim() || 'UNIDAD')
      : null
    const commercialQuantity = isCommercial && rawItem.item_type === 'PRODUCT' && factor != null
      ? (snap?.commercial_quantity != null ? Number(snap.commercial_quantity) : orderedQty / factor)
      : null

    // Strip any economic fields first if user lacks permission
    const cleanItem: Record<string, unknown> = { ...rawItem }
    if (!canViewEconomics && !canViewReceiptAmounts) {
      delete cleanItem.unit_price
      delete cleanItem.discount_percent
      delete cleanItem.discount_unit_amount
      delete cleanItem.discount_amount
      delete cleanItem.tax_rate
      delete cleanItem.tax_amount
      delete cleanItem.line_total
      delete cleanItem.commercial_unit_price_snapshot
      delete cleanItem.commercial_gross_amount_snapshot
    } else if (!canViewEconomics && canViewReceiptAmounts) {
      // Receipt-amount summary access never exposes line-level commercial unit price or line_total
      delete cleanItem.commercial_unit_price_snapshot
      delete cleanItem.commercial_gross_amount_snapshot
      delete cleanItem.tax_amount
      delete cleanItem.line_total
      if (isCommercial) {
        delete cleanItem.unit_price
        delete cleanItem.discount_percent
        delete cleanItem.discount_unit_amount
        delete cleanItem.discount_amount
        delete cleanItem.tax_rate
      }
    }

    const confirmedEconomics: ConfirmedCommercialEconomics | null =
      isCommercial && (canViewEconomics || canViewReceiptAmounts) && confirmedSnapshot?.id && snap
        ? {
            snapshotId: confirmedSnapshot.id,
            quantity: orderedQty,
            commercialGrossAmount: Number(snap.commercial_gross_amount_snapshot || 0),
            discountAmount: Number(snap.discount_amount || 0),
            taxAmount: Number(snap.tax_amount || 0),
            lineTotal: Number(snap.line_total || 0),
            ...(canViewEconomics
              ? {
                  discountPercent: snap.discount_percent != null ? Number(snap.discount_percent) : (rawItem.discount_percent != null ? Number(rawItem.discount_percent) : 0),
                  discountUnitAmount: snap.discount_unit_amount != null ? Number(snap.discount_unit_amount) : (rawItem.discount_unit_amount != null ? Number(rawItem.discount_unit_amount) : 0),
                  taxRate: snap.tax_rate != null ? Number(snap.tax_rate) : (rawItem.tax_rate != null ? Number(rawItem.tax_rate) : 19),
                }
              : {}),
          }
        : null

    return {
      ...cleanItem,
      quantity: orderedQty,
      quantity_received: rawReceived,
      accounted_quantity_before: accountedBefore,
      quantity_pending: quantityPending,
      is_commercial_item: isCommercial,
      purchase_unit_snapshot: purchaseUnitSnapshot,
      purchase_unit_factor_snapshot: isCommercial && rawItem.item_type === 'PRODUCT' ? factor : null,
      commercial_quantity: commercialQuantity,
      ...(canViewEconomics && isCommercial && snap
        ? {
            unit_price: snap.unit_price != null ? Number(snap.unit_price) : Number(rawItem.unit_price || 0),
            commercial_unit_price_snapshot:
              snap.commercial_unit_price_snapshot != null
                ? Number(snap.commercial_unit_price_snapshot)
                : (rawItem.commercial_unit_price_snapshot != null ? Number(rawItem.commercial_unit_price_snapshot) : null),
            commercial_gross_amount_snapshot: Number(snap.commercial_gross_amount_snapshot || 0),
            discount_percent: snap.discount_percent != null ? Number(snap.discount_percent) : Number(rawItem.discount_percent || 0),
            discount_unit_amount: snap.discount_unit_amount != null ? Number(snap.discount_unit_amount) : Number(rawItem.discount_unit_amount || 0),
            discount_amount: Number(snap.discount_amount || 0),
            tax_rate: snap.tax_rate != null ? Number(snap.tax_rate) : Number(rawItem.tax_rate ?? 19),
            tax_amount: Number(snap.tax_amount || 0),
            line_total: Number(snap.line_total || 0),
          }
        : {}),
      ...(confirmedEconomics ? { confirmed_commercial_economics: confirmedEconomics } : {}),
    }
  })

  const cleanPo: Record<string, unknown> = { ...po }
  if (!canViewEconomics) {
    delete cleanPo.net_total
    delete cleanPo.discount_total
    delete cleanPo.tax_total
    delete cleanPo.exempt_total
    delete cleanPo.grand_total
  }

  return {
    po: {
      ...(cleanPo as TPo),
      is_commercial: isCommercial,
      confirmed_snapshot_available: hasConfirmedSnapshot,
    },
    items: projectedItems as Array<TItem & (typeof projectedItems)[number]>,
  }
}
