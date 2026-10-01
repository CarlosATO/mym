export type DirectBsaleReviewLine = {
  detail_id: number;
  variant_id: number;
  quantity: number;
  reason: string;
  expiration_date: string;
  has_difference?: boolean;
};

export type BulkEditableLine = {
  reason: string;
  expiration_date: string;
  observation: string;
};

export function isValidDirectBsaleDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function applyBulkReason<T extends BulkEditableLine>(lines: T[], reason: string) {
  return lines.map((line) => ({ ...line, reason }));
}

export function applyBulkExpiration<T extends BulkEditableLine>(lines: T[], expiration: string) {
  if (!isValidDirectBsaleDate(expiration)) return null;
  return lines.map((line) => ({ ...line, expiration_date: expiration }));
}

export function applyBulkObservation<T extends BulkEditableLine>(lines: T[], observation: string) {
  return lines.map((line) => ({ ...line, observation }));
}

export function getIncompleteLineCount(lines: BulkEditableLine[]) {
  return lines.filter((line) => !line.reason.trim() || !isValidDirectBsaleDate(line.expiration_date)).length;
}

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
