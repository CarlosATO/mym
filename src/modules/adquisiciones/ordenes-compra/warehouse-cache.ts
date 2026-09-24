'use client'

import { getActiveCompany } from '@/app/actions/companies'
import { getWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'

const WAREHOUSE_CACHE_TTL_MS = 60_000
const warehouseCache = new Map<string, {
  expiresAt: number
  promise: Promise<Warehouse[]>
}>()

export async function getPurchaseOrderWarehousesCached(): Promise<Warehouse[]> {
  const company = await getActiveCompany()
  if (!company?.id) return []

  const now = Date.now()
  const cached = warehouseCache.get(company.id)
  if (cached && cached.expiresAt > now) return cached.promise

  const promise = getWarehouses({ is_active: 'true', page: 1, pageSize: 1000 })
    .then(result => result.data.filter(warehouse => warehouse.is_active))
  warehouseCache.set(company.id, { expiresAt: now + WAREHOUSE_CACHE_TTL_MS, promise })
  return promise
}

export function prefetchPurchaseOrderWarehouses(): void {
  void getPurchaseOrderWarehousesCached().catch(() => undefined)
}
