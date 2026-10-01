import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import type {
  BsaleConsumptionDetail,
  BsaleConsumptionPayload,
  BsaleConsumptionResponse,
  BsaleConsumptionVerification,
  MermaOutboundDependencies,
} from './bsale-mermas-outbound-core'

export type BsaleConsumptionForLocalApplication = {
  header: BsaleConsumptionResponse
  details: BsaleConsumptionDetail[]
}

export function createBsaleMermaOutboundDependencies(companyId: string): MermaOutboundDependencies {
  return {
    createConsumption: (payload: BsaleConsumptionPayload) =>
      bsaleWriteForCompany<BsaleConsumptionResponse>({
        companyId,
        path: '/stocks/consumptions.json',
        body: payload,
      }),
    getConsumption: (consumptionId: number) =>
      bsaleFetchResourceForCompany<BsaleConsumptionVerification>({
        companyId,
        path: `/stocks/consumptions/${consumptionId}.json`,
      }),
    getDetails: async (consumptionId: number) => {
      const response = await bsaleFetchForCompany<BsaleConsumptionDetail>({
        companyId,
        path: `/stocks/consumptions/${consumptionId}/details.json`,
      })
      return response.items ?? []
    },
  }
}

export async function fetchBsaleConsumptionForLocalApplication(
  companyId: string,
  consumptionId: number,
): Promise<BsaleConsumptionForLocalApplication> {
  const [header, details] = await Promise.all([
    bsaleFetchResourceForCompany<BsaleConsumptionResponse>({
      companyId,
      path: `/stocks/consumptions/${consumptionId}.json`,
    }),
    bsaleFetchForCompany<BsaleConsumptionDetail>({
      companyId,
      path: `/stocks/consumptions/${consumptionId}/details.json`,
    }),
  ])
  return { header, details: details.items ?? [] }
}
