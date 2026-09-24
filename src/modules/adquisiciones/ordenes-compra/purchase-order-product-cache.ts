'use client'

import { getPurchaseOrderProductCatalog, type PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'

let catalogPromise: Promise<PurchaseOrderCatalogProduct[]> | null = null

export function getPurchaseOrderProductCatalogCached() {
  if (!catalogPromise) {
    catalogPromise = getPurchaseOrderProductCatalog()
      .then(result => {
        if (result.error) throw new Error(result.error)
        return result.data
      })
      .catch(error => {
        catalogPromise = null
        throw error
      })
  }
  return catalogPromise
}

export function prefetchPurchaseOrderProductCatalog() {
  void getPurchaseOrderProductCatalogCached().catch(() => undefined)
}
