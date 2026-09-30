function normalizeSupplierName(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.\\/:*?"<>|]/g, '')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function buildPurchaseOrderFileNameBase(supplierName: string, correlative: string): string {
  const supplier = normalizeSupplierName(supplierName) || 'PROVEEDOR'
  const number = correlative.trim().replace(/^OC-/, '') || 'SIN_NUMERO'
  return `OC_${supplier}_${number}`
}
