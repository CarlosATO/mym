import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import type {
  BsaleConsumptionDetail,
  BsaleConsumptionPayload,
  BsaleConsumptionResponse,
  BsaleConsumptionVerification,
  MermaOutboundDependencies,
} from './bsale-mermas-outbound-core'

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
