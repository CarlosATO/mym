import { safeFileName } from './excel-import'

export const CAMPAIGN_IMPORT_STORAGE_PREFIX = 'campaign-stock-imports'

export function buildCampaignImportStoragePrefix(
  companyId: string,
  campaignId: string,
  importId: string
): string {
  return `${companyId}/${CAMPAIGN_IMPORT_STORAGE_PREFIX}/${campaignId}/${importId}/`
}

export function buildCampaignImportStoragePath(params: {
  companyId: string
  campaignId: string
  importId: string
  filename: string
}): string {
  return `${buildCampaignImportStoragePrefix(params.companyId, params.campaignId, params.importId)}${params.importId}-${safeFileName(params.filename)}`
}

export function isCampaignImportStoragePath(params: {
  companyId: string
  campaignId: string
  importId: string
  storagePath: string
}): boolean {
  return params.storagePath.startsWith(
    buildCampaignImportStoragePrefix(params.companyId, params.campaignId, params.importId)
  )
}
