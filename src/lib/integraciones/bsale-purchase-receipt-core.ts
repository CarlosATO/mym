export type PurchaseReceiptPayload = {
  document: 'FACTURA' | 'GUÍA'
  officeId: number
  documentNumber: number
  note: string
  details: Array<{ quantity: number; variantId: number; cost: number }>
}

export type PurchaseReceiptSnapshot = PurchaseReceiptPayload

const INVALID_PURCHASE_RECEIPT_PAYLOAD = 'La recepción no tiene un payload BSale válido; corrija los datos antes de sincronizar.'

export function purchaseReceiptPayloadError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  const payload = value as Partial<PurchaseReceiptPayload>
  if (payload.document !== 'FACTURA' && payload.document !== 'GUÍA') return INVALID_PURCHASE_RECEIPT_PAYLOAD
  if (!Number.isSafeInteger(payload.officeId) || Number(payload.officeId) <= 0) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  if (!Number.isSafeInteger(payload.documentNumber) || Number(payload.documentNumber) <= 0) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  if (typeof payload.note !== 'string' || !payload.note) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  if (!Array.isArray(payload.details) || payload.details.length === 0) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  if (payload.details.some(line =>
    !line ||
    !Number.isSafeInteger(line.variantId) || line.variantId <= 0 ||
    !Number.isFinite(line.quantity) || line.quantity <= 0 ||
    !Number.isFinite(line.cost) || line.cost < 0
  )) return INVALID_PURCHASE_RECEIPT_PAYLOAD
  return null
}

export function autoSyncIsAllowed(settings: { enabled: boolean; autoSyncEnabled: boolean }) {
  return settings.enabled && settings.autoSyncEnabled
}

export async function syncAfterLocalReceipt<T>(
  settings: { enabled: boolean; autoSyncEnabled: boolean },
  sync: () => Promise<T>,
) {
  if (!autoSyncIsAllowed(settings)) return { status: 'PENDING' as const, result: null }
  return { status: 'SYNCED' as const, result: await sync() }
}

export function chooseUniqueReconciliationCandidate(compatibleIds: number[]) {
  return compatibleIds.length === 1 ? compatibleIds[0] : null
}

export type ReceiptLineCostOrigin =
  | 'POSITIVE_COST'
  | 'LEGITIMATE_BONUS'
  | 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO'
  | 'INVALID'

export type CommercialRoundingValidationContext = {
  confirmedSnapshotId: string
  orderedQuantity: number
  confirmedGrossAmount: number
  confirmedDiscountAmount: number
  confirmedTaxAmount?: number | null
  confirmedLineTotal?: number | null
  commercialUnitPrice?: number | null
  cumulativeQuantityBefore: number
  cumulativeQuantityAfter: number
}

export type AcceptedReceiptLine = {
  itemType: 'PRODUCT' | 'SERVICE'
  condition: 'CONFORME' | 'DANADO' | 'RECHAZADO' | 'FALTANTE'
  variantId?: number | null
  quantity: number
  netAmount: number
  unitPrice?: number | null
  discountPercent?: number | null
  isBonus?: boolean
  controlsStock?: boolean
  commercialRounding?: CommercialRoundingValidationContext | null
}

function roundHalfAwayFromZeroCents(value: number): number {
  const sign = value < 0 ? -1 : 1
  const scaled = Math.abs(value) * 100
  return (sign * Math.floor(scaled + 0.5 + 1e-12)) / 100
}

export function commercialReceiptAmount(total: number, before: number, after: number, quantity: number): number {
  const afterRounded = roundHalfAwayFromZeroCents((total * after) / quantity)
  const beforeRounded = roundHalfAwayFromZeroCents((total * before) / quantity)
  return roundHalfAwayFromZeroCents(afterRounded - beforeRounded)
}

export function isLegitimateBonusLine(line: AcceptedReceiptLine): boolean {
  if (line.isBonus === true) return true
  if (typeof line.unitPrice === 'number' && line.unitPrice > 0 && line.discountPercent === 100) return true
  const cr = line.commercialRounding
  if (
    cr &&
    typeof cr.confirmedSnapshotId === 'string' && cr.confirmedSnapshotId.trim().length > 0 &&
    Number.isFinite(cr.orderedQuantity) && cr.orderedQuantity > 0 &&
    Number.isFinite(cr.confirmedGrossAmount) && cr.confirmedGrossAmount > 0 &&
    Number.isFinite(cr.confirmedDiscountAmount) && cr.confirmedDiscountAmount === cr.confirmedGrossAmount &&
    (cr.commercialUnitPrice == null || cr.commercialUnitPrice > 0)
  ) {
    return true
  }
  return false
}

export function isLegitimateCommercialRoundingZeroLine(line: AcceptedReceiptLine): boolean {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.netAmount !== 0) return false
  if (isLegitimateBonusLine(line)) return false
  const cr = line.commercialRounding
  if (!cr || typeof cr.confirmedSnapshotId !== 'string' || !cr.confirmedSnapshotId.trim()) return false
  if (!Number.isFinite(cr.orderedQuantity) || cr.orderedQuantity <= 0) return false
  if (!Number.isFinite(cr.confirmedGrossAmount) || cr.confirmedGrossAmount <= 0) return false
  if (!Number.isFinite(cr.confirmedDiscountAmount) || cr.confirmedDiscountAmount < 0 || cr.confirmedDiscountAmount >= cr.confirmedGrossAmount) return false
  if (cr.commercialUnitPrice != null && (!Number.isFinite(cr.commercialUnitPrice) || cr.commercialUnitPrice <= 0)) return false
  const confirmedNet = roundHalfAwayFromZeroCents(cr.confirmedGrossAmount - cr.confirmedDiscountAmount)
  if (confirmedNet <= 0) return false
  if (cr.confirmedTaxAmount != null && cr.confirmedLineTotal != null) {
    if (cr.confirmedTaxAmount < 0) return false
    if (Math.abs(cr.confirmedLineTotal - (confirmedNet + cr.confirmedTaxAmount)) > 1e-6) return false
  }
  if (!Number.isFinite(cr.cumulativeQuantityBefore) || cr.cumulativeQuantityBefore < 0) return false
  if (!Number.isFinite(cr.cumulativeQuantityAfter) || Math.abs(cr.cumulativeQuantityAfter - (cr.cumulativeQuantityBefore + line.quantity)) > 1e-9) return false
  if (cr.cumulativeQuantityAfter > cr.orderedQuantity || line.quantity >= cr.orderedQuantity) return false
  return commercialReceiptAmount(confirmedNet, cr.cumulativeQuantityBefore, cr.cumulativeQuantityAfter, cr.orderedQuantity) === 0
}

export function classifyReceiptLineCostOrigin(line: AcceptedReceiptLine): ReceiptLineCostOrigin {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.netAmount) || line.netAmount < 0) {
    return 'INVALID'
  }
  if (line.commercialRounding) {
    const cr = line.commercialRounding
    if (
      typeof cr.confirmedSnapshotId !== 'string' || !cr.confirmedSnapshotId.trim() ||
      !Number.isFinite(cr.orderedQuantity) || cr.orderedQuantity <= 0 ||
      !Number.isFinite(cr.confirmedGrossAmount) || cr.confirmedGrossAmount <= 0 ||
      !Number.isFinite(cr.confirmedDiscountAmount) || cr.confirmedDiscountAmount < 0 || cr.confirmedDiscountAmount > cr.confirmedGrossAmount ||
      (cr.commercialUnitPrice != null && (!Number.isFinite(cr.commercialUnitPrice) || cr.commercialUnitPrice <= 0)) ||
      !Number.isFinite(cr.cumulativeQuantityBefore) || cr.cumulativeQuantityBefore < 0 ||
      !Number.isFinite(cr.cumulativeQuantityAfter) ||
      Math.abs(cr.cumulativeQuantityAfter - (cr.cumulativeQuantityBefore + line.quantity)) > 1e-9 ||
      cr.cumulativeQuantityAfter > cr.orderedQuantity
    ) {
      return 'INVALID'
    }
    const confirmedNet = roundHalfAwayFromZeroCents(cr.confirmedGrossAmount - cr.confirmedDiscountAmount)
    const expectedNet = commercialReceiptAmount(confirmedNet, cr.cumulativeQuantityBefore, cr.cumulativeQuantityAfter, cr.orderedQuantity)
    if (Math.abs(line.netAmount - expectedNet) > 1e-6) {
      return 'INVALID'
    }
    if (line.netAmount > 0) return 'POSITIVE_COST'
    if (confirmedNet === 0) return 'LEGITIMATE_BONUS'
    return line.quantity < cr.orderedQuantity ? 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO' : 'INVALID'
  }
  if (line.netAmount > 0) return 'POSITIVE_COST'
  if (isLegitimateBonusLine(line)) return 'LEGITIMATE_BONUS'
  return 'INVALID'
}

export function requiresExplicitBsaleReconciliation(lines: AcceptedReceiptLine[]): boolean {
  const grouped = new Map<number, { net: number; allBonus: boolean; hasCommercialRoundingZero: boolean }>()
  let serviceNet = 0
  let serviceCount = 0
  let serviceRoundingZero = false
  for (const line of lines) {
    if (!['CONFORME', 'DANADO'].includes(line.condition)) continue
    if (line.controlsStock === false) continue
    const origin = classifyReceiptLineCostOrigin(line)
    if (line.itemType === 'SERVICE') {
      serviceCount += 1
      serviceNet += line.netAmount
      if (origin === 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO') serviceRoundingZero = true
      continue
    }
    if (line.variantId == null) continue
    const current = grouped.get(line.variantId) ?? { net: 0, allBonus: true, hasCommercialRoundingZero: false }
    current.net += line.netAmount
    current.allBonus = current.allBonus && origin === 'LEGITIMATE_BONUS'
    current.hasCommercialRoundingZero = current.hasCommercialRoundingZero || origin === 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO'
    grouped.set(line.variantId, current)
  }
  for (const [, value] of grouped) {
    if (value.net === 0 && !value.allBonus && value.hasCommercialRoundingZero) return true
  }
  if (serviceCount > 0 && serviceNet === 0 && serviceRoundingZero) return true
  return false
}

export function buildPurchaseReceiptPayload(input: { documentType: string; documentNumber: string | number; officeId: number; receiptNumber: string; poCorrelative: string; observation?: string | null; serviceVariantId: number; lines: AcceptedReceiptLine[] }): PurchaseReceiptPayload {
  const grouped = new Map<number, { quantity: number; net: number }>()
  let serviceNet = 0
  let serviceCount = 0
  let serviceRoundingZero = false
  for (const line of input.lines) {
    if (!['CONFORME', 'DANADO'].includes(line.condition)) continue
    if (line.controlsStock === false) continue
    const origin = classifyReceiptLineCostOrigin(line)
    if (line.itemType === 'SERVICE') {
      if (origin === 'INVALID' && line.netAmount < 0) {
        throw new Error('La línea SERVICE requiere cantidad y costo neto válidos.')
      }
      serviceCount += 1
      serviceNet += line.netAmount
      if (origin === 'COMMERCIAL_CUMULATIVE_ROUNDING_ZERO') serviceRoundingZero = true
      continue
    }
    if (line.variantId == null) throw new Error('Una línea PRODUCT no tiene bsale_variant_id.')
    if (origin === 'INVALID') {
      throw new Error('La línea PRODUCT requiere cantidad y costo neto válidos.')
    }
    const current = grouped.get(line.variantId) ?? { quantity: 0, net: 0 }
    current.quantity += line.quantity
    current.net += line.netAmount
    grouped.set(line.variantId, current)
  }
  const details = [...grouped].map(([variantId, value]) => ({
    variantId,
    quantity: value.quantity,
    cost: value.quantity > 0 ? value.net / value.quantity : 0,
  }))
  if (serviceNet > 0) {
    details.push({ variantId: input.serviceVariantId, quantity: 1, cost: serviceNet })
  } else if (serviceCount > 0 && serviceNet === 0 && serviceRoundingZero) {
    details.push({ variantId: input.serviceVariantId, quantity: 1, cost: 0 })
  }
  if (!details.length) throw new Error('La recepción no tiene líneas aceptadas para BSale.')
  return { document: documentForBsale(input.documentType), officeId: input.officeId, documentNumber: numericDocumentNumber(input.documentNumber), note: buildPurchaseReceiptNote(input.receiptNumber, input.poCorrelative, input.observation), details }
}

export type RemoteReceptionHeader = {
  id?: number | string | null
  document?: string | null
  documentNumber?: number | string | null
  note?: string | null
  office?: { id?: number | string | null } | null
}

export type RemoteReceptionDetail = {
  quantity?: number | string | null
  cost?: number | string | null
  variant?: { id?: number | string | null } | null
}

export type RemoteReceptionCandidate = RemoteReceptionHeader & { id: number | string }

export type PurchaseReceiptRemoteDependencies = {
  createReception: (payload: PurchaseReceiptPayload) => Promise<{ id?: number | string | null }>
  getReception: (id: number) => Promise<RemoteReceptionHeader>
  getDetails: (id: number) => Promise<RemoteReceptionDetail[]>
  findReceptions: (documentNumber: number, officeId: number) => Promise<RemoteReceptionCandidate[]>
}

export function buildPurchaseReceiptNote(receiptNumber: string, poCorrelative: string, observation?: string | null) {
  const prefix = `${receiptNumber.trim()} | ${poCorrelative.trim()}`
  if (prefix.length > 100) throw new Error('Los identificadores de la recepción superan 100 caracteres.')
  const free = observation?.trim() ?? ''
  if (!free) return prefix
  const available = 100 - prefix.length - 3
  return `${prefix} | ${Array.from(free).slice(0, Math.max(0, available)).join('')}`
}

export function documentForBsale(document: string) {
  if (document === 'FA') return 'FACTURA' as const
  if (document === 'GD') return 'GUÍA' as const
  throw new Error('El documento debe ser FA o GD.')
}

export function numericDocumentNumber(value: string | number | null | undefined) {
  const raw = String(value ?? '')
  if (!/^[0-9]+$/.test(raw)) throw new Error('Ingrese un solo número de documento, sin puntos, guiones ni espacios.')
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('El número de documento no es válido para BSale.')
  return parsed
}

export function verifyPurchaseReceipt(snapshot: PurchaseReceiptSnapshot, header: RemoteReceptionHeader, details: RemoteReceptionDetail[], id: number) {
  const number = (value: unknown) => Number(value)
  if (number(header.id) !== id || number(header.office?.id) !== snapshot.officeId) return false
  if (header.document && header.document !== snapshot.document) return false
  if (header.documentNumber != null && number(header.documentNumber) !== snapshot.documentNumber) return false
  if (!header.note?.includes(snapshot.note.split(' | ').slice(0, 2).join(' | '))) return false
  const expected = new Map(snapshot.details.map(line => [line.variantId, line]))
  const actual = new Map<number, { quantity: number; total: number }>()
  for (const line of details) {
    const variant = number(line.variant?.id)
    const quantity = number(line.quantity)
    const cost = number(line.cost)
    if (!Number.isFinite(variant) || !Number.isFinite(quantity) || !Number.isFinite(cost)) return false
    const current = actual.get(variant) ?? { quantity: 0, total: 0 }
    current.quantity += quantity
    current.total += quantity * cost
    actual.set(variant, current)
  }
  if (expected.size !== actual.size) return false
  return [...expected].every(([variant, line]) => {
    const received = actual.get(variant)
    return !!received && received.quantity === line.quantity && Math.abs(received.total - line.quantity * line.cost) <= 0.01
  })
}

function failureStatus(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : 0
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'FAILED' as const : 'RECONCILIATION_REQUIRED' as const
}

export async function sendPurchaseReceipt(snapshot: PurchaseReceiptSnapshot, remote: PurchaseReceiptRemoteDependencies) {
  const payloadError = purchaseReceiptPayloadError(snapshot)
  if (payloadError) return { status: 'FAILED' as const, receptionId: null, error: payloadError }
  let created: { id?: number | string | null }
  try { created = await remote.createReception(snapshot) } catch (error) {
    return { status: failureStatus(error), receptionId: null, error: error instanceof Error ? error.message : 'No se pudo crear la recepción BSale.' } as const
  }
  const id = Number(created.id)
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 'RECONCILIATION_REQUIRED' as const, receptionId: null, error: 'BSale no devolvió el ID de la recepción.' }
  try {
    const [header, details] = await Promise.all([remote.getReception(id), remote.getDetails(id)])
    return verifyPurchaseReceipt(snapshot, header, details, id)
      ? { status: 'CONFIRMED' as const, receptionId: id, error: null }
      : { status: 'RECONCILIATION_REQUIRED' as const, receptionId: id, error: 'La recepción BSale no coincide con el snapshot.' }
  } catch (error) {
    return { status: 'RECONCILIATION_REQUIRED' as const, receptionId: id, error: error instanceof Error ? error.message : 'No se pudo verificar BSale.' }
  }
}

export async function reconcilePurchaseReceipt(snapshot: PurchaseReceiptSnapshot, remote: PurchaseReceiptRemoteDependencies, id: number) {
  try {
    const [header, details] = await Promise.all([remote.getReception(id), remote.getDetails(id)])
    return verifyPurchaseReceipt(snapshot, header, details, id)
      ? { status: 'CONFIRMED' as const, receptionId: id, error: null }
      : { status: 'RECONCILIATION_REQUIRED' as const, receptionId: id, error: 'El candidato remoto no coincide con el snapshot.' }
  } catch (error) {
    return { status: 'RECONCILIATION_REQUIRED' as const, receptionId: id, error: error instanceof Error ? error.message : 'No se pudo reconciliar BSale.' }
  }
}

export type StoredBsaleReceiptOperationRow = {
  id: string
  company_id: string
  purchase_receipt_id: string
  status: 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'
  bsale_reception_id: number | string | null
  payload_snapshot: unknown
  error_message: string | null
}

export type ConfirmedBsaleReceiptOperationResult = {
  operation_id: string
  status: 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'
  reception_id: number | null
  error: string | null
  payload: PurchaseReceiptPayload | null
}

export async function reconcileOperationWorkflow(input: {
  companyId: string
  userId: string
  operationId: string
  loadOperation: (operationId: string, companyId: string) => Promise<{ row: StoredBsaleReceiptOperationRow | null; error?: string | null }>
  confirmReconciled: (params: { operationId: string; companyId: string; userId: string; receptionId: number }) => Promise<{ data: ConfirmedBsaleReceiptOperationResult | null; error?: string | null }>
  remote: PurchaseReceiptRemoteDependencies
}) {
  const loaded = await input.loadOperation(input.operationId, input.companyId)
  if (loaded.error || !loaded.row) {
    return { status: 'RECONCILIATION_REQUIRED' as const, operationId: input.operationId, receptionId: null, error: loaded.error ?? 'Operación no encontrada.', payload: null }
  }
  const row = loaded.row
  const existingReceptionId = row.bsale_reception_id != null ? Number(row.bsale_reception_id) : null
  const snapshot = row.payload_snapshot as PurchaseReceiptPayload | null

  if (row.status === 'CONFIRMED') {
    return { status: 'CONFIRMED' as const, operationId: row.id, receptionId: existingReceptionId, error: null, payload: snapshot }
  }
  if (row.status !== 'RECONCILIATION_REQUIRED') {
    return { status: row.status, operationId: row.id, receptionId: existingReceptionId, error: row.error_message ?? 'La operación no se encuentra pendiente de conciliación.', payload: snapshot }
  }

  const payloadError = purchaseReceiptPayloadError(snapshot)
  if (payloadError || !snapshot) {
    return { status: 'RECONCILIATION_REQUIRED' as const, operationId: row.id, receptionId: existingReceptionId, error: payloadError ?? 'Payload BSale inválido.', payload: null }
  }

  let result: { status: 'CONFIRMED' | 'RECONCILIATION_REQUIRED'; receptionId: number | null; error: string | null }
  if (existingReceptionId != null) {
    result = await reconcilePurchaseReceipt(snapshot, input.remote, existingReceptionId)
  } else {
    try {
      const candidates = await input.remote.findReceptions(snapshot.documentNumber, snapshot.officeId)
      const compatible: number[] = []
      for (const candidate of candidates) {
        const id = Number(candidate.id)
        if (!Number.isSafeInteger(id) || id <= 0) continue
        const checked = await reconcilePurchaseReceipt(snapshot, input.remote, id)
        if (checked.status === 'CONFIRMED') compatible.push(id)
      }
      const uniqueCandidate = chooseUniqueReconciliationCandidate(compatible)
      result = uniqueCandidate !== null
        ? { status: 'CONFIRMED' as const, receptionId: uniqueCandidate, error: null }
        : {
            status: 'RECONCILIATION_REQUIRED' as const,
            receptionId: null,
            error: compatible.length > 1
              ? 'Existen múltiples candidatos BSale compatibles.'
              : (row.error_message || 'No existe un candidato BSale compatible; se requiere reintento explícito.'),
          }
    } catch (error) {
      result = {
        status: 'RECONCILIATION_REQUIRED' as const,
        receptionId: null,
        error: error instanceof Error ? error.message : 'No se pudo reconciliar BSale.',
      }
    }
  }

  if (result.status !== 'CONFIRMED' || result.receptionId == null || !Number.isSafeInteger(result.receptionId) || result.receptionId <= 0) {
    return { status: 'RECONCILIATION_REQUIRED' as const, operationId: row.id, receptionId: result.receptionId, error: result.error, payload: snapshot }
  }

  const confirmed = await input.confirmReconciled({
    operationId: row.id,
    companyId: input.companyId,
    userId: input.userId,
    receptionId: result.receptionId,
  })
  if (confirmed.error || !confirmed.data) {
    return {
      status: 'RECONCILIATION_REQUIRED' as const,
      operationId: row.id,
      receptionId: existingReceptionId,
      error: confirmed.error ?? 'No se pudo confirmar la operación reconciliada.',
      payload: snapshot,
    }
  }
  return {
    status: 'CONFIRMED' as const,
    operationId: confirmed.data.operation_id,
    receptionId: confirmed.data.reception_id,
    error: null,
    payload: confirmed.data.payload ?? snapshot,
  }
}
