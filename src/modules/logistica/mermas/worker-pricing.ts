export type WorkerPriceSnapshot = {
  bsale_average_cost: number;
  worker_markup_percent: number;
  worker_unit_price: number;
};

export const WORKER_VAT_RATE = 0.19;

export function calculateCostWithVat(
  averageCost: number | null | undefined,
): number | null {
  if (
    averageCost === null ||
    averageCost === undefined ||
    !Number.isFinite(averageCost) ||
    averageCost <= 0
  ) {
    return null;
  }
  return averageCost * (1 + WORKER_VAT_RATE);
}

export function calculateMinimumUnitPrice(
  averageCost: number | null | undefined,
): number | null {
  const costWithVat = calculateCostWithVat(averageCost);
  return costWithVat === null ? null : Math.ceil(costWithVat);
}

/** Precio sugerido entero en pesos chilenos, redondeado al peso más cercano. */
export function calculateSuggestedUnitPrice(
  averageCost: number | null | undefined,
  markupPercent: number | null | undefined,
): number | null {
  if (
    averageCost === null ||
    averageCost === undefined ||
    !Number.isFinite(averageCost) ||
    averageCost <= 0 ||
    markupPercent === null ||
    markupPercent === undefined ||
    !Number.isFinite(markupPercent) ||
    markupPercent < 0
  ) {
    return null;
  }

  const costWithVat = calculateCostWithVat(averageCost);
  if (costWithVat === null) return null;
  return Math.round(costWithVat * (1 + markupPercent / 100));
}

export const calculateWorkerPrice = calculateSuggestedUnitPrice;
