import type { InvoiceCommercialSelection } from '@/modules/logistica/preparacion-pedidos/invoice-commercial'

type Predicate = {
  name: string
  expression: string
  actual: unknown
  result: boolean
}

export type InvoiceCommercialValidationResult = {
  selectedPaymentTypeId: number | null
  saleConditionId: number | null
  confirmedExpirationDate: string | null | undefined
  requiredFields: Predicate[]
  commercialPredicates: Predicate[]
  missingCommercialFields: boolean
  commercialBlockTriggered: boolean
}

function relationId(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const relation = value as { id?: unknown; href?: unknown }
  const direct = Number(relation.id)
  if (Number.isSafeInteger(direct) && direct > 0) return direct
  const match = typeof relation.href === 'string' ? /\/([0-9]+)(?:\.json)?$/.exec(relation.href) : null
  const fromHref = Number(match?.[1])
  return Number.isSafeInteger(fromHref) && fromHref > 0 ? fromHref : null
}

export function evaluateInvoiceCommercialValidation(input: {
  currentNvId: number
  nv: Record<string, any>
  sellers: Record<string, any>
  paymentTypes: Record<string, any>
  saleConditions: Record<string, any>
  client: Record<string, any> | null
  clientError: boolean
  syncedClientError: boolean
  paymentTypeId: number | null
  selection: InvoiceCommercialSelection | null
}): InvoiceCommercialValidationResult {
  const { nv, sellers, paymentTypes, saleConditions, selection } = input
  const details = Array.isArray(nv.details?.items) ? nv.details.items : []
  const sellerItems = sellers.items ?? []
  const clientId = Number(nv.client?.id)
  const officeId = Number(nv.office?.id)
  const priceListId = Number(nv.priceList?.id)
  const saleConditionId = selection?.sale_condition_id ?? relationId(nv.saleCondition ?? nv.sale_condition)
  const selectedPaymentTypeId = selection?.payment_type_id ?? input.paymentTypeId
  const catalogPaymentTypeId = selectedPaymentTypeId ?? -1
  const catalogSaleConditionId = saleConditionId ?? -1
  const confirmedExpirationDate = selection?.expiration_date

  const requiredFields: Predicate[] = [
    { name: 'forma de pago presente', expression: 'selectedPaymentTypeId != null', actual: selectedPaymentTypeId, result: selectedPaymentTypeId != null },
    { name: 'forma de pago entero seguro positivo', expression: 'Number.isSafeInteger(selectedPaymentTypeId) && selectedPaymentTypeId > 0', actual: selectedPaymentTypeId, result: selectedPaymentTypeId != null && Number.isSafeInteger(selectedPaymentTypeId) && selectedPaymentTypeId > 0 },
    { name: 'condición presente', expression: 'saleConditionId != null', actual: saleConditionId, result: saleConditionId != null },
    { name: 'condición entero seguro positivo', expression: 'Number.isSafeInteger(saleConditionId) && saleConditionId > 0', actual: saleConditionId, result: saleConditionId != null && Number.isSafeInteger(saleConditionId) && saleConditionId > 0 },
    { name: 'vencimiento confirmado', expression: '!confirmedExpirationDate', actual: confirmedExpirationDate, result: Boolean(confirmedExpirationDate) },
  ]

  const commercialPredicates: Predicate[] = [
    { name: 'clientError', expression: 'clientError', actual: input.clientError, result: input.clientError },
    { name: 'syncedClientError', expression: 'syncedClientError', actual: input.syncedClientError, result: input.syncedClientError },
    { name: 'cliente coincide', expression: 'Number(client?.id) !== clientId', actual: { clientId, returnedId: input.client?.id ?? null }, result: Number(input.client?.id) !== clientId },
    { name: 'cliente ID entero seguro', expression: '!Number.isSafeInteger(clientId)', actual: clientId, result: !Number.isSafeInteger(clientId) },
    { name: 'oficina ID entero seguro', expression: '!Number.isSafeInteger(officeId)', actual: officeId, result: !Number.isSafeInteger(officeId) },
    { name: 'lista de precios ID entero seguro', expression: '!Number.isSafeInteger(priceListId)', actual: priceListId, result: !Number.isSafeInteger(priceListId) },
    { name: 'documento coincide', expression: 'Number(nv.id) !== currentNvId', actual: { documentId: nv.id ?? null, currentNvId: input.currentNvId }, result: Number(nv.id) !== input.currentNvId },
    { name: 'tipo documental es 23', expression: 'Number(nv.document_type?.id) !== 23', actual: nv.document_type?.id ?? null, result: Number(nv.document_type?.id) !== 23 },
    { name: 'estado es 0', expression: 'Number(nv.state) !== 0', actual: nv.state ?? null, result: Number(nv.state) !== 0 },
    { name: 'exactamente un vendedor', expression: 'sellerItems.length !== 1', actual: sellerItems.length, result: sellerItems.length !== 1 },
    { name: 'payment_types.items es arreglo', expression: '!Array.isArray(paymentTypes.items)', actual: Array.isArray(paymentTypes.items), result: !Array.isArray(paymentTypes.items) },
    { name: 'forma de pago está en catálogo', expression: '!paymentTypes.items.some(item => Number(item.id) === selectedPaymentTypeId)', actual: { selectedPaymentTypeId, catalogCount: Array.isArray(paymentTypes.items) ? paymentTypes.items.length : null }, result: !Array.isArray(paymentTypes.items) || !paymentTypes.items.some((item: Record<string, any>) => Number(item.id) === catalogPaymentTypeId) },
    { name: 'sale_conditions.items es arreglo', expression: '!Array.isArray(saleConditions.items)', actual: Array.isArray(saleConditions.items), result: !Array.isArray(saleConditions.items) },
    { name: 'condición está en catálogo', expression: '!saleConditions.items.some(item => Number(item.id) === saleConditionId)', actual: { saleConditionId, catalogCount: Array.isArray(saleConditions.items) ? saleConditions.items.length : null }, result: !Array.isArray(saleConditions.items) || !saleConditions.items.some((item: Record<string, any>) => Number(item.id) === catalogSaleConditionId) },
  ]

  return {
    selectedPaymentTypeId,
    saleConditionId,
    confirmedExpirationDate,
    requiredFields,
    commercialPredicates,
    missingCommercialFields: requiredFields.some(predicate => !predicate.result),
    commercialBlockTriggered: commercialPredicates.some(predicate => predicate.result),
  }
}
