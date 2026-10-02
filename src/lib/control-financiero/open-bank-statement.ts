import { createHash } from 'node:crypto'
import type { ParsedBankMovement } from './bank-statement-parser'

export type OpenMovementKey = {
  movement_identity: string
  movement_content_hash: string
}

function canonical(value: unknown) { return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase() }

function numericCanonical(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : canonical(value)
}

function digest(parts: unknown[]) { return createHash('sha256').update(parts.map(canonical).join('|')).digest('hex') }

/**
 * Uses bank identifiers when present. Current Banco de Chile exports omit both
 * Trn and Docto for many transfers, so identical fallback rows are disambiguated
 * by their occurrence in the bank's sequential file order.
 */
export function buildOpenMovementKeys(accountId: string, movements: ParsedBankMovement[]): OpenMovementKey[] {
  const occurrences = new Map<string, number>()
  return movements.map(movement => {
    const stableId = canonical(movement.transactionNumber || movement.documentNumber)
    const base = [accountId, movement.date, movement.description, movement.branch, stableId]
    const occurrenceKey = base
    const occurrence = (occurrences.get(occurrenceKey.map(canonical).join('|')) ?? 0) + 1
    occurrences.set(occurrenceKey.map(canonical).join('|'), occurrence)
    const movement_identity = digest(['movement-identity-v1', ...base, occurrence])
    const movement_content_hash = digest([
      'movement-content-v1', accountId, movement.date, movement.description, movement.branch,
      movement.documentNumber, movement.transactionNumber, movement.cashier, movement.debit,
      movement.credit, movement.balance,
    ])
    return { movement_identity, movement_content_hash }
  })
}

export type ExistingOpenMovement = {
  movement_identity: string
  movement_content_hash: string
}

export type ExistingFinalCloseMovement = ExistingOpenMovement & {
  transaction_date: string
  operation_description: string
  credit_amount: number | string
  debit_amount: number | string
  balance_after: number | string
  source_row_number: number
  document_number?: string | null
}

export type FinalCloseDiff = {
  matchedExisting: number
  newRows: number[]
  conflicts: number[]
  existingMissing: number[]
  ambiguous: number[]
  newIndexes: number[]
  conflictIndexes: number[]
  existingMissingIndexes: number[]
  ambiguousIndexes: number[]
  matchedByFile: Map<number, ExistingFinalCloseMovement>
}

function normalizeFinalCloseDescription(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s*:\s*/g, ':')
    .replace(/\*+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function finalCloseDescriptionsCompatible(existing: unknown, file: unknown) {
  const normalizedExisting = normalizeFinalCloseDescription(existing)
  const normalizedFile = normalizeFinalCloseDescription(file)
  return Boolean(
    normalizedExisting &&
      normalizedFile &&
      (normalizedExisting === normalizedFile ||
        normalizedExisting.startsWith(normalizedFile) ||
        normalizedFile.startsWith(normalizedExisting)),
  )
}

function finalCloseBucketKey(
  accountId: string,
  movement: Pick<ParsedBankMovement, 'date' | 'debit' | 'credit'>,
) {
  return [
    accountId,
    movement.date,
    numericCanonical(movement.debit),
    numericCanonical(movement.credit),
  ].join('|')
}

function finalCloseExistingBucketKey(
  accountId: string,
  movement: Pick<ExistingFinalCloseMovement, 'transaction_date' | 'debit_amount' | 'credit_amount'>,
) {
  return finalCloseBucketKey(accountId, {
    date: movement.transaction_date,
    debit: Number(movement.debit_amount),
    credit: Number(movement.credit_amount),
  })
}

function finalCloseDocumentMatches(existing: ExistingFinalCloseMovement, file: ParsedBankMovement) {
  const existingDocument = String(existing.document_number ?? '').replace(/\D/g, '')
  const fileDocument = String(file.documentNumber ?? '').replace(/\D/g, '')
  return Boolean(existingDocument && fileDocument && !/^0+$/.test(existingDocument) && !/^0+$/.test(fileDocument) && existingDocument === fileDocument)
}

/** Matches definitive rows as a multiset, independent of intraday balance order. */
export function compareFinalCloseMovements(
  accountId: string,
  movements: ParsedBankMovement[],
  existing: ExistingFinalCloseMovement[],
): FinalCloseDiff {
  const existingBuckets = new Map<string, number[]>()
  const fileBuckets = new Map<string, number[]>()
  existing.forEach((row, index) => {
    const key = finalCloseExistingBucketKey(accountId, row)
    existingBuckets.set(key, [...(existingBuckets.get(key) ?? []), index])
  })
  movements.forEach((row, index) => {
    const key = finalCloseBucketKey(accountId, row)
    fileBuckets.set(key, [...(fileBuckets.get(key) ?? []), index])
  })
  const newRows: number[] = []
  const conflicts: number[] = []
  const existingMissing: number[] = []
  const ambiguous: number[] = []
  const result: FinalCloseDiff = {
    matchedExisting: 0,
    newRows,
    conflicts,
    existingMissing,
    ambiguous,
    newIndexes: newRows,
    conflictIndexes: conflicts,
    existingMissingIndexes: existingMissing,
    ambiguousIndexes: ambiguous,
    matchedByFile: new Map(),
  }
  const matchedExistingIndexes = new Set<number>()
  const bucketKeys = new Set([...existingBuckets.keys(), ...fileBuckets.keys()])
  for (const key of bucketKeys) {
    const existingIndexes = [...(existingBuckets.get(key) ?? [])].sort(
      (left, right) => existing[left].source_row_number - existing[right].source_row_number || left - right,
    )
    const fileIndexes = [...(fileBuckets.get(key) ?? [])].sort((left, right) => left - right)
    if (!existingIndexes.length) {
      newRows.push(...fileIndexes)
      continue
    }
    const fileToExisting = new Map<number, number>()
    const compatibleFiles = (existingIndex: number) => fileIndexes
      .filter(fileIndex => finalCloseDescriptionsCompatible(existing[existingIndex].operation_description, movements[fileIndex].description))
      .sort((left, right) => {
        const documentDifference = Number(finalCloseDocumentMatches(existing[existingIndex], movements[right])) - Number(finalCloseDocumentMatches(existing[existingIndex], movements[left]))
        return documentDifference || left - right
      })
    const assign = (existingPosition: number, seen: Set<number>): boolean => {
      const existingIndex = existingIndexes[existingPosition]
      for (const fileIndex of compatibleFiles(existingIndex)) {
        if (seen.has(fileIndex)) continue
        seen.add(fileIndex)
        const previousExistingPosition = fileToExisting.get(fileIndex)
        if (previousExistingPosition === undefined || assign(previousExistingPosition, seen)) {
          fileToExisting.set(fileIndex, existingPosition)
          return true
        }
      }
      return false
    }
    existingIndexes.forEach((_existingIndex, existingPosition) => assign(existingPosition, new Set()))
    for (const [fileIndex, existingPosition] of fileToExisting) {
      const existingIndex = existingIndexes[existingPosition]
      matchedExistingIndexes.add(existingIndex)
      result.matchedExisting += 1
      result.matchedByFile.set(fileIndex, existing[existingIndex])
    }
    const matchedFileIndexes = new Set(fileToExisting.keys())
    const matchedCount = matchedFileIndexes.size
    for (const fileIndex of fileIndexes) {
      if (matchedFileIndexes.has(fileIndex)) continue
      const hasCompatibleExisting = existingIndexes.some(existingIndex =>
        finalCloseDescriptionsCompatible(existing[existingIndex].operation_description, movements[fileIndex].description),
      )
      if (fileIndexes.length > existingIndexes.length) {
        if (hasCompatibleExisting || matchedCount === existingIndexes.length) newRows.push(fileIndex)
        else conflicts.push(fileIndex)
      } else if (hasCompatibleExisting) {
        ambiguous.push(fileIndex)
      } else {
        conflicts.push(fileIndex)
      }
    }
  }
  existing.forEach((_row, index) => {
    if (!matchedExistingIndexes.has(index)) existingMissing.push(index)
  })
  return result
}

export type OpenDiff = {
  existing: number
  new: number
  conflicts: number
  newIndexes: number[]
  conflictIndexes: number[]
}

export function compareOpenMovements(keys: OpenMovementKey[], existing: ExistingOpenMovement[]): OpenDiff {
  const existingByIdentity = new Map(existing.map(row => [row.movement_identity, row.movement_content_hash]))
  const seen = new Set<string>()
  const result: OpenDiff = { existing: 0, new: 0, conflicts: 0, newIndexes: [], conflictIndexes: [] }
  keys.forEach((key, index) => {
    const previous = existingByIdentity.get(key.movement_identity)
    if (previous === undefined && !seen.has(key.movement_identity)) {
      result.new += 1
      result.newIndexes.push(index)
    } else if (previous === key.movement_content_hash) {
      result.existing += 1
    } else {
      result.conflicts += 1
      result.conflictIndexes.push(index)
    }
    seen.add(key.movement_identity)
  })
  return result
}
