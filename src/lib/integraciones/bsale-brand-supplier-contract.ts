export type BrandSupplierClassification =
  | 'INEQUIVOCO'
  | 'CASI_INEQUIVOCO'
  | 'MIXTO'
  | 'SIN_RESOLVER'

export type BrandSupplierStatus = 'LINKED' | 'PENDING' | 'CONFLICT'

export interface CandidateSummary {
  activeProducts: number
  resolvedPreferredProducts: number
  realSupplierCount: number
}

export type LinkDecision = 'CREATE' | 'ALREADY_LINKED' | 'CONFLICT'

export function validateBrandSupplierLinkInput(input: {
  brandId: number
  supplierKind: string
  sameCompany: boolean
  supplierActive: boolean
}): string | null {
  if (!Number.isInteger(input.brandId) || input.brandId <= 0) return 'INVALID_BSALE_BRAND_ID'
  if (!input.sameCompany) return 'SUPPLIER_NOT_FOUND_OR_WRONG_COMPANY'
  if (input.supplierKind !== 'REAL') return 'SUPPLIER_MUST_BE_REAL'
  if (!input.supplierActive) return 'SUPPLIER_NOT_ACTIVE'
  return null
}

export function decideLinkOperation(existingSupplierId: string | null, requestedSupplierId: string): LinkDecision {
  if (existingSupplierId === null) return 'CREATE'
  return existingSupplierId === requestedSupplierId ? 'ALREADY_LINKED' : 'CONFLICT'
}

export function classifyBrandSupplier(summary: CandidateSummary): BrandSupplierClassification {
  if (summary.realSupplierCount === 0) return 'SIN_RESOLVER'
  if (summary.realSupplierCount > 1) return 'MIXTO'
  if (summary.resolvedPreferredProducts === summary.activeProducts) return 'INEQUIVOCO'
  return 'CASI_INEQUIVOCO'
}

export function deriveBrandSupplierStatus(
  hasApprovedLink: boolean,
  classification: BrandSupplierClassification,
): BrandSupplierStatus {
  if (hasApprovedLink) return 'LINKED'
  return classification === 'MIXTO' ? 'CONFLICT' : 'PENDING'
}
