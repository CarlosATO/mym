export type ReceptionSnapshotLine = {
  variantId: number
  quantity: number
  expirationDate: string | null
  lot: string | null
  requestId: string | null
  requestLineId: string | null
  sourceMovementId: string | null
  sourceConsumptionId: number | null
  sourceDetailId: number | null
  unitCost: number
}

export type ReceptionSnapshot = {
  correlationCode: string
  officeId: number
  reason: string
  observation?: string | null
  lines: ReceptionSnapshotLine[]
}

export type BsaleReceptionPayload = {
  document: 'OTRO'
  officeId: number
  documentNumber: string
  note: string
  details: Array<{ quantity: number; variantId: number; cost: number }>
}

export type BsaleReceptionHeader = {
  id?: number | string | null
  document?: string | null
  documentNumber?: string | number | null
  note?: string | null
  office?: { id?: number | string | null } | null
}

export type BsaleReceptionDetail = {
  id?: number | string | null
  quantity?: number | string | null
  cost?: number | string | null
  variant?: { id?: number | string | null } | null
}

export type BsaleReceptionDependencies = {
  createReception: (payload: BsaleReceptionPayload) => Promise<{ id?: number | string | null }>
  getReception: (receptionId: number) => Promise<BsaleReceptionHeader>
  getDetails: (receptionId: number) => Promise<BsaleReceptionDetail[]>
}

export type BsaleReceptionResult =
  | { status: 'CONFIRMED'; receptionId: number }
  | { status: 'FAILED'; error: string }
  | { status: 'RECONCILIATION_REQUIRED'; receptionId: number | null; error: string }

export type ReceptionOperationSnapshot = {
  operationId: string
  status: 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'
  receptionId: number | null
  error: string | null
  payload: ReceptionSnapshot | null
}

export type ReceptionWorkflowDependencies = {
  prepare: () => Promise<ReceptionOperationSnapshot>
  claim: (operationId: string) => Promise<{ claimed: boolean; current?: ReceptionOperationSnapshot }>
  loadSnapshot: () => Promise<ReceptionSnapshot>
  finish: (operationId: string, result: BsaleReceptionResult) => Promise<ReceptionOperationSnapshot>
  bsale: BsaleReceptionDependencies
}

export type ReceptionWorkflowResult =
  | { status: 'CONFIRMED'; operationId: string; receptionId: number }
  | { status: 'FAILED'; operationId: string; error: string }
  | { status: 'RECONCILIATION_REQUIRED'; operationId: string; receptionId: number | null; error: string }
  | { status: 'SENDING'; operationId: string }

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} debe ser un entero positivo.`)
  return value
}

function positiveCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error('La recepción requiere un costo unitario confiable.')
  return value
}

export function buildReceptionNote(correlationCode: string, reason: string) {
  const correlation = correlationCode.trim()
  if (!correlation) throw new Error('La correlación de regularización es obligatoria.')
  if (correlation.length > 100) throw new Error('La correlación supera el máximo de 100 caracteres.')
  const suffix = reason.trim()
  if (!suffix) return correlation
  const prefix = `${correlation} | `
  let result = ''
  for (const character of suffix) {
    if ((prefix + result + character).length > 100) break
    result += character
  }
  return prefix + result
}

export function buildReceptionPayload(snapshot: ReceptionSnapshot): BsaleReceptionPayload {
  const officeId = positiveInteger(snapshot.officeId, 'officeId')
  if (!snapshot.lines.length) throw new Error('La regularización no contiene líneas.')
  const details = snapshot.lines.map(line => ({
    quantity: line.quantity > 0 && Number.isFinite(line.quantity) ? line.quantity : (() => { throw new Error('La cantidad de recepción debe ser positiva.') })(),
    variantId: positiveInteger(line.variantId, 'variantId'),
    cost: positiveCost(line.unitCost),
  }))
  return {
    document: 'OTRO',
    officeId,
    documentNumber: snapshot.correlationCode,
    note: buildReceptionNote(snapshot.correlationCode, [snapshot.reason, snapshot.observation].filter(Boolean).join(' | ')),
    details,
  }
}

export function buildFefoSnapshot(
  correlationCode: string,
  officeId: number,
  reason: string,
  requested: Array<{ variantId: number; quantity: number }>,
  lots: ReceptionSnapshotLine[],
): ReceptionSnapshot {
  const result: ReceptionSnapshotLine[] = []
  for (const item of requested) {
    let remaining = item.quantity
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('La cantidad solicitada debe ser positiva.')
    const candidates = lots
      .filter(lot => lot.variantId === item.variantId && lot.quantity > 0)
      .sort((left, right) => (left.expirationDate === null ? 1 : right.expirationDate === null ? -1 : left.expirationDate.localeCompare(right.expirationDate)) || (left.lot ?? '').localeCompare(right.lot ?? ''))
    for (const lot of candidates) {
      if (remaining <= 0) break
      const piece = Math.min(remaining, lot.quantity)
      result.push({ ...lot, quantity: piece })
      remaining -= piece
    }
    if (remaining > 0) throw new Error(`Stock insuficiente para la variante ${item.variantId}.`)
  }
  return { correlationCode, officeId, reason, lines: result }
}

export function weightedUnitCost(lines: Array<{ quantity: number; unitCost: number }>) {
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0)
  if (quantity <= 0) throw new Error('No se puede ponderar un volumen vacío.')
  const total = lines.reduce((sum, line) => sum + line.quantity * positiveCost(line.unitCost), 0)
  return total / quantity
}

function postFailureStatus(error: unknown): 'FAILED' | 'RECONCILIATION_REQUIRED' {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status?: unknown }).status) : null
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'FAILED' : 'RECONCILIATION_REQUIRED'
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function verifyReception(snapshot: ReceptionSnapshot, header: BsaleReceptionHeader, details: BsaleReceptionDetail[], receptionId: number) {
  if (numberOrNull(header.id) !== receptionId || numberOrNull(header.office?.id) !== snapshot.officeId) return false
  if (header.document && header.document !== 'OTRO') return false
  if (header.documentNumber !== undefined && String(header.documentNumber) !== snapshot.correlationCode) return false
  if (header.note !== undefined && !String(header.note).includes(snapshot.correlationCode)) return false
  const expected = new Map<number, { quantity: number; cost: number }>()
  for (const line of snapshot.lines) {
    const current = expected.get(line.variantId) ?? { quantity: 0, cost: 0 }
    current.quantity += line.quantity
    current.cost += line.quantity * line.unitCost
    expected.set(line.variantId, current)
  }
  const actual = new Map<number, { quantity: number; cost: number }>()
  for (const detail of details) {
    const variantId = numberOrNull(detail.variant?.id)
    const quantity = numberOrNull(detail.quantity)
    const cost = numberOrNull(detail.cost)
    if (variantId === null || quantity === null || cost === null || cost <= 0) return false
    const current = actual.get(variantId) ?? { quantity: 0, cost: 0 }
    current.quantity += quantity
    current.cost += quantity * cost
    actual.set(variantId, current)
  }
  if (expected.size !== actual.size) return false
  return [...expected].every(([variantId, value]) => {
    const received = actual.get(variantId)
    return received !== undefined && received.quantity === value.quantity && Math.abs(received.cost - value.cost) <= 0.01
  })
}

export async function executeBsaleReception(snapshot: ReceptionSnapshot, dependencies: BsaleReceptionDependencies): Promise<BsaleReceptionResult> {
  let payload: BsaleReceptionPayload
  try {
    payload = buildReceptionPayload(snapshot)
  } catch (error) {
    return { status: 'FAILED', error: errorMessage(error, 'Payload de recepción inválido.') }
  }
  let created: { id?: number | string | null }
  try {
    created = await dependencies.createReception(payload)
  } catch (error) {
    const message = errorMessage(error, 'No se pudo crear la recepción Bsale.')
    return postFailureStatus(error) === 'FAILED'
      ? { status: 'FAILED', error: message }
      : { status: 'RECONCILIATION_REQUIRED', receptionId: null, error: message }
  }
  const receptionId = numberOrNull(created.id)
  if (receptionId === null) return { status: 'RECONCILIATION_REQUIRED', receptionId: null, error: 'Bsale confirmó la recepción sin devolver un ID.' }
  try {
    const [header, details] = await Promise.all([dependencies.getReception(receptionId), dependencies.getDetails(receptionId)])
    if (!verifyReception(snapshot, header, details, receptionId)) return { status: 'RECONCILIATION_REQUIRED', receptionId, error: `La recepción Bsale ${receptionId} no coincide con el snapshot.` }
    return { status: 'CONFIRMED', receptionId }
  } catch (error) {
    return { status: 'RECONCILIATION_REQUIRED', receptionId, error: errorMessage(error, 'No se pudo verificar la recepción Bsale.') }
  }
}

export async function executeBsaleReceptionWorkflow(dependencies: ReceptionWorkflowDependencies): Promise<ReceptionWorkflowResult> {
  const prepared = await dependencies.prepare()
  if (prepared.status !== 'PREPARED') return snapshotResult(prepared)
  const claimed = await dependencies.claim(prepared.operationId)
  if (!claimed.claimed) return claimed.current ? snapshotResult(claimed.current) : { status: 'RECONCILIATION_REQUIRED', operationId: prepared.operationId, receptionId: null, error: 'No se pudo leer el estado de la operación.' }
  try {
    const snapshot = await dependencies.loadSnapshot()
    return snapshotResult(await dependencies.finish(prepared.operationId, await executeBsaleReception(snapshot, dependencies.bsale)))
  } catch (error) {
    return snapshotResult(await dependencies.finish(prepared.operationId, { status: 'FAILED', error: errorMessage(error, 'No se pudo preparar la recepción.') }))
  }
}

function snapshotResult(operation: ReceptionOperationSnapshot): ReceptionWorkflowResult {
  if (operation.status === 'CONFIRMED' && operation.receptionId !== null) return { status: 'CONFIRMED', operationId: operation.operationId, receptionId: operation.receptionId }
  if (operation.status === 'SENDING') return { status: 'SENDING', operationId: operation.operationId }
  return { status: operation.status === 'FAILED' ? 'FAILED' : 'RECONCILIATION_REQUIRED', operationId: operation.operationId, receptionId: operation.receptionId, error: operation.error ?? `La operación está en estado ${operation.status}.` }
}
