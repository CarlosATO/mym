export type ProfitabilityCoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export function getCoverageStatus(coveredNetSales: number, totalNetSales: number): ProfitabilityCoverageStatus {
  if (coveredNetSales <= 0) return 'UNAVAILABLE';
  return coveredNetSales < totalNetSales ? 'PARTIAL' : 'COMPLETE';
}

export function formatCoveragePercent(
  value: number | null | undefined,
  status: ProfitabilityCoverageStatus,
): string {
  if (value === null || value === undefined) return '—';

  const roundedToTwo = Math.round(value * 100) / 100;
  if (status === 'PARTIAL' && roundedToTwo >= 100) {
    return value >= 100
      ? '<100%'
      : `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value)}%`;
  }

  return `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
}
