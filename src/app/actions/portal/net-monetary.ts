export type PortalDocumentMoney = {
  total_amount: number | string | null
  net_amount: number | string | null
  exempt_amount: number | string | null
}

export function netAmountForGross(amount: number, document: PortalDocumentMoney): number {
  const totalAmount = Number(document.total_amount ?? 0)
  const netBase = Number(document.net_amount ?? 0) + Number(document.exempt_amount ?? 0)

  if (!Number.isFinite(amount) || !Number.isFinite(netBase)) return 0
  if (totalAmount > 0 && Number.isFinite(totalAmount)) return amount * (netBase / totalAmount)
  return netBase
}
