import type { PotentialStop } from './delivery-stops'
import type { DocumentReference } from './types'

export function formatRouteDocument(document: DocumentReference): string {
  const label = document.type === 'SALES_ORDER' ? 'NV' : 'Factura'
  if (document.folio) return `${label} #${document.folio}`
  return document.id != null ? `${label} · ID ${document.id}` : `${label} sin identidad`
}

/** Prepara solo presentación; conserva las entregas y sus referencias originales. */
export function presentPotentialStop(stop: PotentialStop, warningsByCardId: Record<string, string[]>) {
  const first = stop.deliveries[0]
  const rows = stop.deliveries.map(delivery => ({
    delivery,
    documents: delivery.documents.map(document => ({ document, label: formatRouteDocument(document) })),
    warnings: [...new Set(warningsByCardId[delivery.source.recordId] ?? [])],
  }))
  const otherWarnings = rows.slice(1).map(row => new Set(row.warnings))
  const commonWarnings = (rows[0]?.warnings ?? []).filter(warning => otherWarnings.every(warnings => warnings.has(warning)))
  const commonSet = new Set(commonWarnings)
  const documentKeys = new Set<string>()
  rows.forEach((row, rowIndex) => row.documents.forEach(({ document }, documentIndex) => {
    const identity = document.id != null ? ['id', document.id] : document.folio ? ['folio', document.folio] : ['unknown', rowIndex, documentIndex]
    documentKeys.add(JSON.stringify([document.system, document.type, ...identity]))
  }))
  return {
    customerName: first?.customer.name || 'Cliente sin nombre',
    address: first?.destination.address || 'Sin dirección',
    commune: first?.destination.commune || 'Sin comuna',
    documentCount: documentKeys.size,
    commonWarnings,
    rows: rows.map(row => ({ ...row, individualWarnings: row.warnings.filter(warning => !commonSet.has(warning)) })),
  }
}
