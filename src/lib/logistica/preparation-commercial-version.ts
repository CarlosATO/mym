export type PreparationCommercialIdentity = {
  canonicalToken: string
  historicalBsaleId: number
  currentBsaleId: number
  folio?: string | null
}

export type PreparationCommercialLineInput = {
  detailId?: number | null
  variantId?: number | null
  sku?: string | null
  productName?: string | null
  quantity: number
  unitNetValue?: number | null
  lineNetAmount?: number | null
  lineTaxAmount?: number | null
  lineGrossAmount?: number | null
  lineNumber?: number | null
  special?: boolean
}

export type PreparationCommercialLine = Omit<PreparationCommercialLineInput, 'sku' | 'productName'> & {
  sku: string | null
  productName: string
}

export type PreparationCommercialVersion = {
  identity: PreparationCommercialIdentity
  physicalId: number
  generationDate?: string | null
  emissionDate?: string | null
  lines: PreparationCommercialLineInput[]
  netAmount?: number | null
  taxAmount?: number | null
  totalAmount?: number | null
  currency?: string | null
}

export type CommercialFingerprint = {
  value: string
  content: string
}

export type CommercialLineDifference = {
  kind: 'ADDED' | 'REMOVED' | 'QUANTITY_INCREASED' | 'QUANTITY_DECREASED' | 'VALUE_CHANGED' | 'SUBSTITUTION'
  previous: PreparationCommercialLine | null
  current: PreparationCommercialLine | null
  quantityDelta: number | null
  changedFields: string[]
  confidence: 'CERTAIN' | 'AMBIGUOUS'
}

export type CommercialMatchConflict = {
  reason: 'AMBIGUOUS_VARIANT' | 'AMBIGUOUS_SKU' | 'AMBIGUOUS_SPECIAL_LINE' | 'IDENTITY_MISMATCH'
  previousLines: PreparationCommercialLine[]
  currentLines: PreparationCommercialLine[]
}

export type CommercialComparisonResult = {
  sameIdentity: boolean
  identity: PreparationCommercialIdentity
  previousFingerprint: CommercialFingerprint
  currentFingerprint: CommercialFingerprint
  contentEquivalent: boolean
  differences: CommercialLineDifference[]
  conflicts: CommercialMatchConflict[]
  totals: {
    previous: { netAmount: number | null; taxAmount: number | null; totalAmount: number | null }
    current: { netAmount: number | null; taxAmount: number | null; totalAmount: number | null }
    totalDelta: number | null
  }
}

type IndexedLine = { line: PreparationCommercialLine; index: number }

const numberOrNull = (value: number | null | undefined): number | null => (
  value == null ? null : Number(value)
)

function snapshotValue(snapshot: Record<string, unknown>, snakeCase: string, camelCase: string): unknown {
  return snapshot[snakeCase] ?? snapshot[camelCase]
}

export function preparationCommercialLineFromSnapshot(snapshot: Record<string, unknown>): PreparationCommercialLineInput {
  const sku = snapshotValue(snapshot, 'sku', 'variantCode')
  const productName = snapshotValue(snapshot, 'product_name', 'productName')
  return {
    detailId: numberOrNull(snapshotValue(snapshot, 'detail_id', 'detailId') as number | null | undefined),
    variantId: numberOrNull(snapshotValue(snapshot, 'variant_id', 'variantId') as number | null | undefined),
    sku: typeof sku === 'string' ? sku : null,
    productName: typeof productName === 'string' ? productName : null,
    quantity: numberOrNull(snapshot.quantity as number | null | undefined) ?? 0,
    unitNetValue: numberOrNull(snapshotValue(snapshot, 'unit_net_value', 'unitNetValue') as number | null | undefined),
    lineNetAmount: numberOrNull(snapshotValue(snapshot, 'line_net_amount', 'lineNetAmount') as number | null | undefined),
    lineTaxAmount: numberOrNull(snapshotValue(snapshot, 'line_tax_amount', 'lineTaxAmount') as number | null | undefined),
    lineGrossAmount: numberOrNull(snapshotValue(snapshot, 'line_gross_amount', 'lineGrossAmount') as number | null | undefined),
    lineNumber: numberOrNull(snapshotValue(snapshot, 'line_number', 'lineNumber') as number | null | undefined),
    special: snapshot.special === true,
  }
}

const normalizeText = (value: string | null | undefined): string => (
  (value ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-CL')
)

const normalizeNumber = (value: number | null | undefined): number | null => {
  const parsed = numberOrNull(value)
  if (parsed == null || !Number.isFinite(parsed)) return null
  return Object.is(parsed, -0) ? 0 : parsed
}

function normalizeLine(line: PreparationCommercialLineInput): PreparationCommercialLine {
  return {
    detailId: line.detailId == null ? null : Number(line.detailId),
    variantId: line.variantId == null ? null : Number(line.variantId),
    sku: line.sku == null || !line.sku.trim() ? null : line.sku.trim(),
    productName: line.productName?.trim() || 'Producto sin descripción',
    quantity: normalizeNumber(line.quantity) ?? 0,
    unitNetValue: normalizeNumber(line.unitNetValue),
    lineNetAmount: normalizeNumber(line.lineNetAmount),
    lineTaxAmount: normalizeNumber(line.lineTaxAmount),
    lineGrossAmount: normalizeNumber(line.lineGrossAmount),
    lineNumber: line.lineNumber == null ? null : Number(line.lineNumber),
    special: line.special === true,
  }
}

function lineContent(line: PreparationCommercialLine, includeQuantity = true): Record<string, unknown> {
  return {
    variantId: line.variantId,
    sku: normalizeText(line.sku),
    ...(includeQuantity ? { quantity: line.quantity } : {}),
    unitNetValue: line.unitNetValue,
    lineNetAmount: line.lineNetAmount,
    lineTaxAmount: line.lineTaxAmount,
    lineGrossAmount: line.lineGrossAmount,
    lineNumber: line.lineNumber,
    special: line.special,
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(',')}}`
}

function lineSortKey(line: PreparationCommercialLine): string {
  return stableJson(lineContent(line))
}

function commercialContent(version: PreparationCommercialVersion): string {
  const lines = version.lines.map(normalizeLine).sort((left, right) => lineSortKey(left).localeCompare(lineSortKey(right)))
  return stableJson({
    lines: lines.map(line => lineContent(line)),
    netAmount: normalizeNumber(version.netAmount),
    taxAmount: normalizeNumber(version.taxAmount),
    totalAmount: normalizeNumber(version.totalAmount),
    currency: normalizeText(version.currency),
  })
}

export function fingerprintCommercialVersion(version: PreparationCommercialVersion): CommercialFingerprint {
  const content = commercialContent(version)
  return { value: content, content }
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right
}

function changedFields(previous: PreparationCommercialLine, current: PreparationCommercialLine): string[] {
  const fields: Array<keyof PreparationCommercialLine> = [
    'quantity', 'unitNetValue', 'lineNetAmount', 'lineTaxAmount', 'lineGrossAmount', 'sku',
  ]
  return fields.filter(field => !sameValue(
    field === 'sku' || field === 'productName' ? normalizeText(previous[field] as string) : previous[field],
    field === 'sku' || field === 'productName' ? normalizeText(current[field] as string) : current[field],
  ))
}

function matchKey(line: PreparationCommercialLine): string | null {
  if (line.variantId != null && Number.isSafeInteger(line.variantId)) return `variant:${line.variantId}`
  if (line.sku) return `sku:${normalizeText(line.sku)}`
  return null
}

function pairGroup(previous: IndexedLine[], current: IndexedLine[]): { pairs: Array<[IndexedLine, IndexedLine]>; conflict: CommercialMatchConflict | null } {
  if (previous.length === 0 || current.length === 0) return { pairs: [], conflict: null }
  if (previous.length === 1 && current.length === 1) return { pairs: [[previous[0], current[0]]], conflict: null }

  const positional = new Map<number, IndexedLine>()
  for (const item of current) {
    if (item.line.lineNumber != null) positional.set(item.line.lineNumber, item)
  }
  const used = new Set<number>()
  const pairs: Array<[IndexedLine, IndexedLine]> = []
  for (const oldItem of previous) {
    if (oldItem.line.lineNumber == null) continue
    const next = positional.get(oldItem.line.lineNumber)
    if (next && !used.has(next.index)) {
      pairs.push([oldItem, next])
      used.add(next.index)
    }
  }
  if (pairs.length === previous.length && pairs.length === current.length) return { pairs, conflict: null }

  const remainingPrevious = previous.filter(item => !pairs.some(([oldItem]) => oldItem.index === item.index))
  const remainingCurrent = current.filter(item => !used.has(item.index))
  const exactKeys = [...new Set([
    ...remainingPrevious.map(item => stableJson(lineContent(item.line, false))),
    ...remainingCurrent.map(item => stableJson(lineContent(item.line, false))),
  ])].sort()
  for (const key of exactKeys) {
    const olds = remainingPrevious.filter(item => stableJson(lineContent(item.line, false)) === key)
    const news = remainingCurrent.filter(item => stableJson(lineContent(item.line, false)) === key)
    if (olds.length === 1 && news.length === 1) {
      pairs.push([olds[0], news[0]])
    }
  }
  const paired = new Set(pairs.flatMap(([oldItem, newItem]) => [oldItem.index, newItem.index]))
  const unmatchedPrevious = previous.filter(item => !paired.has(item.index)).map(item => item.line)
  const unmatchedCurrent = current.filter(item => !paired.has(item.index)).map(item => item.line)
  if (unmatchedPrevious.length === 0 && unmatchedCurrent.length === 0) return { pairs, conflict: null }

  const reason = previous[0].line.variantId != null
    ? 'AMBIGUOUS_VARIANT'
    : previous[0].line.sku
      ? 'AMBIGUOUS_SKU'
      : 'AMBIGUOUS_SPECIAL_LINE'
  return { pairs, conflict: { reason, previousLines: unmatchedPrevious, currentLines: unmatchedCurrent } }
}

function differenceForPair(previous: PreparationCommercialLine, current: PreparationCommercialLine): CommercialLineDifference[] {
  const fields = changedFields(previous, current)
  if (fields.length === 0) return []
  const quantityChanged = fields.includes('quantity')
  const valueChanged = fields.some(field => ['unitNetValue', 'lineNetAmount', 'lineTaxAmount', 'lineGrossAmount'].includes(field))
  const result: CommercialLineDifference[] = []
  if (quantityChanged) {
    result.push({
      kind: current.quantity > previous.quantity ? 'QUANTITY_INCREASED' : 'QUANTITY_DECREASED',
      previous, current, quantityDelta: current.quantity - previous.quantity,
      changedFields: fields, confidence: 'CERTAIN',
    })
  }
  if (valueChanged || fields.includes('sku')) {
    result.push({ kind: 'VALUE_CHANGED', previous, current, quantityDelta: null, changedFields: fields, confidence: 'CERTAIN' })
  }
  return result
}

function totals(version: PreparationCommercialVersion) {
  return {
    netAmount: normalizeNumber(version.netAmount),
    taxAmount: normalizeNumber(version.taxAmount),
    totalAmount: normalizeNumber(version.totalAmount),
  }
}

export function compareCommercialVersions(
  previous: PreparationCommercialVersion,
  current: PreparationCommercialVersion,
): CommercialComparisonResult {
  const previousFingerprint = fingerprintCommercialVersion(previous)
  const currentFingerprint = fingerprintCommercialVersion(current)
  const sameIdentity = previous.identity.canonicalToken === current.identity.canonicalToken
  const oldLines = previous.lines.map(normalizeLine)
  const newLines = current.lines.map(normalizeLine)
  const oldGroups = new Map<string, IndexedLine[]>()
  const newGroups = new Map<string, IndexedLine[]>()
  const unkeyedOld: IndexedLine[] = []
  const unkeyedNew: IndexedLine[] = []
  oldLines.forEach((line, index) => {
    const key = matchKey(line)
    if (!key) unkeyedOld.push({ line, index })
    else oldGroups.set(key, [...(oldGroups.get(key) ?? []), { line, index }])
  })
  newLines.forEach((line, index) => {
    const key = matchKey(line)
    if (!key) unkeyedNew.push({ line, index })
    else newGroups.set(key, [...(newGroups.get(key) ?? []), { line, index }])
  })

  const differences: CommercialLineDifference[] = []
  const conflicts: CommercialMatchConflict[] = []
  const matchedOld = new Set<number>()
  const matchedNew = new Set<number>()
  const keys = [...new Set([...oldGroups.keys(), ...newGroups.keys()])].sort()
  for (const key of keys) {
    const oldGroup = oldGroups.get(key) ?? []
    const newGroup = newGroups.get(key) ?? []
    const matching = pairGroup(oldGroup, newGroup)
    conflicts.push(...(matching.conflict ? [matching.conflict] : []))
    for (const [oldItem, newItem] of matching.pairs) {
      matchedOld.add(oldItem.index)
      matchedNew.add(newItem.index)
      differences.push(...differenceForPair(oldItem.line, newItem.line))
    }
  }

  const unkeyedMatching = pairGroup(unkeyedOld, unkeyedNew)
  conflicts.push(...(unkeyedMatching.conflict ? [unkeyedMatching.conflict] : []))
  for (const [oldItem, newItem] of unkeyedMatching.pairs) {
    matchedOld.add(oldItem.index)
    matchedNew.add(newItem.index)
    differences.push(...differenceForPair(oldItem.line, newItem.line))
  }

  for (const [index, line] of oldLines.entries()) {
    if (!matchedOld.has(index)) differences.push({ kind: 'REMOVED', previous: line, current: null, quantityDelta: null, changedFields: [], confidence: 'CERTAIN' })
  }
  for (const [index, line] of newLines.entries()) {
    if (!matchedNew.has(index)) differences.push({ kind: 'ADDED', previous: null, current: line, quantityDelta: null, changedFields: [], confidence: 'CERTAIN' })
  }

  // A substitution is only asserted when Bsale preserves an unambiguous line position.
  const removed = differences.filter(item => item.kind === 'REMOVED' && item.previous?.lineNumber != null)
  const added = differences.filter(item => item.kind === 'ADDED' && item.current?.lineNumber != null)
  for (const oldItem of removed) {
    if (removed.length !== 1 || added.length !== 1) continue
    const candidates = added.filter(newItem => newItem.current?.lineNumber === oldItem.previous?.lineNumber)
    if (candidates.length !== 1) continue
    const replacement = candidates[0]
    const oldIndex = differences.indexOf(oldItem)
    const newIndex = differences.indexOf(replacement)
    differences[oldIndex] = {
      kind: 'SUBSTITUTION', previous: oldItem.previous, current: replacement.current,
      quantityDelta: null, changedFields: ['variantId', 'sku', 'productName'], confidence: 'CERTAIN',
    }
    differences.splice(newIndex > oldIndex ? newIndex : newIndex + 1, 1)
  }

  const oldTotals = totals(previous)
  const newTotals = totals(current)
  return {
    sameIdentity,
    identity: current.identity,
    previousFingerprint,
    currentFingerprint,
    contentEquivalent: sameIdentity && previousFingerprint.value === currentFingerprint.value,
    differences,
    conflicts: sameIdentity ? conflicts : [{ reason: 'IDENTITY_MISMATCH', previousLines: oldLines, currentLines: newLines }],
    totals: {
      previous: oldTotals,
      current: newTotals,
      totalDelta: oldTotals.totalAmount == null || newTotals.totalAmount == null ? null : newTotals.totalAmount - oldTotals.totalAmount,
    },
  }
}
