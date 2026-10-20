'use server'

import { createClient } from '@/lib/supabase/server'
import type { PreparationProfitabilitySummaryV1 } from '@/modules/logistica/preparacion-pedidos/preparation-profitability'

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
