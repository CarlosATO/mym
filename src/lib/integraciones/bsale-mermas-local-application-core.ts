export type LocalRequestLine = {
  id: string
  variantId: number
  quantity: number
  createdAt: string
  expirationDate: string | null
  lot: string | null
  hasEvidence: boolean
}

export type LocalBsaleDetail = {
  detailId: number
  variantId: number
  quantity: number
}

export type LocalAllocation = {
  detailId: number
  requestLineId: string
  quantity: number
  expirationDate: string
  lot: string | null
}

function sumByVariant<T extends { variantId: number; quantity: number }>(rows: T[]) {
  const totals = new Map<number, number>()
  for (const row of rows) totals.set(row.variantId, (totals.get(row.variantId) ?? 0) + row.quantity)
  return totals
}

export function buildMermaLocalAllocationPlan(
  requestLines: LocalRequestLine[],
  details: LocalBsaleDetail[],
): LocalAllocation[] {
  if (!requestLines.length || !details.length) throw new Error('La aplicación local requiere líneas y detalles.')
  for (const line of requestLines) {
    if (line.quantity <= 0 || !Number.isInteger(line.variantId) || line.variantId <= 0) throw new Error(`Línea inválida: ${line.id}`)
    if (!line.expirationDate) throw new Error(`Falta vencimiento en línea: ${line.id}`)
    if (!line.hasEvidence) throw new Error(`Falta evidencia en línea: ${line.id}`)
  }
  for (const detail of details) {
    if (!Number.isInteger(detail.detailId) || detail.detailId <= 0 || !Number.isInteger(detail.variantId) || detail.variantId <= 0 || detail.quantity <= 0) {
      throw new Error(`Detalle Bsale inválido: ${detail.detailId}`)
    }
  }
  const requestTotals = sumByVariant(requestLines)
  const detailTotals = sumByVariant(details)
  if (requestTotals.size !== detailTotals.size || [...requestTotals].some(([variantId, quantity]) => detailTotals.get(variantId) !== quantity)) {
    throw new Error('Las cantidades Bsale no coinciden con la solicitud.')
  }

  const remainingLines = new Map(requestLines.map(line => [line.id, line.quantity]))
  const allocations: LocalAllocation[] = []
  const orderedLines = [...requestLines].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  for (const detail of [...details].sort((a, b) => a.detailId - b.detailId)) {
    let remainingDetail = detail.quantity
    for (const line of orderedLines.filter(candidate => candidate.variantId === detail.variantId)) {
      if (remainingDetail <= 0) break
      const piece = Math.min(remainingDetail, remainingLines.get(line.id) ?? 0)
      if (piece <= 0) continue
      allocations.push({ detailId: detail.detailId, requestLineId: line.id, quantity: piece, expirationDate: line.expirationDate!, lot: line.lot })
      remainingDetail -= piece
      remainingLines.set(line.id, (remainingLines.get(line.id) ?? 0) - piece)
    }
    if (remainingDetail > 0) throw new Error(`Detalle Bsale sin asignación completa: ${detail.detailId}`)
  }
  if ([...remainingLines.values()].some(quantity => quantity !== 0)) throw new Error('Líneas sin asignación completa.')
  return allocations
}
