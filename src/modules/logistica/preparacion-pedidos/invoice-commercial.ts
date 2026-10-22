export type InvoicePaymentTypeOption = {
  bsale_id: number
  name: string
}

export type InvoiceSaleConditionOption = {
  bsale_id: number
  name: string
  time_condition: number | null
  time_unity: number | null
}

export type InvoiceCommercialSelection = {
  payment_type_id: number | null
  sale_condition_id: number | null
  expiration_date: string | null
}

export type InvoiceDraftPayload = {
  payments: Array<{
    paymentTypeId: number
    amount: number
    recordDate: number
  }>
  expirationDate: number | null
}

export function calculateInvoiceExpirationDate(
  emissionDate: string | null,
  condition: Pick<InvoiceSaleConditionOption, 'time_condition' | 'time_unity'> | null,
): string | null {
  if (!emissionDate) return null
  if (!condition) return emissionDate
  if (condition.time_condition == null || condition.time_unity == null) return null
  const date = new Date(`${emissionDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null

  if (condition.time_unity === 0) {
    date.setUTCDate(date.getUTCDate() + condition.time_condition)
  } else if (condition.time_unity === 1) {
    date.setUTCMonth(date.getUTCMonth() + condition.time_condition)
  } else {
    return null
  }

  return date.toISOString().slice(0, 10)
}

export function buildInvoiceDraftPayload(
  selection: InvoiceCommercialSelection,
  totalAmount: number | null,
  emissionDate: string | null,
): InvoiceDraftPayload | null {
  if (selection.payment_type_id == null || totalAmount == null || selection.expiration_date == null || emissionDate == null) return null
  const recordDate = new Date(`${emissionDate}T00:00:00Z`)
  const expirationDate = new Date(`${selection.expiration_date}T00:00:00Z`)
  if (Number.isNaN(recordDate.getTime()) || Number.isNaN(expirationDate.getTime())) return null

  return {
    payments: [{
      paymentTypeId: selection.payment_type_id,
      amount: totalAmount,
      recordDate: Math.floor(recordDate.getTime() / 1000),
    }],
    expirationDate: Math.floor(expirationDate.getTime() / 1000),
  }
}
