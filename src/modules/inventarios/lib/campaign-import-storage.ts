export const CAMPAIGN_IMPORT_STORAGE_PREFIX = 'campaign-stock-imports'

export function sanitizeCampaignImportFileName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
}

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
  return `${buildCampaignImportStoragePrefix(params.companyId, params.campaignId, params.importId)}${params.importId}-${sanitizeCampaignImportFileName(params.filename)}`
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
