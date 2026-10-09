export type NonPnlMovementSubtype = 'LOAN_RECEIPT' | 'CREDIT_LINE_DRAW' | 'LOAN_PAYMENT' | 'CREDIT_LINE_PAYMENT' | null

function normalizeBankOperation(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function consolidatedNonPnlImpact(input: { categoryCode: string; direction: string | null; amount: number }) {
  if (input.categoryCode === 'INCOME_INTERNAL_TRANSFER' || input.categoryCode === 'EXPENSE_INTERNAL_TRANSFER' || input.categoryCode === 'INCOME_INTERCOMPANY' || input.categoryCode === 'EXPENSE_INTERCOMPANY') return 0
  return input.direction === 'HABER' ? input.amount : -input.amount
}

export function classifyNonPnlMovement(description: string | null | undefined): NonPnlMovementSubtype {
  const normalized = normalizeBankOperation(description)
  if (/^CARGO CTA ?CTE POR TRASPASO LC/.test(normalized)) return 'CREDIT_LINE_PAYMENT'
  if (normalized.startsWith('ABONO DESDE LINEA DE CREDITO')) return 'CREDIT_LINE_DRAW'
  if (normalized.startsWith('PRESTAMO')) return 'LOAN_RECEIPT'
  if (normalized.startsWith('PAGO DE CREDITOS') || normalized.startsWith('PAGO PRESTAMO') || normalized.startsWith('CUOTA PRESTAMO')) return 'LOAN_PAYMENT'
  return null
}
