const CREDIT_NOTE_PATTERNS = [
  'NOTA DE CRÉDITO',
  'NOTA CREDITO',
  'NOTA DE CREDITO',
  'NOTA CRÉDITO',
]

export function isCreditNote(documentLabel: string | null | undefined): boolean {
  if (!documentLabel) return false
  const upper = documentLabel.toUpperCase().trim()
  return CREDIT_NOTE_PATTERNS.some(pattern => upper.includes(pattern))
}

export function getPurchaseReceptionSign(reception: { document?: string | null }): 1 | -1 {
  return isCreditNote(reception.document) ? -1 : 1
}
