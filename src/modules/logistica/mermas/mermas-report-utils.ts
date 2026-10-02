export type MermasMonthlyRow = {
  month: string
  gross_cost: number
  gross_units: number
  returned_cost: number
  returned_units: number
  net_cost: number
  net_units: number
}

export function getRecoveryRate(grossCost: number, returnedCost: number) {
  return grossCost > 0 ? returnedCost / grossCost * 100 : null
}

export function getImpactPercentage(netCost: number, totalNetCost: number) {
  return totalNetCost > 0 ? netCost / totalNetCost * 100 : null
}

export function isFullyRecoveredProduct(product: { gross_units: number; returned_units: number; net_units: number; net_cost: number }) {
  return product.gross_units > 0 && product.returned_units === product.gross_units && product.net_units === 0 && product.net_cost === 0
}

export function getMonthlyDisplayState(row: MermasMonthlyRow) {
  return {
    ...row,
    isCrossPeriodRecovery: row.gross_cost === 0 && row.returned_cost > 0,
  }
}
