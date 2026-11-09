import { compareCommercialVersions, type PreparationCommercialLine, type PreparationCommercialVersion } from './preparation-commercial-version'

export type AuditCommercialLine = {
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  audit_quantity: number
}

export type AuditCommercialDifference = {
  kind: 'ADDED' | 'REMOVED' | 'QUANTITY_MISMATCH' | 'IDENTITY_MISMATCH' | 'VALUE_CHANGED' | 'TOTAL_CHANGED'
  identity: string | null
  preparedQuantity: number | null
  bsaleQuantity: number | null
  detailId: number | null
  message: string
  changedFields?: string[]
}

export type AuditCommercialComparison = {
  status: 'READY_TO_INVOICE' | 'INCIDENTS'
  differences: AuditCommercialDifference[]
}

function key(line: { bsale_detail_id?: number | null; bsale_variant_id?: number | null; sku?: string | null }): string | null {
  if (line.bsale_variant_id != null) return `VARIANT:${line.bsale_variant_id}`
  if (line.sku?.trim()) return `SKU:${line.sku.trim().toUpperCase()}`
  if (line.bsale_detail_id != null) return `DETAIL:${line.bsale_detail_id}`
  return null
}

function identityFromLine(line: PreparationCommercialLine | AuditCommercialLine | null): string | null {
  if (!line) return null
  return key('bsale_detail_id' in line
    ? line
    : { bsale_detail_id: line.detailId, bsale_variant_id: line.variantId, sku: line.sku })
}

function mapVersionDifference(difference: ReturnType<typeof compareCommercialVersions>['differences'][number]): AuditCommercialDifference {
  const previous = difference.previous
  const current = difference.current
  const detailId = current?.detailId ?? previous?.detailId ?? null
  const identity = identityFromLine(current ?? previous)
  if (difference.kind === 'ADDED') {
    return { kind: 'ADDED', identity, preparedQuantity: 0, bsaleQuantity: current?.quantity ?? null, detailId, message: 'Bsale contiene un producto que no estaba en la versión aceptada.' }
  }
  if (difference.kind === 'REMOVED') {
    return { kind: 'REMOVED', identity, preparedQuantity: previous?.quantity ?? null, bsaleQuantity: 0, detailId, message: 'La versión aceptada contiene un producto que ya no está en Bsale.' }
  }
  if (difference.kind === 'SUBSTITUTION') {
    return { kind: 'IDENTITY_MISMATCH', identity, preparedQuantity: previous?.quantity ?? null, bsaleQuantity: current?.quantity ?? null, detailId, message: 'Bsale sustituyó la identidad comercial del producto.', changedFields: difference.changedFields }
  }
  if (difference.kind === 'QUANTITY_INCREASED' || difference.kind === 'QUANTITY_DECREASED') {
    return { kind: 'QUANTITY_MISMATCH', identity, preparedQuantity: previous?.quantity ?? null, bsaleQuantity: current?.quantity ?? null, detailId, message: 'La cantidad vigente en Bsale no coincide con la versión aceptada.', changedFields: difference.changedFields }
  }
  return { kind: 'VALUE_CHANGED', identity, preparedQuantity: previous?.quantity ?? null, bsaleQuantity: current?.quantity ?? null, detailId, message: 'Los valores comerciales de la línea cambiaron en Bsale.', changedFields: difference.changedFields }
}

function totalDifference(previous: PreparationCommercialVersion, current: PreparationCommercialVersion): AuditCommercialDifference | null {
  const fields = (['netAmount', 'taxAmount', 'totalAmount'] as const).filter(field => previous[field] !== current[field])
  if (fields.length === 0) return null
  return {
    kind: 'TOTAL_CHANGED',
    identity: null,
    preparedQuantity: null,
    bsaleQuantity: null,
    detailId: null,
    message: 'Los totales comerciales de la Nota de Venta cambiaron en Bsale.',
    changedFields: [...fields],
  }
}

function uniqueDifferences(differences: AuditCommercialDifference[]): AuditCommercialDifference[] {
  const seen = new Set<string>()
  return differences.filter(difference => {
    const keyValue = JSON.stringify([difference.kind, difference.identity, difference.detailId, difference.changedFields ?? []])
    if (seen.has(keyValue)) return false
    seen.add(keyValue)
    return true
  })
}

export function compareAuditedCommercialLines(
  auditedLines: AuditCommercialLine[],
  current: PreparationCommercialVersion,
  acceptedVersion: PreparationCommercialVersion | null = null,
): AuditCommercialComparison {
  const differences: AuditCommercialDifference[] = []
  const expected = new Map<string, AuditCommercialLine[]>()
  const observed = new Map<string, PreparationCommercialVersion['lines']>()

  for (const line of auditedLines) {
    const identity = key(line)
    if (!identity) {
      differences.push({ kind: 'IDENTITY_MISMATCH', identity: null, preparedQuantity: line.audit_quantity, bsaleQuantity: null, detailId: line.bsale_detail_id, message: 'La línea auditada no tiene identidad comercial verificable.' })
      continue
    }
    expected.set(identity, [...(expected.get(identity) ?? []), line])
  }
  for (const line of current.lines) {
    const identity = key({ bsale_detail_id: line.detailId, bsale_variant_id: line.variantId, sku: line.sku })
    if (!identity) {
      differences.push({ kind: 'IDENTITY_MISMATCH', identity: null, preparedQuantity: null, bsaleQuantity: line.quantity, detailId: line.detailId ?? null, message: 'Bsale devolvió una línea sin identidad comercial verificable.' })
      continue
    }
    observed.set(identity, [...(observed.get(identity) ?? []), line])
  }

  for (const [identity, lines] of expected) {
    if (lines.length !== 1) {
      differences.push({ kind: 'IDENTITY_MISMATCH', identity, preparedQuantity: null, bsaleQuantity: null, detailId: lines[0].bsale_detail_id, message: 'La identidad auditada es ambigua.' })
      continue
    }
    const currentLines = observed.get(identity) ?? []
    if (currentLines.length === 0) {
      differences.push({ kind: 'REMOVED', identity, preparedQuantity: lines[0].audit_quantity, bsaleQuantity: 0, detailId: lines[0].bsale_detail_id, message: 'El producto auditado no está presente en la Nota de Venta vigente.' })
      continue
    }
    if (currentLines.length !== 1) {
      differences.push({ kind: 'IDENTITY_MISMATCH', identity, preparedQuantity: lines[0].audit_quantity, bsaleQuantity: null, detailId: currentLines[0].detailId ?? lines[0].bsale_detail_id, message: 'Bsale devolvió identidad comercial duplicada.' })
      continue
    }
    const quantity = Number(currentLines[0].quantity)
    if (!Number.isFinite(quantity) || quantity !== Number(lines[0].audit_quantity)) {
      differences.push({ kind: 'QUANTITY_MISMATCH', identity, preparedQuantity: lines[0].audit_quantity, bsaleQuantity: Number.isFinite(quantity) ? quantity : null, detailId: currentLines[0].detailId ?? lines[0].bsale_detail_id, message: 'La cantidad vigente en Bsale no coincide con la cantidad auditada.' })
    }
  }

  for (const [identity, lines] of observed) {
    if (!expected.has(identity)) {
      differences.push({ kind: 'ADDED', identity, preparedQuantity: 0, bsaleQuantity: Number(lines.reduce((sum, line) => sum + Number(line.quantity ?? 0), 0)), detailId: lines[0].detailId ?? null, message: 'Bsale contiene un producto que no fue auditado.' })
    }
  }

  if (acceptedVersion) {
    const acceptedComparison = compareCommercialVersions(acceptedVersion, current)
    differences.push(...acceptedComparison.differences.map(mapVersionDifference))
    const totals = totalDifference(acceptedVersion, current)
    if (totals) differences.push(totals)
    if (!acceptedComparison.sameIdentity) {
      differences.push({ kind: 'IDENTITY_MISMATCH', identity: null, preparedQuantity: null, bsaleQuantity: null, detailId: null, message: 'La identidad canónica de Bsale cambió respecto de la versión aceptada.' })
    }
  }

  return { status: uniqueDifferences(differences).length === 0 ? 'READY_TO_INVOICE' : 'INCIDENTS', differences: uniqueDifferences(differences) }
}
