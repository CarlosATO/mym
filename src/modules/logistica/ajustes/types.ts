import type { StockAdjustment, StockAdjustmentItem } from '@/app/actions/logistica/ajustes'

export type AdjustmentLine = {
  id: string
  product_id: string
  product_sku: string
  product_description: string
  location_id: string
  location_code: string
  lot_number: string
  expiration_date: string
  quantity: string
  unit_cost: string
  notes: string
  available_stock: number
}

export type FilterTab = 'ALL' | 'POSITIVE' | 'NEGATIVE' | 'COMPLETED'

export type AdjustmentDetailCache = Record<string, { adjustment: StockAdjustment; items: StockAdjustmentItem[] }>
