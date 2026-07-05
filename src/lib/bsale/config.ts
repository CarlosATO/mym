// ─── Tipos de documento Bsale considerados como venta real ──────────
// Documentos que representan ventas reales para el análisis de reposición.
// Se actualizan los IDs disponibles en integraciones.bsale_document_types,
// pero por ahora se mantienen como constante.
//
// 1  = BOLETA ELECTRÓNICA T    → ✅ Venta real
// 5  = FACTURA ELECTRÓNICA     → ✅ Venta real
// 23 = NOTA VENTA              → ✅ Venta real
//
// Excluidos:
// 2  = NOTA DE CRÉDITO ELECTRÓNICA  → Devolución, no venta
// 7  = GUÍA DE DESPACHO ELECTRÓNICA  → Pendiente confirmar si duplica facturas
//
export const SALE_DOCUMENT_TYPE_IDS: number[] = [1, 5, 23]

// ─── Tipos de documento a excluir explícitamente ──────────────────
export const NON_SALE_DOCUMENT_TYPE_IDS: number[] = [2, 36, 37]

// ─── Helper para filtrar documentos de venta ───────────────────────
export function isSaleDocument(documentTypeId: number | null | undefined): boolean {
  if (documentTypeId == null) return false
  return SALE_DOCUMENT_TYPE_IDS.includes(documentTypeId)
}
