import type { MermaBsaleOutboundResult } from './bsale-mermas-outbound-orchestrator'

export type MermaWorkflowRequest = {
  lines: unknown
  evidence: unknown
  sessionId: string
  sessionToken: string
  finalizeToken: string
}

export type CreatedMermaRequest = {
  requestId: string
  requestCode: string
}

export type MermaLocalApplicationResult = {
  status: 'FINALIZADA'
  operationId: string
  consumptionId: number
}

export type MermaWorkflowResult =
  | { outcome: 'FINALIZED'; requestPersisted: true; requestId: string; requestCode: string; operationId: string; consumptionId: number }
  | { outcome: 'NOT_CREATED'; requestPersisted: false; error: string }
  | { outcome: 'BSALE_FAILED'; requestPersisted: true; requestId: string; requestCode: string; operationId: string; error: string }
  | { outcome: 'RECONCILIATION_REQUIRED'; requestPersisted: true; requestId: string; requestCode: string; operationId: string; error: string }
  | { outcome: 'SENDING'; requestPersisted: true; requestId: string; requestCode: string; operationId: string }
  | { outcome: 'LOCAL_APPLICATION_PENDING'; requestPersisted: true; requestId: string; requestCode: string; operationId: string; consumptionId: number; error: string }

export type MermaWorkflowDependencies<TRequest> = {
  create: (request: TRequest) => Promise<CreatedMermaRequest>
  executeOutbound: (requestId: string) => Promise<MermaBsaleOutboundResult>
  applyLocal: (operationId: string) => Promise<MermaLocalApplicationResult>
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function createAndProcessMermaRequest<TRequest>(
  request: TRequest,
  dependencies: MermaWorkflowDependencies<TRequest>,
): Promise<MermaWorkflowResult> {
  let created: CreatedMermaRequest
  try {
    created = await dependencies.create(request)
  } catch (error) {
    return { outcome: 'NOT_CREATED', requestPersisted: false, error: errorMessage(error, 'No se pudo crear la solicitud.') }
  }

  const persisted = {
    requestPersisted: true as const,
    requestId: created.requestId,
    requestCode: created.requestCode,
  }

  let outbound: MermaBsaleOutboundResult
  try {
    outbound = await dependencies.executeOutbound(created.requestId)
  } catch (error) {
    return {
      ...persisted,
      outcome: 'RECONCILIATION_REQUIRED',
      operationId: '',
      error: errorMessage(error, 'No se pudo determinar el estado del outbound Bsale.'),
    }
  }

  if (outbound.status === 'FAILED') {
    return { ...persisted, outcome: 'BSALE_FAILED', operationId: outbound.operationId, error: outbound.error }
  }
  if (outbound.status === 'RECONCILIATION_REQUIRED') {
    return { ...persisted, outcome: 'RECONCILIATION_REQUIRED', operationId: outbound.operationId, error: outbound.error }
  }
  if (outbound.status === 'SENDING') {
    return { ...persisted, outcome: 'SENDING', operationId: outbound.operationId }
  }

  try {
    const local = await dependencies.applyLocal(outbound.operationId)
    return {
      ...persisted,
      outcome: 'FINALIZED',
      operationId: local.operationId,
      consumptionId: local.consumptionId,
    }
  } catch (error) {
    return {
      ...persisted,
      outcome: 'LOCAL_APPLICATION_PENDING',
      operationId: outbound.operationId,
      consumptionId: outbound.consumptionId,
      error: errorMessage(error, 'El consumo confirmado está pendiente de aplicación local.'),
    }
  }
}
