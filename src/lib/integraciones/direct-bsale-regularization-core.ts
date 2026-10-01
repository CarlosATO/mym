export type DirectBsaleReviewLine = {
  detail_id: number;
  variant_id: number;
  quantity: number;
  reason: string;
  expiration_date: string;
  has_difference?: boolean;
};

export function validateDirectBsaleReview(lines: DirectBsaleReviewLine[], confirmedReview: boolean, expectedDetailIds?: number[]): string | null {
  if (!confirmedReview) return "Confirma que revisaste los productos y cantidades del consumo Bsale.";
  if (!lines.length) return "El consumo Bsale debe contener al menos una línea.";
  const detailIds = new Set<number>();
  for (const line of lines) {
    if (detailIds.has(line.detail_id)) return "Cada línea Bsale debe aparecer una sola vez.";
    detailIds.add(line.detail_id);
    if (line.has_difference) return "Existe una diferencia pendiente de revisión.";
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) return "La cantidad Bsale no es válida.";
    if (!line.reason.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(line.expiration_date)) {
      return "Completa motivo y vencimiento en todas las líneas.";
    }
  }
  if (expectedDetailIds && (expectedDetailIds.length !== detailIds.size || expectedDetailIds.some((id) => !detailIds.has(id)))) {
    return "Las líneas no coinciden exactamente con el consumo Bsale.";
  }
  return null;
}
