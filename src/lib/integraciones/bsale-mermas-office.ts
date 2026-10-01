export type MermaOfficeCandidate = {
  bsaleId: number | null
  name?: string | null
}

export type MermaStockOfficeCandidate = {
  officeId: number | null
  rawJson?: unknown
}

function isCasaMatrizName(value: string | null | undefined) {
  const name = (value ?? '').trim().toUpperCase()
  return name.includes('CASA MATRIZ') || name.includes('MATRIZ')
}

function uniqueOfficeIds(values: Array<number | null>) {
  return [...new Set(values.filter((value): value is number => value !== null && Number.isInteger(value) && value > 0))]
}

function stockOfficeName(rawJson: unknown) {
  if (!rawJson || typeof rawJson !== 'object') return null
  const office = (rawJson as { office?: unknown }).office
  if (!office || typeof office !== 'object') return null
  const name = (office as { name?: unknown }).name
  return typeof name === 'string' ? name : null
}

export function resolveCasaMatrizOfficeId(
  offices: MermaOfficeCandidate[],
  stockRows: MermaStockOfficeCandidate[],
): number {
  const namedOfficeIds = uniqueOfficeIds(
    offices.filter(office => isCasaMatrizName(office.name)).map(office => office.bsaleId),
  )
  if (namedOfficeIds.length === 1) return namedOfficeIds[0]
  if (namedOfficeIds.length > 1) throw new Error('No se pudo resolver una única oficina CASA MATRIZ.')

  const namedStockOfficeIds = uniqueOfficeIds(
    stockRows
      .filter(row => isCasaMatrizName(stockOfficeName(row.rawJson)))
      .map(row => row.officeId),
  )
  if (namedStockOfficeIds.length === 1) return namedStockOfficeIds[0]
  if (namedStockOfficeIds.length > 1) throw new Error('No se pudo resolver una única oficina CASA MATRIZ.')

  const stockOfficeIds = uniqueOfficeIds(stockRows.map(row => row.officeId))
  if (stockOfficeIds.length === 1) return stockOfficeIds[0]
  throw new Error('No se pudo resolver una única oficina CASA MATRIZ.')
}
