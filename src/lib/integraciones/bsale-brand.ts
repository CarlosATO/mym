export interface BsaleBrandReference {
  id: number | null
  href: string | null
}

export interface BsaleBrandRecord {
  company_id: string
  bsale_brand_id: number
  bsale_brand_href: string | null
  last_seen_at: string
  updated_at: string
  status: 'DETECTED'
}

export function extractBsaleBrand(product: unknown): BsaleBrandReference {
  const brand = product && typeof product === 'object' && 'brand' in product
    ? (product as { brand?: unknown }).brand
    : null

  if (!brand || typeof brand !== 'object') return { id: null, href: null }

  const rawId = (brand as { id?: unknown }).id
  const id = typeof rawId === 'number'
    ? rawId
    : typeof rawId === 'string' && rawId.trim() !== ''
      ? Number(rawId)
      : NaN

  if (!Number.isInteger(id) || id <= 0) return { id: null, href: null }

  const rawHref = (brand as { href?: unknown }).href
  const href = typeof rawHref === 'string' && rawHref.trim() !== '' ? rawHref.trim() : null
  return { id, href }
}

export function collectBsaleBrandRecords(
  variants: Array<{ product?: unknown }>,
  companyId: string,
  observedAt: string
): BsaleBrandRecord[] {
  const records = new Map<number, BsaleBrandRecord>()

  for (const variant of variants) {
    const brand = extractBsaleBrand(variant.product)
    if (brand.id === null) continue

    records.set(brand.id, {
      company_id: companyId,
      bsale_brand_id: brand.id,
      bsale_brand_href: brand.href,
      last_seen_at: observedAt,
      updated_at: observedAt,
      status: 'DETECTED'
    })
  }

  return [...records.values()]
}
