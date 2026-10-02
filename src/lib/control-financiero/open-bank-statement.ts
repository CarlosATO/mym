import { createHash } from 'node:crypto'
import type { ParsedBankMovement } from './bank-statement-parser'

export type OpenMovementKey = {
  movement_identity: string
  movement_content_hash: string
}

function canonical(value: unknown) { return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase() }

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
