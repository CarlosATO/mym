import { requireWmsPermission } from '@/app/actions/logistica/authorization'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsaleMermaReceptionDependencies } from './bsale-mermas-reception-adapter'
import {
  executeBsaleReceptionWorkflow,
  type ReceptionOperationSnapshot,
  type ReceptionSnapshot,
} from './bsale-mermas-reception-core'
import { resolveCasaMatrizOfficeId } from './bsale-mermas-office'

export type MermaBsaleReceptionResult =
  | { status: 'CONFIRMED'; operationId: string; receptionId: number; stockExitOperationId: string }
  | { status: 'FAILED'; operationId: string; error: string }
  | { status: 'RECONCILIATION_REQUIRED'; operationId: string; receptionId: number | null; error: string }
  | { status: 'SENDING'; operationId: string }

export type MermaBsaleReceptionInput = {
  items: Array<{ variantId: number; quantity: number }>
  reason: string
  observation?: string | null
}

type OperationRow = {
  operation_id?: string
  status?: ReceptionOperationSnapshot['status']
  reception_id?: number | string | null
  error?: string | null
  payload?: ReceptionSnapshot | null
}

function parseOperation(value: unknown): ReceptionOperationSnapshot {
  const row = value as OperationRow
  if (!row.operation_id || !row.status) throw new Error('La RPC devolvió una operación de recepción inválida.')
  return {
    operationId: row.operation_id,
    status: row.status,
    receptionId: row.reception_id == null ? null : Number(row.reception_id),
    error: row.error ?? null,
    payload: row.payload ?? null,
  }
}

async function resolveOffice(database: ReturnType<typeof createAdminClient>, companyId: string) {
  const [{ data: offices, error: officesError }, { data: stock, error: stockError }] = await Promise.all([
    database.schema('integraciones').from('bsale_offices').select('bsale_id, name').eq('company_id', companyId),
    database.schema('integraciones').from('bsale_stock_current').select('office_id, raw_json').eq('company_id', companyId),
  ])
  if (officesError) throw new Error(`No se pudo resolver CASA MATRIZ: ${officesError.message}`)
  if (stockError) throw new Error(`No se pudo resolver CASA MATRIZ desde stock: ${stockError.message}`)
  return resolveCasaMatrizOfficeId(
    (offices ?? []).map(office => ({ bsaleId: Number(office.bsale_id), name: office.name })),
    (stock ?? []).map(row => ({ officeId: row.office_id == null ? null : Number(row.office_id), rawJson: row.raw_json })),
  )
}

export async function applyMermaBsaleReception(operationId: string) {
  const authorization = await requireWmsPermission('logistica.mermas.request.create')
  const { data, error } = await createAdminClient().schema('mermas').rpc('apply_confirmed_bsale_reception', {
    p_operation_id: operationId,
    p_user_id: authorization.user.id,
  })
  if (error) throw new Error(`No se pudo aplicar localmente la recepción Bsale: ${error.message}`)
  return String((data as { stock_exit_operation_id?: string }).stock_exit_operation_id)
}

export async function executeMermaBsaleReception(input: MermaBsaleReceptionInput): Promise<MermaBsaleReceptionResult> {
  const authorization = await requireWmsPermission('logistica.mermas.request.create')
  const database = createAdminClient()
  const companyId = authorization.companyId
  const userId = authorization.user.id
  let operationId = ''
  const workflow = await executeBsaleReceptionWorkflow({
    prepare: async () => {
      const officeId = await resolveOffice(database, companyId)
      const { data, error } = await database.schema('mermas').rpc('prepare_bsale_reception_operation', {
        p_company_id: companyId,
        p_user_id: userId,
        p_office_id: officeId,
        p_reason: input.reason,
        p_observation: input.observation ?? null,
        p_items: input.items.map(item => ({ variant_id: item.variantId, quantity: item.quantity })),
      })
      if (error) throw new Error(`No se pudo preparar la recepción Bsale: ${error.message}`)
      const operation = parseOperation(data)
      operationId = operation.operationId
      return operation
    },
    claim: async id => {
      const { data, error } = await database.schema('mermas').rpc('claim_bsale_reception_operation', { p_operation_id: id })
      if (error) throw new Error(`No se pudo reclamar la recepción Bsale: ${error.message}`)
      const row = data as { claimed?: boolean; status?: ReceptionOperationSnapshot['status']; reception_id?: number; error?: string }
      if (row.claimed) return { claimed: true }
      return { claimed: false, current: { operationId: id, status: row.status ?? 'RECONCILIATION_REQUIRED', receptionId: row.reception_id ?? null, error: row.error ?? null, payload: null } }
    },
    loadSnapshot: async () => {
      const { data, error } = await database.schema('mermas').from('bsale_reception_operations').select('payload_snapshot').eq('id', operationId).single()
      if (error || !data?.payload_snapshot) throw new Error(`No se pudo cargar el snapshot de recepción: ${error?.message ?? 'vacío'}`)
      return data.payload_snapshot as ReceptionSnapshot
    },
    finish: async (id, result) => {
      const { data, error } = await database.schema('mermas').rpc('finish_bsale_reception_operation', {
        p_operation_id: id,
        p_status: result.status,
        p_reception_id: result.status === 'CONFIRMED' || result.status === 'RECONCILIATION_REQUIRED' ? result.receptionId : null,
        p_error: result.status === 'CONFIRMED' ? null : result.error,
      })
      if (error) return { operationId: id, status: 'RECONCILIATION_REQUIRED', receptionId: result.status === 'CONFIRMED' ? result.receptionId : null, error: `No se pudo persistir el estado: ${error.message}`, payload: null }
      return parseOperation(data)
    },
    bsale: createBsaleMermaReceptionDependencies(companyId),
  })
  if (workflow.status !== 'CONFIRMED') return workflow
  try {
    const stockExitOperationId = await applyMermaBsaleReception(workflow.operationId)
    return { ...workflow, stockExitOperationId }
  } catch (error) {
    return { status: 'RECONCILIATION_REQUIRED', operationId: workflow.operationId, receptionId: workflow.receptionId, error: error instanceof Error ? error.message : 'La recepción requiere aplicación local.' }
  }
}
