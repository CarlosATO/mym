// ─── Mapeo certificado MYM por API Bsale document_types/codeSii/DTE ────
// type_id | Bsale name                  | codeSii | DTE             | MYM treatment
//    5   | FACTURA ELECTRÓNICA          | 33      | Factura Electr. | OFFICIAL_SALE
//    23  | NOTA VENTA                   | -       | (no electrónico) | SALES_ORDER
//    2   | NOTA DE CRÉDITO ELECTRÓNICA  | 61      | NC Electrónica  | CREDIT_NOTE
//    7   | GUÍA DE DESPACHO ELECTRÓNICA | 52      | GD Electrónica  | DISPATCH
//    1   | BOLETA ELECTRÓNICA T         | 39      | Boleta Electr.  | ANOMALOUS_RECEIPT
//
// Regla MYM: la venta comercial oficial es solo Factura Electrónica (type_id=5).
// NV (type_id=23) son pedidos operativos, no venta.
// Boletas (type_id=1) son anomalías/errores en MYM.

export const BSALE_DOCUMENT_TYPE_IDS = {
  INVOICE: 5,
  CREDIT_NOTE: 2,
  DISPATCH_GUIDE: 7,
  SALES_ORDER: 23,
  ANOMALOUS_RECEIPT: 1,
} as const

// Venta oficial MYM = Factura Electrónica (DTE 33)
export const OFFICIAL_SALE_DOCUMENT_TYPE_IDS: number[] = [5]

// Sinónimo para compatibilidad — ahora representa venta oficial MYM
export const SALE_DOCUMENT_TYPE_IDS: number[] = OFFICIAL_SALE_DOCUMENT_TYPE_IDS

// Pedido operativo (Nota de Venta)
export const SALES_ORDER_DOCUMENT_TYPE_IDS: number[] = [23]

// Nota de Crédito Electrónica
export const CREDIT_NOTE_DOCUMENT_TYPE_IDS: number[] = [2]

// Guía de Despacho Electrónica
export const DISPATCH_DOCUMENT_TYPE_IDS: number[] = [7]

// Boleta Electrónica (anomalía operacional en MYM)
export const ANOMALOUS_DOCUMENT_TYPE_IDS: number[] = [1]

// Set completo para sync/mirror (todos los documentos operativos)
export const BSALE_SYNC_DOCUMENT_TYPE_IDS: number[] = [1, 2, 5, 7, 23]

// Set para análisis de reposición (venta confirmada + demanda)
export const REPLENISHMENT_DOCUMENT_TYPE_IDS: number[] = [5, 23]

// ─── Tipos de documento excluidos explícitamente de venta ──────────────────
export const NON_SALE_DOCUMENT_TYPE_IDS: number[] = [2, 36, 37]

// ─── Helper para filtrar documentos de venta oficial MYM ───────────────────
export function isSaleDocument(documentTypeId: number | null | undefined): boolean {
  if (documentTypeId == null) return false
  return SALE_DOCUMENT_TYPE_IDS.includes(documentTypeId)
}
