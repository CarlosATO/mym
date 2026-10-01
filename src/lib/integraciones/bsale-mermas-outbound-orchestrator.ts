import { requireWmsPermission } from '@/app/actions/logistica/authorization'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsaleMermaOutboundDependencies } from './bsale-mermas-outbound-adapter'
import {
  executeMermaBsaleOutboundWorkflow,
  resolveMermaRequestObservation,
  type OutboundOperationSnapshot,
  type MermaOutboundLine,
} from './bsale-mermas-outbound-core'
import { resolveCasaMatrizOfficeId } from './bsale-mermas-office'

type OperationStatus = 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'

type OperationRecord = {
  operation_id: string
  request_id: string
  status: OperationStatus
  bsale_consumption_id: number | null
  last_error: string | null
}

export type MermaBsaleOutboundResult =
  | { status: 'CONFIRMED'; operationId: string; consumptionId: number }
  | { status: 'FAILED'; operationId: string; error: string }
  | { status: 'RECONCILIATION_REQUIRED'; operationId: string; error: string }
  | { status: 'SENDING'; operationId: string }

function asOperation(value: unknown): OperationRecord {
  const operation = value as Partial<OperationRecord>
  if (!operation.operation_id || !operation.request_id || !operation.status) {
    throw new Error('La RPC devolvió una operación outbound inválida.')
  }
  return {
    operation_id: operation.operation_id,
    request_id: operation.request_id,
    status: operation.status,
    bsale_consumption_id: operation.bsale_consumption_id == null ? null : Number(operation.bsale_consumption_id),
    last_error: operation.last_error ?? null,
  }
}

function snapshot(operation: OperationRecord): OutboundOperationSnapshot {
  return {
    operationId: operation.operation_id,
    status: operation.status,
    consumptionId: operation.bsale_consumption_id,
    error: operation.last_error,
  }
}

async function resolveCasaMatrizOffice(database: ReturnType<typeof createAdminClient>, companyId: string): Promise<number> {
  const [{ data: offices, error: officesError }, { data: stockRows, error: stockError }] = await Promise.all([
    database.schema('integraciones').from('bsale_offices').select('bsale_id, name').eq('company_id', companyId),
    database.schema('integraciones').from('bsale_stock_current').select('office_id, raw_json').eq('company_id', companyId),
  ])
  if (officesError) throw new Error(`No se pudo resolver CASA MATRIZ: ${officesError.message}`)
  if (stockError) throw new Error(`No se pudo resolver CASA MATRIZ desde stock: ${stockError.message}`)
  return resolveCasaMatrizOfficeId(
    (offices ?? []).map(office => ({ bsaleId: Number(office.bsale_id), name: office.name })),
    (stockRows ?? []).map(row => ({ officeId: row.office_id == null ? null : Number(row.office_id), rawJson: row.raw_json })),
  )
}

async function finish(
  database: ReturnType<typeof createAdminClient>,
  operationId: string,
  companyId: string,
  result: { status: 'CONFIRMED'; consumptionId: number } | { status: 'FAILED' | 'RECONCILIATION_REQUIRED'; error: string },
): Promise<OutboundOperationSnapshot> {
  const { data, error } = await database.schema('mermas').rpc('finish_merma_bsale_outbound_operation', {
    p_operation_id: operationId,
    p_company_id: companyId,
    p_status: result.status,
    p_consumption_id: result.status === 'CONFIRMED' ? result.consumptionId : null,
    p_error: result.status === 'CONFIRMED' ? null : result.error,
  })
  if (error) return {
    operationId,
    status: 'RECONCILIATION_REQUIRED',
    consumptionId: result.status === 'CONFIRMED' ? result.consumptionId : null,
    error: `No se pudo persistir la transición outbound: ${error.message}`,
  }
  return snapshot(asOperation(data))
}

export async function executeMermaBsaleOutbound(requestId: string): Promise<MermaBsaleOutboundResult> {
  const authorization = await requireWmsPermission('logistica.mermas.request.create')
  const database = createAdminClient()
  const companyId = authorization.companyId
  const userId = authorization.user.id

  return executeMermaBsaleOutboundWorkflow({
    prepare: async () => {
      const { data, error } = await database.schema('mermas').rpc('prepare_merma_bsale_outbound_operation', {
        p_request_id: requestId, p_company_id: companyId, p_user_id: userId,
      })
      if (error) throw new Error(`No se pudo preparar el outbound de Mermas: ${error.message}`)
      return snapshot(asOperation(data))
    },
    claim: async operationId => {
      const { data, error } = await database.schema('mermas').rpc('claim_merma_bsale_outbound_operation', {
        p_operation_id: operationId, p_company_id: companyId, p_user_id: userId,
      })
      if (error) throw new Error(`No se pudo reclamar el outbound de Mermas: ${error.message}`)
      if ((data as { claimed?: boolean } | null)?.claimed) return { claimed: true }
      const { data: current, error: currentError } = await database.schema('mermas').rpc('get_merma_bsale_outbound_operation', {
        p_request_id: requestId, p_company_id: companyId, p_user_id: userId,
      })
      if (currentError) throw new Error(`No se pudo leer el estado outbound: ${currentError.message}`)
      return { claimed: false, current: snapshot(asOperation(current)) }
    },
    loadRequest: async () => {
      const [{ data: request, error: requestError }, { data: lines, error: linesError }, officeId] = await Promise.all([
        database.schema('mermas').from('requests').select('id, request_code').eq('id', requestId).eq('company_id', companyId).maybeSingle(),
        database.schema('mermas').from('request_lines').select('bsale_variant_id, quantity, reason, expiration_date, lot, observation').eq('request_id', requestId).eq('company_id', companyId).order('created_at'),
        resolveCasaMatrizOffice(database, companyId),
      ])
      if (requestError || !request) throw new Error(`No se pudo cargar la solicitud: ${requestError?.message ?? 'no encontrada'}`)
      if (linesError) throw new Error(`No se pudieron cargar las líneas: ${linesError.message}`)
      const outboundLines = (lines ?? []).map(line => ({
        variantId: Number(line.bsale_variant_id), quantity: Number(line.quantity), reason: String(line.reason ?? ''),
        expirationDate: String(line.expiration_date ?? ''), lot: line.lot, observation: line.observation,
      })) satisfies MermaOutboundLine[]
      return {
        requestCode: request.request_code,
        officeId,
        observation: resolveMermaRequestObservation(outboundLines),
        lines: outboundLines,
      }
    },
    finish: (operationId, result) => finish(database, operationId, companyId, result),
    bsale: createBsaleMermaOutboundDependencies(companyId),
  })
}
