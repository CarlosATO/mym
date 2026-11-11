'use server'

import { createClient } from '@/lib/supabase/server'
import { requireWmsPermission } from './authorization'

async function operatorCanReadPreparationNvs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  nvIds: number[],
): Promise<boolean> {
  const { data: cards, error: cardsError } = await supabase
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('status, bsale_nv_id, current_bsale_nv_id')
    .eq('company_id', companyId)
    .or(`bsale_nv_id.in.(${nvIds.join(',')}),current_bsale_nv_id.in.(${nvIds.join(',')})`)
  if (cardsError) return false

  const audited = (cards ?? []).filter(card => card.status === 'AUDITED').length > 0
  const readinessResult = audited
    ? await supabase.schema('logistica').rpc('get_sales_order_route_readiness_v1', { p_company_id: companyId })
    : { data: [], error: null }
  if (readinessResult.error) return false
  const allowedAudited = new Set((readinessResult.data ?? [])
    .filter((row: { route_readiness?: string }) => row.route_readiness !== 'READY_TO_INVOICE')
    .map((row: { bsale_nv_id?: number }) => Number(row.bsale_nv_id)))
  const allowed = new Set<number>()
  for (const card of cards ?? []) {
    if (card.status === 'INVOICED_READY_FOR_ROUTE') continue
    if (card.status === 'AUDITED' && !allowedAudited.has(Number(card.current_bsale_nv_id ?? card.bsale_nv_id))) continue
    allowed.add(Number(card.current_bsale_nv_id ?? card.bsale_nv_id))
    allowed.add(Number(card.bsale_nv_id))
  }
  return nvIds.every(nvId => allowed.has(nvId))
}
import type { PreparationMissingCostLineV1, PreparationProfitabilitySummaryV1 } from '@/modules/logistica/preparacion-pedidos/preparation-profitability'

export async function getSalesOrderPreparationProfitabilitySummaryV1(params: {
  companyId: string
  nvIds: Array<number | string>
}): Promise<{ data: Record<string, PreparationProfitabilitySummaryV1>; error: string | null }> {
  try {
    const companyId = params.companyId?.trim()
    if (!companyId) return { data: {}, error: 'Empresa inválida.' }

    const nvIds = [...new Set(
      params.nvIds
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value > 0),
    )]
    if (nvIds.length === 0) return { data: {}, error: null }

    const auth = await requireWmsPermission('module.logistica.view')
    if (auth.companyId !== companyId) return { data: {}, error: 'Empresa activa inválida.' }
    if (auth.isOperatorBodega) {
      const supabase = await createClient()
      if (!await operatorCanReadPreparationNvs(supabase, companyId, nvIds)) return { data: {}, error: 'No autorizado para consultar estas tarjetas.' }
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .schema('logistica')
      .rpc('get_sales_order_preparation_profitability_summary_v1', {
        p_company_id: companyId,
        p_bsale_nv_ids: nvIds,
      })

    if (error) {
      console.error('[getSalesOrderPreparationProfitabilitySummaryV1] RPC error', {
        companyId,
        nvCount: nvIds.length,
        message: error.message,
      })
      return { data: {}, error: error.message }
    }

    const rows = (data ?? []) as PreparationProfitabilitySummaryV1[]
    const byNv: Record<string, PreparationProfitabilitySummaryV1> = {}
    for (const row of rows) {
      byNv[String(row.bsale_nv_id)] = row
    }
    return { data: byNv, error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderPreparationProfitabilitySummaryV1] Exception:', err)
    return { data: {}, error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}

export async function getSalesOrderPreparationMissingCostLinesV1(params: {
  companyId: string
  nvIds: Array<number | string>
}): Promise<{ data: PreparationMissingCostLineV1[]; error: string | null }> {
  try {
    const companyId = params.companyId?.trim()
    if (!companyId) return { data: [], error: 'Empresa inválida.' }

    const nvIds = [...new Set(
      params.nvIds
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value > 0),
    )]
    if (nvIds.length === 0) return { data: [], error: null }

    const auth = await requireWmsPermission('module.logistica.view')
    if (auth.companyId !== companyId) return { data: [], error: 'Empresa activa inválida.' }
    if (auth.isOperatorBodega) {
      const supabase = await createClient()
      if (!await operatorCanReadPreparationNvs(supabase, companyId, nvIds)) return { data: [], error: 'No autorizado para consultar estas tarjetas.' }
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .schema('logistica')
      .rpc('get_sales_order_preparation_missing_cost_lines_v1', {
        p_company_id: companyId,
        p_bsale_nv_ids: nvIds,
      })

    if (error) {
      console.error('[getSalesOrderPreparationMissingCostLinesV1] RPC error', {
        companyId,
        nvCount: nvIds.length,
        message: error.message,
      })
      return { data: [], error: error.message }
    }

    return { data: (data ?? []) as PreparationMissingCostLineV1[], error: null }
  } catch (err: unknown) {
    console.error('[getSalesOrderPreparationMissingCostLinesV1] Exception:', err)
    return { data: [], error: err instanceof Error ? err.message : 'Error desconocido' }
  }
}
