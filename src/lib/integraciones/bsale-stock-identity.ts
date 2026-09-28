export type StockIdentityMethod = 'stock_identity_from_catalog' | 'stock_identity_from_variant_code' | 'stock_identity_unresolved'

export interface StockIdentity {
  sku: string | null
  method: StockIdentityMethod
}

export function getBsaleAvailableStockQuantity(value: unknown) {
  const quantity = Number(value)
  return Number.isFinite(quantity) ? quantity : 0
}

function normalize(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase()
  return normalized && !['NULL', 'NONE', 'UNDEFINED'].includes(normalized) ? normalized : ''
}

export function resolveBsaleStockIdentity(
  variantId: unknown,
  variantCode: unknown,
  catalogByVariant: Map<string, { sku: string | null }>,
): StockIdentity {
  const catalogProduct = catalogByVariant.get(String(variantId ?? ''))
  const catalogSku = normalize(catalogProduct?.sku)
  if (catalogSku) return { sku: catalogSku, method: 'stock_identity_from_catalog' }

  const fallbackSku = normalize(variantCode)
  if (fallbackSku) return { sku: fallbackSku, method: 'stock_identity_from_variant_code' }

  return { sku: null, method: 'stock_identity_unresolved' }
}
