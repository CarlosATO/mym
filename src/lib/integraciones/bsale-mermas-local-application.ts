import { requireWmsPermission } from '@/app/actions/logistica/authorization'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchBsaleConsumptionForLocalApplication } from './bsale-mermas-outbound-adapter'

type ConfirmedOutbound = {
  id: string
  request_id: string
  status: 'CONFIRMED'
  bsale_consumption_id: number | string | null
  local_applied_at: string | null
}

export type ApplyConfirmedMermaResult = {
  status: 'FINALIZADA'
  operationId: string
  consumptionId: number
  idempotent?: boolean
}

export async function applyConfirmedMermaBsaleOutbound(
  operationId: string,
): Promise<ApplyConfirmedMermaResult> {
  const authorization = await requireWmsPermission('logistica.mermas.request.create')
  const database = createAdminClient()
  const { data: operation, error: operationError } = await database.schema('mermas')
    .from('bsale_outbound_operations')
    .select('id, request_id, status, bsale_consumption_id, local_applied_at')
    .eq('id', operationId)
    .eq('company_id', authorization.companyId)
    .eq('operation_type', 'MERMAS_CONSUMPTION')
    .maybeSingle()

  if (operationError || !operation) throw new Error(`Operación outbound no encontrada: ${operationError?.message ?? 'sin datos'}`)
  const confirmed = operation as ConfirmedOutbound
  const consumptionId = Number(confirmed.bsale_consumption_id)
  if (confirmed.status !== 'CONFIRMED' || !Number.isInteger(consumptionId) || consumptionId <= 0) {
    throw new Error('La operación outbound no está CONFIRMED con consumption_id válido.')
  }
  if (confirmed.local_applied_at) {
    return { status: 'FINALIZADA', operationId: confirmed.id, consumptionId, idempotent: true }
  }

  // Read-only remote recovery. This function never uses the POST adapter.
  const remote = await fetchBsaleConsumptionForLocalApplication(
    authorization.companyId,
    consumptionId,
  )
  const { data, error } = await database.schema('mermas').rpc('apply_confirmed_bsale_merma_outbound', {
    p_operation_id: confirmed.id,
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_header: remote.header,
    p_details: remote.details,
  })
  if (error) throw new Error(`No se pudo aplicar localmente el consumo Bsale: ${error.message}`)
  const result = data as { status?: string; operation_id?: string; consumption_id?: number | string }
  if (result.status !== 'FINALIZADA' || Number(result.consumption_id) !== consumptionId) {
    throw new Error('La aplicación local devolvió un resultado inválido.')
  }
  return {
    status: 'FINALIZADA',
    operationId: result.operation_id ?? confirmed.id,
    consumptionId,
  }
}
