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

export function getAverageDaysBetweenEntries(entries: Array<{ date: string }>) {
  const dates = [...new Set(entries.map((entry) => entry.date))].sort()
  if (dates.length < 2) return null
  const totalDays = dates.slice(1).reduce((sum, date, index) => {
    const previous = new Date(`${dates[index]}T00:00:00Z`).getTime()
    const current = new Date(`${date}T00:00:00Z`).getTime()
    return sum + Math.round((current - previous) / 86400000)
  }, 0)
  return totalDays / (dates.length - 1)
}

export function getLastEntryDate(entries: Array<{ date: string }>) {
  return entries.reduce<string | null>((latest, entry) => (!latest || entry.date > latest ? entry.date : latest), null)
}
