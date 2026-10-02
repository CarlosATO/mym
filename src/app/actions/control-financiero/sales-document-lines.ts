'use server'

import {
  getFinanceSalesDocumentLines,
  type FinanceSalesDocumentLinesResponse,
} from '@/lib/control-financiero/finance-api'

export async function loadSalesDocumentLines(
  year: number,
  documentId: number,
  providerKey?: string,
  familyKey?: string,
): Promise<FinanceSalesDocumentLinesResponse> {
  const result = await getFinanceSalesDocumentLines(year, documentId, providerKey, familyKey)
  if (!result.ok) throw new Error(result.message)
  return result.data
}
