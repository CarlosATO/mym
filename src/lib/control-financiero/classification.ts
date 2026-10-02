import { createHash } from 'node:crypto'

export type BankMovementDirection = 'HABER' | 'DEBE' | 'MIXTO'

export type FinancialCategoryOption = {
  id: string
  parent_id: string | null
  code: string
  name: string
  direction: 'INCOME' | 'EXPENSE' | 'BOTH'
  is_active: boolean
  cash_direction: 'CREDIT' | 'DEBIT' | 'BOTH' | null
}

export function normalizeBankOperation(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function bankMovementDirection(credit: number | string, debit: number | string): BankMovementDirection {
  const hasCredit = Number(credit) > 0
  const hasDebit = Number(debit) > 0
  return hasCredit && hasDebit ? 'MIXTO' : hasCredit ? 'HABER' : 'DEBE'
}

export function eligibleFinancialCategories<T extends FinancialCategoryOption>(
  categories: T[],
  movementDirection: BankMovementDirection | string | null,
) : T[] {
  const activeChildren = new Set(
    categories.filter((category) => category.is_active && category.parent_id).map((category) => category.parent_id),
  )
  return categories.filter((category) => {
    if (!category.is_active || !category.parent_id || activeChildren.has(category.id)) return false
    if (movementDirection === 'DEBE') {
      return ['EXPENSE', 'BOTH'].includes(category.direction) && ['DEBIT', 'BOTH'].includes(category.cash_direction ?? '')
    }
    if (movementDirection === 'HABER') {
      return ['INCOME', 'BOTH'].includes(category.direction) && ['CREDIT', 'BOTH'].includes(category.cash_direction ?? '')
    }
    return movementDirection === 'MIXTO' && category.direction === 'BOTH' && category.cash_direction === 'BOTH'
  })
}

export function buildClassificationSignature(companyId: string, accountId: string, direction: BankMovementDirection, normalizedDescription: string) {
  return createHash('sha256').update([companyId, accountId, direction, normalizedDescription].join('|')).digest('hex')
}
