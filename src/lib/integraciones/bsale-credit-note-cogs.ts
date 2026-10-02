import type { SupabaseClient } from '@supabase/supabase-js'

export const CREDIT_NOTE_COGS_RESOLUTION_STATUSES = [
  'RESOLVED_PHYSICAL_RETURN',
  'RESOLVED_PRICE_ADJUSTMENT',
  'RESOLVED_NO_STOCK_REENTRY',
  'RESOLVED_MIXED',
  'MISSING_RETURN',
  'MISSING_REFERENCE',
  'AMBIGUOUS',
] as const

export const CREDIT_NOTE_COGS_DETAIL_STATUSES = [
  'RESOLVED_PHYSICAL_RETURN',
  'RESOLVED_PRICE_ADJUSTMENT',
  'RESOLVED_NO_STOCK_REENTRY',
  'AMBIGUOUS',
] as const

export type CreditNoteCogsResolutionStatus = typeof CREDIT_NOTE_COGS_RESOLUTION_STATUSES[number]
export type CreditNoteCogsDetailStatus = typeof CREDIT_NOTE_COGS_DETAIL_STATUSES[number]

export interface CreditNoteReturnInput {
  bsale_credit_note_id: number
  bsale_return_id: number
  referenced_document_id: number | null
  price_adjustment: boolean | null
  raw_json?: Record<string, unknown>
}

export interface CreditNoteReturnDetailInput {
  bsale_return_id: number
  bsale_return_detail_id: number
  bsale_document_detail_id: number | null
  quantity: string | number | null
  quantity_dev_stock: string | number | null
  variant_cost: string | number | null
  raw_json?: Record<string, unknown>
}

export interface CreditNoteCogsResolutionDetail {
  bsale_credit_note_id: number
  bsale_return_id: number
  bsale_return_detail_id: number
  bsale_document_detail_id: number | null
  quantity: string | null
  quantity_dev_stock: string | null
  variant_cost: string | null
  reversal_cogs: string
  semantic_status: CreditNoteCogsDetailStatus
  evidence: Record<string, unknown>
}

export interface CreditNoteCogsResolution {
  bsale_credit_note_id: number
  bsale_return_id: number | null
  bsale_reference_document_id: number | null
  resolution_status: CreditNoteCogsResolutionStatus
  reversal_cogs: string
  evidence: Record<string, unknown>
  details: CreditNoteCogsResolutionDetail[]
}

interface DecimalValue {
  integer: bigint
  scale: number
}

function decimal(value: string | number | null): DecimalValue | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

function decimalText(value: DecimalValue): string {
  const raw = value.integer.toString().padStart(value.scale + 1, '0')
  if (!value.scale) return raw
  return `${raw.slice(0, -value.scale)}.${raw.slice(-value.scale)}`.replace(/\.?0+$/, '') || '0'
}

function decimalAdd(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale)
  return {
    integer: left.integer * BigInt(10) ** BigInt(scale - left.scale) + right.integer * BigInt(10) ** BigInt(scale - right.scale),
    scale,
  }
}

function decimalMultiply(left: DecimalValue, right: DecimalValue): DecimalValue {
  return { integer: left.integer * right.integer, scale: left.scale + right.scale }
}

function decimalRound(value: DecimalValue, targetScale: number): DecimalValue {
  if (value.scale <= targetScale) {
    return { integer: value.integer * BigInt(10) ** BigInt(targetScale - value.scale), scale: targetScale }
  }
  const divisor = BigInt(10) ** BigInt(value.scale - targetScale)
  let integer = value.integer / divisor
  const remainder = value.integer % divisor
  if (remainder * BigInt(2) >= divisor) integer += BigInt(1)
  return { integer, scale: targetScale }
}

function isPositive(value: DecimalValue | null) {
  return value !== null && value.integer > BigInt(0)
}

function isZero(value: DecimalValue | null) {
  return value !== null && value.integer === BigInt(0)
}

function positiveInteger(value: number | null) {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function numericText(value: string | number | null, scale?: number) {
  const parsed = decimal(value)
  return parsed ? decimalText(scale === undefined ? parsed : decimalRound(parsed, scale)) : null
}

function detailEvidence(detail: CreditNoteReturnDetailInput, status: CreditNoteCogsDetailStatus, reason: string) {
  return {
    reason,
    quantity_dev_stock_used: detail.quantity_dev_stock,
    variant_cost_used: detail.variant_cost,
    variant_stock_used_for_reversal: false,
    nc_total_cost_used_for_reversal: false,
    status,
  }
}

function resolveDetail(
  creditNoteId: number,
  returnInput: CreditNoteReturnInput,
  detail: CreditNoteReturnDetailInput,
  resolvableDocumentDetailIds: Set<number>,
): CreditNoteCogsResolutionDetail {
  const quantity = decimal(detail.quantity)
  const quantityDevStock = decimal(detail.quantity_dev_stock)
  const variantCost = decimal(detail.variant_cost)
  const persistedVariantCost = variantCost ? decimalRound(variantCost, 2) : null
  const documentDetailResolvable = detail.bsale_document_detail_id !== null
    && positiveInteger(detail.bsale_document_detail_id)
    && resolvableDocumentDetailIds.has(detail.bsale_document_detail_id)
  let status: CreditNoteCogsDetailStatus = 'AMBIGUOUS'
  let reversal = '0'
  let reason = 'unresolved'

  if (!quantity || quantity.integer < BigInt(0) || !quantityDevStock || quantityDevStock.integer < BigInt(0)) {
    reason = 'quantity_or_quantity_dev_stock_invalid'
  } else if (quantityDevStock.integer > quantity.integer) {
    reason = 'quantity_dev_stock_exceeds_quantity'
  } else if (!documentDetailResolvable) {
    reason = 'document_detail_not_resolvable'
  } else if (returnInput.price_adjustment === true && isZero(quantityDevStock)) {
    status = 'RESOLVED_PRICE_ADJUSTMENT'
    reason = 'price_adjustment_without_stock_reentry'
  } else if (returnInput.price_adjustment === false && isPositive(quantity) && isZero(quantityDevStock)) {
    status = 'RESOLVED_NO_STOCK_REENTRY'
    reason = 'return_without_stock_reentry'
  } else if (quantityDevStock && persistedVariantCost && isPositive(quantityDevStock) && isPositive(persistedVariantCost)) {
    status = 'RESOLVED_PHYSICAL_RETURN'
    reversal = decimalText(decimalMultiply(quantityDevStock, persistedVariantCost))
    reason = 'positive_quantity_dev_stock_and_variant_cost'
  } else if (quantityDevStock && isPositive(quantityDevStock) && !variantCost) {
    reason = 'physical_quantity_without_variant_cost'
  } else if (returnInput.price_adjustment === true || returnInput.price_adjustment === false) {
    reason = 'return_fields_contradictory'
  } else {
    reason = 'price_adjustment_missing_for_zero_stock_quantity'
  }

  return {
    bsale_credit_note_id: creditNoteId,
    bsale_return_id: returnInput.bsale_return_id,
    bsale_return_detail_id: detail.bsale_return_detail_id,
    bsale_document_detail_id: detail.bsale_document_detail_id,
    quantity: numericText(detail.quantity),
    quantity_dev_stock: numericText(detail.quantity_dev_stock),
    variant_cost: numericText(detail.variant_cost, 2),
    reversal_cogs: reversal,
    semantic_status: status,
    evidence: detailEvidence(detail, status, reason),
  }
}

export function resolveCreditNoteCogs(options: {
  creditNoteId: number
  returns: CreditNoteReturnInput[]
  detailsByReturnId: Map<number, CreditNoteReturnDetailInput[]>
  resolvableDocumentDetailIds: Set<number>
}): CreditNoteCogsResolution {
  const { creditNoteId, returns, detailsByReturnId, resolvableDocumentDetailIds } = options
  if (!returns.length) {
    return {
      bsale_credit_note_id: creditNoteId,
      bsale_return_id: null,
      bsale_reference_document_id: null,
      resolution_status: 'MISSING_RETURN',
      reversal_cogs: '0',
      evidence: { reason: 'no_return_found', returns_count: 0 },
      details: [],
    }
  }

  if (returns.length !== 1) {
    const details = returns.flatMap(returnInput => (detailsByReturnId.get(returnInput.bsale_return_id) || []).map(detail => resolveDetail(creditNoteId, returnInput, detail, resolvableDocumentDetailIds)))
    return {
      bsale_credit_note_id: creditNoteId,
      bsale_return_id: null,
      bsale_reference_document_id: null,
      resolution_status: 'AMBIGUOUS',
      reversal_cogs: '0',
      evidence: { reason: 'multiple_returns_for_credit_note', returns_count: returns.length },
      details: details.map(detail => ({ ...detail, reversal_cogs: '0', semantic_status: 'AMBIGUOUS', evidence: { ...detail.evidence, reason: 'multiple_returns_for_credit_note' } })),
    }
  }

  const returnInput = returns[0]
  const details = (detailsByReturnId.get(returnInput.bsale_return_id) || []).map(detail => resolveDetail(creditNoteId, returnInput, detail, resolvableDocumentDetailIds))
  if (returnInput.referenced_document_id === null) {
    return {
      bsale_credit_note_id: creditNoteId,
      bsale_return_id: returnInput.bsale_return_id,
      bsale_reference_document_id: null,
      resolution_status: 'MISSING_REFERENCE',
      reversal_cogs: '0',
      evidence: { reason: 'return_reference_document_missing', details_count: details.length },
      details: details.map(detail => ({ ...detail, reversal_cogs: '0', semantic_status: 'AMBIGUOUS', evidence: { ...detail.evidence, reason: 'missing_reference_blocks_cogs_resolution' } })),
    }
  }

  if (!details.length || details.some(detail => detail.semantic_status === 'AMBIGUOUS')) {
    return {
      bsale_credit_note_id: creditNoteId,
      bsale_return_id: returnInput.bsale_return_id,
      bsale_reference_document_id: returnInput.referenced_document_id,
      resolution_status: 'AMBIGUOUS',
      reversal_cogs: '0',
      evidence: { reason: !details.length ? 'return_has_no_details' : 'one_or_more_details_ambiguous', details_count: details.length },
      details,
    }
  }

  const statuses = new Set(details.map(detail => detail.semantic_status))
  const hasPhysical = statuses.has('RESOLVED_PHYSICAL_RETURN')
  const hasNonPhysical = statuses.has('RESOLVED_PRICE_ADJUSTMENT') || statuses.has('RESOLVED_NO_STOCK_REENTRY')
  const resolutionStatus = hasPhysical && hasNonPhysical
    ? 'RESOLVED_MIXED'
    : hasPhysical ? 'RESOLVED_PHYSICAL_RETURN'
      : statuses.has('RESOLVED_PRICE_ADJUSTMENT') ? 'RESOLVED_PRICE_ADJUSTMENT'
        : 'RESOLVED_NO_STOCK_REENTRY'
  const reversal = details.reduce((sum, detail) => decimalAdd(sum, decimal(detail.reversal_cogs) || { integer: BigInt(0), scale: 0 }), { integer: BigInt(0), scale: 0 })
  return {
    bsale_credit_note_id: creditNoteId,
    bsale_return_id: returnInput.bsale_return_id,
    bsale_reference_document_id: returnInput.referenced_document_id,
    resolution_status: resolutionStatus,
    reversal_cogs: decimalText(reversal),
    evidence: { reason: 'all_details_resolved', details_count: details.length, physical_details: details.filter(detail => detail.semantic_status === 'RESOLVED_PHYSICAL_RETURN').length },
    details,
  }
}

export async function upsertCreditNoteCogsResolution(
  companyId: string,
  resolution: CreditNoteCogsResolution,
  client: SupabaseClient,
  resolvedAt = new Date().toISOString(),
) {
  const { error: documentError } = await client.schema('integraciones').from('bsale_credit_note_cogs_resolutions').upsert({
    company_id: companyId,
    ...resolution,
    details: undefined,
    resolved_at: resolvedAt,
    updated_at: resolvedAt,
  }, { onConflict: 'company_id,bsale_credit_note_id', ignoreDuplicates: false })
  if (documentError) throw new Error(`Error upserting credit note COGS resolution: ${documentError.message}`)

  if (!resolution.details.length) return
  const rows = resolution.details.map(detail => ({
    company_id: companyId,
    ...detail,
    resolved_at: resolvedAt,
    updated_at: resolvedAt,
  }))
  const { error: detailError } = await client.schema('integraciones').from('bsale_credit_note_cogs_resolution_details').upsert(rows, {
    onConflict: 'company_id,bsale_credit_note_id,bsale_return_id,bsale_return_detail_id',
    ignoreDuplicates: false,
  })
  if (detailError) throw new Error(`Error upserting credit note COGS resolution details: ${detailError.message}`)
}
