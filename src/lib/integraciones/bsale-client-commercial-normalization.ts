export type BsaleClientCommercialCatalogs = {
  paymentTypeNames?: ReadonlyMap<number, string>
  saleConditionNames?: ReadonlyMap<number, string>
}

export function extractBsaleRelationIdFromHref(value: unknown, relation: 'payment_types' | 'sale_conditions' | 'price_lists'): number | null {
  if (!value || typeof value !== 'object') return null
  const href = (value as { href?: unknown }).href
  if (typeof href !== 'string') return null
  const match = href.match(new RegExp(`/${relation}/(\\d+)\\.json$`))
  return match ? Number(match[1]) : null
}

export function normalizeBsaleClientCommercialFields(
  client: Record<string, any>,
  catalogs: BsaleClientCommercialCatalogs = {},
) {
  const paymentTypeId = extractBsaleRelationIdFromHref(client.payment_type, 'payment_types')
  const saleConditionId = extractBsaleRelationIdFromHref(client.sale_condition, 'sale_conditions')
  const priceListId = extractBsaleRelationIdFromHref(client.price_list, 'price_lists')

  return {
    payment_type_id: paymentTypeId,
    payment_type_name: paymentTypeId == null ? null : catalogs.paymentTypeNames?.get(paymentTypeId) ?? null,
    sale_condition_id: saleConditionId,
    sale_condition_name: saleConditionId == null ? null : catalogs.saleConditionNames?.get(saleConditionId) ?? null,
    has_credit: client.hasCredit === 1 || client.hasCredit === true,
    credit_limit: client.maxCredit == null || client.maxCredit === '' ? null : Number(client.maxCredit),
    price_list_id: priceListId,
    price_list_name: typeof client.price_list?.name === 'string' && client.price_list.name.trim() ? client.price_list.name.trim() : null,
    region: typeof client.region === 'string' && client.region.trim() ? client.region.trim() : null,
  }
}
