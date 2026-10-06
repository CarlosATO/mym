export type ReceiptDisplayItem = {
  product_id?: string | null
  sku?: string | null
  item_type?: string | null
}

export type ReceiptProduct = { id: string; sku: string | null }

export function enrichReceiptItemsWithProducts<T extends ReceiptDisplayItem>(items: T[], products: ReceiptProduct[]) {
  const productsById = new Map(products.map(product => [product.id, product.sku]))
  return items.map(item => ({
    ...item,
    sku: item.product_id ? productsById.get(item.product_id) ?? item.sku ?? null : null,
  }))
}

export function receiptItemSku(item: ReceiptDisplayItem) {
  return item.item_type === 'SERVICE' ? '—' : item.sku?.trim() || '—'
}
