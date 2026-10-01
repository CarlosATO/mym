import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import type {
  BsaleReceptionDependencies,
  BsaleReceptionDetail,
  BsaleReceptionHeader,
  BsaleReceptionPayload,
} from './bsale-mermas-reception-core'

export function createBsaleMermaReceptionDependencies(companyId: string): BsaleReceptionDependencies {
  return {
    createReception: (payload: BsaleReceptionPayload) =>
      bsaleWriteForCompany<{ id?: number | string | null }>({
        companyId,
        path: '/stocks/receptions.json',
        body: payload,
      }),
    getReception: (receptionId: number) =>
      bsaleFetchResourceForCompany<BsaleReceptionHeader>({
        companyId,
        path: `/stocks/receptions/${receptionId}.json`,
      }),
    getDetails: async (receptionId: number) => {
      const response = await bsaleFetchForCompany<BsaleReceptionDetail>({
        companyId,
        path: `/stocks/receptions/${receptionId}/details.json`,
      })
      return response.items ?? []
    },
  }
}
