export const CONTRACT_TYPES = [
  { value: 'INDEFINIDO', label: 'Indefinido' },
  { value: 'PLAZO_FIJO', label: 'Plazo fijo' },
  { value: 'OBRA_FAENA', label: 'Por obra o faena' },
  { value: 'APRENDIZAJE', label: 'Aprendizaje' },
] as const

export type ContractType = (typeof CONTRACT_TYPES)[number]['value']

export function isContractType(value: string): value is ContractType {
  return CONTRACT_TYPES.some(option => option.value === value)
}

export function contractTypeLabel(value: string | null | undefined) {
  return CONTRACT_TYPES.find(option => option.value === value)?.label ?? '—'
}
