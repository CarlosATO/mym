import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import type { PurchaseReceiptPayload, RemoteReceptionCandidate, RemoteReceptionDetail, RemoteReceptionHeader, PurchaseReceiptRemoteDependencies } from './bsale-purchase-receipt-core'

export function createBsalePurchaseReceiptDependencies(companyId: string): PurchaseReceiptRemoteDependencies {
  return {
    createReception: payload => bsaleWriteForCompany({ companyId, path: '/stocks/receptions.json', body: payload as unknown as Record<string, unknown> }),
    getReception: id => bsaleFetchResourceForCompany<RemoteReceptionHeader>({ companyId, path: `/stocks/receptions/${id}.json` }),
    getDetails: async id => (await bsaleFetchForCompany<RemoteReceptionDetail>({ companyId, path: `/stocks/receptions/${id}/details.json` })).items ?? [],
    findReceptions: async (documentNumber, officeId) => (await bsaleFetchForCompany<RemoteReceptionCandidate>({ companyId, path: '/stocks/receptions.json', params: { documentnumber: documentNumber, officeid: officeId } })).items ?? [],
  }
}
