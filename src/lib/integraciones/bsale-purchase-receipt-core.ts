export type PurchaseReceiptPayload = {
  document: 'FACTURA' | 'GUÍA'
  officeId: number
  documentNumber: number
  note: string
  details: Array<{ quantity: number; variantId: number; cost: number }>
}

export type PurchaseReceiptSnapshot = PurchaseReceiptPayload

export function autoSyncIsAllowed(settings: { enabled: boolean; autoSyncEnabled: boolean }) {
  return settings.enabled && settings.autoSyncEnabled
}

export function chooseUniqueReconciliationCandidate(compatibleIds: number[]) {
  return compatibleIds.length === 1 ? compatibleIds[0] : null
}

export type AcceptedReceiptLine = { itemType: 'PRODUCT' | 'SERVICE'; condition: 'CONFORME' | 'DANADO' | 'RECHAZADO' | 'FALTANTE'; variantId?: number | null; quantity: number; netAmount: number }

export function buildPurchaseReceiptPayload(input: { documentType: string; documentNumber: string | number; officeId: number; receiptNumber: string; poCorrelative: string; observation?: string | null; serviceVariantId: number; lines: AcceptedReceiptLine[] }): PurchaseReceiptPayload {
  const grouped = new Map<number, { quantity: number; net: number }>()
  let serviceNet = 0
  for (const line of input.lines) {
    if (!['CONFORME', 'DANADO'].includes(line.condition)) continue
    if (line.itemType === 'SERVICE') { serviceNet += line.netAmount; continue }
    if (line.variantId == null) throw new Error('Una línea PRODUCT no tiene bsale_variant_id.')
    if (line.quantity <= 0 || line.netAmount <= 0) throw new Error('La línea PRODUCT requiere cantidad y costo neto válidos.')
    const current = grouped.get(line.variantId) ?? { quantity: 0, net: 0 }
    current.quantity += line.quantity
    current.net += line.netAmount
    grouped.set(line.variantId, current)
  }
  const details = [...grouped].map(([variantId, value]) => ({ variantId, quantity: value.quantity, cost: value.net / value.quantity }))
  if (serviceNet > 0) details.push({ variantId: input.serviceVariantId, quantity: 1, cost: serviceNet })
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
  const normalized = String(value ?? '').trim()
  if (!/^\d+$/.test(normalized)) throw new Error('El número de documento debe ser numérico para BSale.')
  const parsed = Number(normalized)
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
