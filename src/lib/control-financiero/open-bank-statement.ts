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

function finalCloseEconomicKey(
  accountId: string,
  movement: Pick<ParsedBankMovement, 'date' | 'description' | 'debit' | 'credit' | 'balance'>,
) {
  return [
    accountId,
    movement.date,
    canonical(movement.description),
    numericCanonical(movement.debit),
    numericCanonical(movement.credit),
    numericCanonical(movement.balance),
  ].join('|')
}

function finalCloseExistingEconomicKey(
  accountId: string,
  movement: Pick<ExistingFinalCloseMovement, 'transaction_date' | 'operation_description' | 'debit_amount' | 'credit_amount' | 'balance_after'>,
) {
  return finalCloseEconomicKey(accountId, {
    date: movement.transaction_date,
    description: movement.operation_description,
    debit: Number(movement.debit_amount),
    credit: Number(movement.credit_amount),
    balance: Number(movement.balance_after),
  })
}

function finalCloseEconomicBase(
  accountId: string,
  movement: Pick<ParsedBankMovement, 'date' | 'description'>,
) {
  return [accountId, movement.date, canonical(movement.description)].join('|')
}

function finalCloseExistingBase(
  accountId: string,
  movement: Pick<ExistingFinalCloseMovement, 'transaction_date' | 'operation_description'>,
) {
  return finalCloseEconomicBase(accountId, {
    date: movement.transaction_date,
    description: movement.operation_description,
  })
}

/** Matches a definitive semicolon export to OPEN rows without format metadata. */
export function compareFinalCloseMovements(
  accountId: string,
  movements: ParsedBankMovement[],
  existing: ExistingFinalCloseMovement[],
): FinalCloseDiff {
  const exact = new Map<string, number[]>()
  const base = new Map<string, number[]>()
  existing.forEach((row, index) => {
    const exactKey = finalCloseExistingEconomicKey(accountId, row)
    exact.set(exactKey, [...(exact.get(exactKey) ?? []), index])
    const baseKey = finalCloseExistingBase(accountId, row)
    base.set(baseKey, [...(base.get(baseKey) ?? []), index])
  })
  const used = new Set<number>()
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
  movements.forEach((movement, index) => {
    const exactCandidates = exact.get(finalCloseEconomicKey(accountId, movement)) ?? []
    const availableExact = exactCandidates.filter(candidate => !used.has(candidate))
    if (availableExact.length === 1 && exactCandidates.length === 1) {
      const existingIndex = availableExact[0]
      used.add(existingIndex)
      result.matchedExisting += 1
      result.matchedByFile.set(index, existing[existingIndex])
      return
    }
    if (exactCandidates.length > 0) {
      result.ambiguous.push(index)
      return
    }
    const baseCandidates = base.get(finalCloseEconomicBase(accountId, movement)) ?? []
    const availableBase = baseCandidates.filter(candidate => !used.has(candidate))
    if (availableBase.length > 1) {
      result.ambiguous.push(index)
    } else if (availableBase.length === 1) {
      result.conflicts.push(index)
    } else {
      result.newRows.push(index)
    }
  })
  existing.forEach((_row, index) => {
    if (!used.has(index)) result.existingMissing.push(index)
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
