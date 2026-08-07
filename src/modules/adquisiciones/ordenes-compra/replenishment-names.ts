import type { SkuSummary } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

export const PRODUCT_FALLBACK = 'Producto no encontrado en catálogo'
export const NO_SUPPLIER = 'Sin proveedor'
export const NO_PSEUDO = 'Sin pseudoproveedor'

export function getProductName(s: SkuSummary): string {
  return s.producto && s.producto.trim() ? s.producto : PRODUCT_FALLBACK
}

export function getRealSupplierName(s: SkuSummary): string {
  return s.real_supplier_name || NO_SUPPLIER
}

export function getPseudoSupplierName(s: SkuSummary): string {
  return s.pseudo_supplier_name || NO_PSEUDO
}
