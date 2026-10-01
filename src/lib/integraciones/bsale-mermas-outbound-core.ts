export type MermaOutboundLine = {
  variantId: number
  quantity: number
  reason: string
  expirationDate: string
  lot?: string | null
  observation?: string | null
}

export type MermaOutboundRequest = {
  requestCode: string
  officeId: number
  observation?: string | null
  lines: MermaOutboundLine[]
}

export type BsaleConsumptionPayload = {
  note: string
  officeId: number
  consumptionTypeId: 2
  details: Array<{ quantity: number; variantId: number }>
}

export type BsaleConsumptionResponse = {
  id?: number | string | null
  consumptionDate?: number | string | null
  note?: string | null
  consumptionTypeId?: number | string | null
  office?: { id?: number | string | null } | null
  user?: { id?: number | string | null } | null
  details?: { href?: string | null } | null
}

export type BsaleConsumptionVerification = {
  id?: number | string | null
  consumptionTypeId?: number | string | null
  office?: { id?: number | string | null } | null
  details?: { href?: string | null } | null
}

export type BsaleConsumptionDetail = {
  id?: number | string | null
  quantity?: number | string | null
  cost?: number | string | null
  variantStock?: number | string | null
  variant?: { id?: number | string | null } | null
}

export type MermaOutboundDependencies = {
  createConsumption: (payload: BsaleConsumptionPayload) => Promise<BsaleConsumptionResponse>
  getConsumption: (consumptionId: number) => Promise<BsaleConsumptionVerification>
  getDetails: (consumptionId: number) => Promise<BsaleConsumptionDetail[]>
}

export type MermaOutboundResult =
  | { status: 'CONFIRMED'; consumptionId: number }
  | { status: 'RECONCILIATION_REQUIRED'; error: string }
  | { status: 'FAILED'; error: string }

export type OutboundOperationSnapshot = {
  operationId: string
  status: 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'
  consumptionId: number | null
  error: string | null
}

export type MermaOutboundWorkflowDependencies = {
  prepare: () => Promise<OutboundOperationSnapshot>
  claim: (operationId: string) => Promise<{ claimed: boolean; current?: OutboundOperationSnapshot }>
  loadRequest: () => Promise<MermaOutboundRequest>
  finish: (operationId: string, result: MermaOutboundResult) => Promise<OutboundOperationSnapshot>
  bsale: MermaOutboundDependencies
}

export type MermaOutboundWorkflowResult =
  | { status: 'CONFIRMED'; operationId: string; consumptionId: number }
  | { status: 'FAILED'; operationId: string; error: string }
  | { status: 'RECONCILIATION_REQUIRED'; operationId: string; error: string }
  | { status: 'SENDING'; operationId: string }

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} debe ser un entero positivo.`)
  return value
}

function positiveQuantity(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('La cantidad debe ser positiva.')
  return value
}

function snapshotResult(operation: OutboundOperationSnapshot): MermaOutboundWorkflowResult {
  if (operation.status === 'CONFIRMED' && operation.consumptionId !== null) {
    return { status: 'CONFIRMED', operationId: operation.operationId, consumptionId: operation.consumptionId }
  }
  if (operation.status === 'SENDING') return { status: 'SENDING', operationId: operation.operationId }
  return {
    status: operation.status === 'FAILED' ? 'FAILED' : 'RECONCILIATION_REQUIRED',
    operationId: operation.operationId,
    error: operation.error ?? `La operación está en estado ${operation.status}.`,
  }
}

export function resolveMermaRequestObservation(lines: MermaOutboundLine[]): string | null {
  const observations = [...new Set(
    lines
      .map(line => line.observation?.trim() ?? '')
      .filter(Boolean),
  )]
  return observations.length ? observations.join('; ') : null
}

export function buildMermaBsaleNote(requestCode: string, observation?: string | null): string {
  const code = requestCode.trim()
  if (!code) throw new Error('El código de solicitud es obligatorio.')
  if (code.length > 100) throw new Error('El código de solicitud supera el máximo de 100 caracteres.')
  const value = observation?.trim() ?? ''
  if (!value) return code
  const prefix = `${code} | `
  let observationsPart = ''
  for (const character of value) {
    if ((prefix + observationsPart + character).length > 100) break
    observationsPart += character
  }
  return prefix + observationsPart
}

export function buildMermaBsalePayload(input: MermaOutboundRequest): BsaleConsumptionPayload {
  const officeId = positiveInteger(input.officeId, 'officeId')
  if (!input.lines.length) throw new Error('La solicitud no contiene líneas.')
  const details = input.lines.map(line => ({
    quantity: positiveQuantity(line.quantity),
    variantId: positiveInteger(line.variantId, 'variantId'),
  }))
  return {
    note: buildMermaBsaleNote(input.requestCode, input.observation),
    officeId,
    consumptionTypeId: 2,
    details,
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function postFailureStatus(error: unknown): 'FAILED' | 'RECONCILIATION_REQUIRED' {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : null
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429
    ? 'FAILED'
    : 'RECONCILIATION_REQUIRED'
}

function verificationMatches(
  input: MermaOutboundRequest,
  response: BsaleConsumptionVerification,
  details: BsaleConsumptionDetail[],
  consumptionId: number,
): boolean {
  if (numberOrNull(response.id) !== consumptionId) return false
  if (numberOrNull(response.consumptionTypeId) !== 2) return false
  if (numberOrNull(response.office?.id) !== input.officeId) return false
  const expected = new Map<number, number>()
  for (const line of input.lines) {
    expected.set(line.variantId, (expected.get(line.variantId) ?? 0) + line.quantity)
  }
  const actual = new Map<number, number>()
  for (const detail of details) {
    const variantId = numberOrNull(detail.variant?.id)
    const quantity = numberOrNull(detail.quantity)
    if (variantId === null || quantity === null) return false
    actual.set(variantId, (actual.get(variantId) ?? 0) + quantity)
  }
  if (expected.size !== actual.size) return false
  return [...expected].every(([variantId, quantity]) => actual.get(variantId) === quantity)
}

export async function executeBsaleMermaOutbound(
  input: MermaOutboundRequest,
  dependencies: MermaOutboundDependencies,
): Promise<MermaOutboundResult> {
  let payload: BsaleConsumptionPayload
  try {
    payload = buildMermaBsalePayload(input)
  } catch (error) {
    return { status: 'FAILED', error: error instanceof Error ? error.message : 'Payload inválido.' }
  }

  let created: BsaleConsumptionResponse
  try {
    created = await dependencies.createConsumption(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido al crear el consumo.'
    return { status: postFailureStatus(error), error: message }
  }

  const consumptionId = numberOrNull(created.id)
  if (consumptionId === null) {
    return { status: 'RECONCILIATION_REQUIRED', error: 'Bsale confirmó la petición sin devolver un ID de consumo.' }
  }

  try {
    const [header, details] = await Promise.all([
      dependencies.getConsumption(consumptionId),
      dependencies.getDetails(consumptionId),
    ])
    if (!verificationMatches(input, header, details, consumptionId)) {
      return { status: 'RECONCILIATION_REQUIRED', error: `El consumo Bsale ${consumptionId} no coincide con el payload enviado.` }
    }
    return { status: 'CONFIRMED', consumptionId }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo verificar el consumo creado.'
    return { status: 'RECONCILIATION_REQUIRED', error: message }
  }
}

export async function executeMermaBsaleOutboundWorkflow(
  dependencies: MermaOutboundWorkflowDependencies,
): Promise<MermaOutboundWorkflowResult> {
  const prepared = await dependencies.prepare()
  if (prepared.status !== 'PREPARED') return snapshotResult(prepared)

  const claimed = await dependencies.claim(prepared.operationId)
  if (!claimed.claimed) {
    if (!claimed.current) return { status: 'RECONCILIATION_REQUIRED', operationId: prepared.operationId, error: 'No se pudo leer el estado después de perder el claim.' }
    return snapshotResult(claimed.current)
  }

  try {
    const input = await dependencies.loadRequest()
    const result = await executeBsaleMermaOutbound(input, dependencies.bsale)
    return snapshotResult(await dependencies.finish(prepared.operationId, result))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo cargar la solicitud outbound.'
    return snapshotResult(await dependencies.finish(prepared.operationId, { status: 'FAILED', error: message }))
  }
}
