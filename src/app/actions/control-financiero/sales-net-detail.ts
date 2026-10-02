'use server'

import { getFinanceSalesNetDetail, type FinanceSalesNetDetailResponse } from '@/lib/control-financiero/finance-api'

export async function loadSalesNetDetail(
  year: number,
  month?: number,
  familyKey?: string,
  page = 1,
  pageSize = 100,
): Promise<FinanceSalesNetDetailResponse> {
  const result = await getFinanceSalesNetDetail(year, month, familyKey, page, pageSize)
  if (!result.ok) throw new Error(result.message)
  return result.data
}
