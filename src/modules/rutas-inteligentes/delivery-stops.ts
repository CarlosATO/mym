import type { DocumentReference, EvaluationDelivery } from './types'

export type DeliveryIssue =
  | 'MISSING_ADDRESS'
  | 'AMBIGUOUS_ADDRESS'
  | 'MISSING_COMMUNE'
  | 'AMBIGUOUS_COMMUNE'
  | 'MISSING_CUSTOMER_ID'
  | 'MISSING_DOCUMENT_IDENTITY'
  | 'DUPLICATE_DOCUMENT'
  | 'INVALID_SOURCE_FIELD'

export type PotentialStop = {
  id: string
  customerId: number
  normalizedAddress: string
  normalizedCommune: string
  durationMinutes: number
  /** Cada entrega conserva sus documentos y sus montos originales. */
  deliveries: EvaluationDelivery[]
}

export type UnresolvedDelivery = {
  id: string
  delivery: EvaluationDelivery
  issues: DeliveryIssue[]
}

export type DeliveryStopsResult = {
  stops: PotentialStop[]
  unresolved: UnresolvedDelivery[]
}

// Solo equivalencias inequívocas: no elimina acentos, signos ni abreviaturas.
function normalize(value: string | null): string {
  return (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es-CL')
}

function sourceKey(delivery: EvaluationDelivery): string {
  return JSON.stringify([delivery.source.type, delivery.source.recordId])
}

function documentKeys(document: DocumentReference): string[] {
  const keys: string[] = []
  if (Number.isSafeInteger(document.id) && document.id! > 0) keys.push(JSON.stringify([document.system, document.type, 'id', document.id]))
  const folio = normalize(document.folio)
  if (folio) keys.push(JSON.stringify([document.system, document.type, 'folio', folio]))
  return keys
}

/**
 * Recibe entregas de una única empresa. No calcula totales: los montos quedan
 * una sola vez en cada entrega. Una referencia repetida de NV (o factura si
 * no hay NV) deja todas las entregas involucradas pendientes de revisión.
 */
export function buildDeliveryStops(
  deliveries: readonly EvaluationDelivery[],
  options: { durationMinutes?: number } = {},
): DeliveryStopsResult {
  const durationMinutes = options.durationMinutes ?? 20
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error('Duración de parada inválida')

  const sources = new Set<string>()
  const documentOwners = new Map<string, string>()
  const duplicateSources = new Set<string>()
  const invoiceOwners = new Map<string, { withSalesOrder: Set<string>; invoiceOnly: Set<string> }>()
  for (const delivery of deliveries) {
    const source = sourceKey(delivery)
    if (!delivery.source.recordId.trim() || sources.has(source)) throw new Error('Identidad de origen ausente o duplicada')
    sources.add(source)
    const salesOrders = delivery.documents.filter(document => document.type === 'SALES_ORDER')
    const commercialDocuments = salesOrders.length ? salesOrders : delivery.documents.filter(document => document.type === 'INVOICE')
    const keys = new Set(commercialDocuments.flatMap(documentKeys))
    for (const key of keys) {
      const owner = documentOwners.get(key)
      if (owner !== undefined && owner !== source) {
        duplicateSources.add(owner)
        duplicateSources.add(source)
      } else {
        documentOwners.set(key, source)
      }
    }
    const invoiceKeys = new Set(delivery.documents.filter(document => document.type === 'INVOICE').flatMap(documentKeys))
    for (const key of invoiceKeys) {
      const owners = invoiceOwners.get(key) ?? { withSalesOrder: new Set<string>(), invoiceOnly: new Set<string>() }
      if (salesOrders.length) owners.withSalesOrder.add(source)
      else owners.invoiceOnly.add(source)
      invoiceOwners.set(key, owners)
    }
  }
  // Varias NV pueden apuntar a una misma factura; solo hay conflicto cuando
  // además se contabiliza esa factura como entrega comercial independiente.
  for (const owners of invoiceOwners.values()) {
    if (owners.invoiceOnly.size && owners.withSalesOrder.size) {
      for (const source of owners.invoiceOnly) duplicateSources.add(source)
      for (const source of owners.withSalesOrder) duplicateSources.add(source)
    }
  }

  const groups = new Map<string, PotentialStop>()
  const unresolved: UnresolvedDelivery[] = []
  for (const delivery of deliveries) {
    const source = sourceKey(delivery)
    const address = normalize(delivery.destination.address)
    const commune = normalize(delivery.destination.commune)
    const issues: DeliveryIssue[] = []
    if (delivery.invalidSourceFields?.length) issues.push('INVALID_SOURCE_FIELD')
    if (!address) issues.push('MISSING_ADDRESS')
    else if (delivery.destination.addressSource === 'UNKNOWN' || !/\p{L}/u.test(address) || !/\d/u.test(address) || /\b(?:s\s*\/\s*n|sin\s+n[uú]mero|por\s+confirmar)\b/iu.test(address)) issues.push('AMBIGUOUS_ADDRESS')
    if (!commune) issues.push('MISSING_COMMUNE')
    else if (delivery.destination.communeSource === 'CITY_RAW' || delivery.destination.communeSource === 'UNKNOWN' || /^(?:sin comuna|desconocida|por confirmar)$/u.test(commune)) issues.push('AMBIGUOUS_COMMUNE')
    if (delivery.destination.completeness === 'INCOMPLETE' && address && commune && !issues.some(issue => issue.includes('ADDRESS') || issue.includes('COMMUNE'))) issues.push('AMBIGUOUS_ADDRESS')
    const customerId = delivery.customer.id
    if (customerId === null || !Number.isSafeInteger(customerId) || customerId <= 0) issues.push('MISSING_CUSTOMER_ID')
    const salesOrders = delivery.documents.filter(document => document.type === 'SALES_ORDER')
    const commercialDocuments = salesOrders.length ? salesOrders : delivery.documents.filter(document => document.type === 'INVOICE')
    if (!commercialDocuments.some(document => documentKeys(document).length > 0)) issues.push('MISSING_DOCUMENT_IDENTITY')
    if (duplicateSources.has(source)) issues.push('DUPLICATE_DOCUMENT')

    if (issues.length || customerId === null) {
      unresolved.push({ id: `unresolved:${encodeURIComponent(source)}`, delivery, issues })
      continue
    }
    const key = JSON.stringify([customerId, address, commune])
    let stop = groups.get(key)
    if (!stop) {
      stop = { id: `stop:${encodeURIComponent(key)}`, customerId, normalizedAddress: address, normalizedCommune: commune, durationMinutes, deliveries: [] }
      groups.set(key, stop)
    }
    stop.deliveries.push(delivery)
  }

  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  const stops = [...groups.values()].sort((a, b) => compare(a.id, b.id))
  for (const stop of stops) stop.deliveries.sort((a, b) => compare(sourceKey(a), sourceKey(b)))
  unresolved.sort((a, b) => compare(a.id, b.id))
  return { stops, unresolved }
}
