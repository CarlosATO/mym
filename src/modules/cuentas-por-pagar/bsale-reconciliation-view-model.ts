import type {
  BsaleBodegaReconciliationReport,
  ReconciledInvoiceEntry,
} from './bsale-bodega-reconciliation'
import type { InvoiceFinancialStatusOverlay } from './bsale-financial-balance-resolver'
import { formatClp, formatRut } from './validation-rules'

export const HISTORICAL_PAYMENT_PENDING_LABEL =
  'Situación de pago pendiente de conciliación histórica'

export const HISTORICAL_PAYMENT_PENDING_DESCRIPTION =
  'Los saldos, estados de pago y registro de abonos se habilitarán una vez cargado y conciliado el historial de pagos.'

export type FinancialInboxGroup =
  | 'CONFIRMED_DEBT'
  | 'TO_PAY_EXCEL'
  | 'PAID'
  | 'UNCLASSIFIED'

export type FinancialPrimaryFilterValue =
  | 'TO_PAY'
  | 'PAID'
  | 'UNCLASSIFIED'
  | 'ALL'

export interface FinancialInboxSummaryCounts {
  totalInvoices: number
  confirmedDebtCount: number
  confirmedDebtTotalClp: number
  historicalExcelPendingCount: number
  historicalExcelPendingTotalClp: number
  unclassifiedCount: number
  paidCount: number
  historicalExcelPaidCount: number
  accreditedPaidCount: number
}

export type BsaleReconciliationFilterValue =
  | 'ALL'
  | 'MATCHED_ALL'
  | 'MONETARY_EXACT'
  | 'MONETARY_DIFFERENCE'
  | 'RECEPTION_COMPLETE'
  | 'RECEPTION_PARTIAL'
  | 'NO_RECEIPT_OPERATIONAL'
  | 'NO_RECEIPT_HISTORICAL'
  | 'HISTORICAL_EXCEL_PAID'

export type BsaleInvoiceSortColumn =
  | 'emissionDate'
  | 'dueDate'
  | 'supplier'
  | 'folio'
  | 'siiAmount'
  | 'receivedAmount'
  | 'difference'
  | 'monetaryStatus'
  | 'receptionStatus'
  | 'financialStatus'

export type BsaleBadgeTone = 'emerald' | 'amber' | 'sky' | 'slate' | 'red'

export interface BsaleStatusBadgeModel {
  label: string
  detail: string | null
  tone: BsaleBadgeTone
}

export interface BsaleDocumentaryAlert {
  id: string
  tone: 'amber' | 'sky' | 'slate'
  title: string
  description: string
}

export interface BsaleSupplierFilterOption {
  rutNormalized: string
  rutFormatted: string
  supplierName: string
  invoiceCount: number
}

export interface BsaleInvoiceFilterParams {
  searchQuery?: string
  supplierRut?: string
  folioQuery?: string
  dateFrom?: string
  dateTo?: string
  financialPrimaryFilter?: FinancialPrimaryFilterValue
  reconciliationFilter?: BsaleReconciliationFilterValue
  sortColumn?: BsaleInvoiceSortColumn
  sortDirection?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  financialByKey?: Record<string, InvoiceFinancialStatusOverlay>
}

export interface PaginatedBsaleInvoicesResult {
  items: ReconciledInvoiceEntry[]
  allFilteredItems: ReconciledInvoiceEntry[]
  totalItems: number
  totalPages: number
  currentPage: number
  pageSize: number
  startIndex: number
  endIndex: number
}

export function formatSignedClpDifference(
  differenceClp: number | null | undefined,
): string {
  if (differenceClp === null || differenceClp === undefined) return '—'
  if (differenceClp === 0) return '$0'
  const prefix = differenceClp > 0 ? '+' : '-'
  return `${prefix}${formatClp(Math.abs(differenceClp))}`
}

export function codeSiiShortLabel(codeSii: string | null | undefined): string {
  if (codeSii === '33') return 'FA Afecta · 33'
  if (codeSii === '34') return 'FA Exenta · 34'
  if (codeSii === '61') return 'NC · 61'
  if (codeSii === '56') return 'ND · 56'
  return codeSii ? `SII ${codeSii}` : 'Sin DTE SII'
}

/**
 * Extrae las 777 facturas SII (33 y 34) del reporte del motor sin mezclarlas
 * con las recepciones sin factura SII ni la GD 147, ordenadas desde la más reciente.
 */
export function extractSiiInvoicesFromReport(
  report: BsaleBodegaReconciliationReport,
): ReconciledInvoiceEntry[] {
  const invoices = report.entries.filter(
    entry =>
      entry.bsaleDocumentId !== null &&
      (entry.codeSii === '33' || entry.codeSii === '34'),
  )

  return [...invoices].sort((a, b) => {
    const dateA = a.dates.siiEmissionDate ?? ''
    const dateB = b.dates.siiEmissionDate ?? ''
    if (dateA !== dateB) return dateB.localeCompare(dateA)

    const folioA = Number(a.documentFolio ?? 0)
    const folioB = Number(b.documentFolio ?? 0)
    if (folioA !== folioB) return folioB - folioA

    return (b.bsaleDocumentId ?? 0) - (a.bsaleDocumentId ?? 0)
  })
}

/**
 * Extrae las incidencias de Bodega (las 2 recepciones FA sin documento SII y la GD 147),
 * manteniéndolas separadas de las 777 facturas SII.
 */
export function extractBodegaIncidentsFromReport(
  report: BsaleBodegaReconciliationReport,
): ReconciledInvoiceEntry[] {
  const incidents = [
    ...report.receiptsWithoutBsaleInvoice,
    ...report.gdReceiptsWithoutLinkedInvoice,
    ...report.ambiguousEntries,
  ]

  return [...incidents].sort((a, b) => {
    const dateA = a.dates.receiptDocumentDates[0] ?? ''
    const dateB = b.dates.receiptDocumentDates[0] ?? ''
    if (dateA !== dateB) return dateB.localeCompare(dateA)
    return Number(b.documentFolio ?? 0) - Number(a.documentFolio ?? 0)
  })
}

/**
 * Construye la lista de proveedores presentes en las 777 facturas SII para el selector de filtro.
 */
export function buildBsaleSupplierFilterOptions(
  siiInvoices: ReconciledInvoiceEntry[],
): BsaleSupplierFilterOption[] {
  const byRut = new Map<
    string,
    { supplierName: string; invoiceCount: number }
  >()

  for (const inv of siiInvoices) {
    const rut = inv.issuerRutNormalized
    if (!rut) continue
    const displayName =
      inv.bodegaSupplierName || inv.bsaleSupplierName || 'Proveedor sin nombre'
    const current = byRut.get(rut)
    if (!current) {
      byRut.set(rut, { supplierName: displayName, invoiceCount: 1 })
    } else {
      current.invoiceCount += 1
      if (inv.bodegaSupplierName) {
        current.supplierName = inv.bodegaSupplierName
      }
    }
  }

  return Array.from(byRut.entries())
    .map(([rutNormalized, info]) => ({
      rutNormalized,
      rutFormatted: formatRut(rutNormalized),
      supplierName: info.supplierName,
      invoiceCount: info.invoiceCount,
    }))
    .sort((a, b) =>
      a.supplierName.localeCompare(b.supplierName, 'es-CL', {
        sensitivity: 'base',
      }),
    )
}

/**
 * Resuelve el badge de Estado de Conciliación Monetaria (independiente del estado físico de recepción).
 */
export function resolveMonetaryReconciliationBadge(
  entry: ReconciledInvoiceEntry,
): BsaleStatusBadgeModel {
  if (entry.monetary.status === 'EXACT_MATCH') {
    return {
      label: 'Coincidencia exacta',
      detail: entry.monetary.hasSubPesoRoundingOnly
        ? 'Dif. $0 (redondeo CLP)'
        : 'Diferencia $0',
      tone: 'emerald',
    }
  }

  if (entry.monetary.status === 'AMOUNT_DIFFERENCE') {
    return {
      label: 'Con diferencia',
      detail: `Dif. ${formatSignedClpDifference(entry.monetary.differenceClp)}`,
      tone: 'amber',
    }
  }

  if (entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL') {
    return {
      label: 'Histórica pre-Bodega',
      detail: 'Anterior a recepciones ERP',
      tone: 'slate',
    }
  }

  if (entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL') {
    return {
      label: 'Sin cruce Bodega',
      detail: 'Período operativo >= Oct 2026',
      tone: 'sky',
    }
  }

  if (entry.category === 'RECEIPT_WITHOUT_BSALE_INVOICE') {
    return {
      label: 'Sin factura SII',
      detail: 'No figura en espejo Bsale',
      tone: 'amber',
    }
  }

  if (entry.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE') {
    return {
      label: 'Guía sin factura',
      detail: 'Pendiente asociar FA SII',
      tone: 'amber',
    }
  }

  return {
    label: 'No comparable',
    detail: 'Identidad documental pendiente',
    tone: 'slate',
  }
}

/**
 * Resuelve el badge de Estado Físico de Recepción (independiente del estado monetario).
 */
export function resolvePhysicalReceptionBadge(
  entry: ReconciledInvoiceEntry,
): BsaleStatusBadgeModel {
  if (entry.receptionStatus === 'COMPLETE') {
    const recLabel =
      entry.receiptCount > 1
        ? `${entry.receiptCount} recepciones`
        : '1 recepción'
    const poLabel =
      entry.purchaseOrderCorrelatives.length > 0
        ? entry.purchaseOrderCorrelatives.join(', ')
        : null
    return {
      label: 'Recepción completa',
      detail: poLabel ? `${recLabel} · ${poLabel}` : recLabel,
      tone: 'emerald',
    }
  }

  if (entry.receptionStatus === 'PARTIAL') {
    const recLabel =
      entry.receiptCount > 1
        ? `${entry.receiptCount} recepciones`
        : '1 recepción'
    const poLabel =
      entry.purchaseOrderCorrelatives.length > 0
        ? entry.purchaseOrderCorrelatives.join(', ')
        : null
    return {
      label: 'Recepción parcial',
      detail: poLabel ? `${recLabel} · ${poLabel}` : recLabel,
      tone: 'amber',
    }
  }

  if (entry.receptionStatus === 'PENDING_DOCUMENT_LINK') {
    return {
      label: 'Vínculo doc. pendiente',
      detail:
        entry.bodegaDocumentType === 'GD'
          ? `Guía GD ${entry.documentFolio ?? ''}`.trim()
          : 'Sin folio FA vinculado',
      tone: 'amber',
    }
  }

  if (entry.isHistoricalPreErpReceipts) {
    return {
      label: 'Sin recepción (Histórica)',
      detail: 'Pre-puesta en marcha Bodega',
      tone: 'slate',
    }
  }

  return {
    label: 'Sin recepción en Bodega',
    detail: 'Período operativo',
    tone: 'sky',
  }
}

function formatIsoShortDate(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return '—'
  const [y, m, d] = isoDate.split('-')
  return `${d}/${m}/${y}`
}

export function resolveFinancialInboxGroup(
  overlay: InvoiceFinancialStatusOverlay | undefined,
): FinancialInboxGroup {
  if (!overlay) return 'UNCLASSIFIED'
  const { accreditationStatus, isBalanceAccredited, isFullyPaid, currentBalanceClp } =
    overlay.financialBalance

  if (
    accreditationStatus === 'HISTORICAL_EXCEL_PAID' ||
    accreditationStatus === 'ACCREDITED_PAID' ||
    (isBalanceAccredited && isFullyPaid)
  ) {
    return 'PAID'
  }

  if (
    isBalanceAccredited &&
    !isFullyPaid &&
    (currentBalanceClp ?? 0) > 0
  ) {
    return 'CONFIRMED_DEBT'
  }

  if (accreditationStatus === 'HISTORICAL_EXCEL_PENDING') {
    return 'TO_PAY_EXCEL'
  }

  return 'UNCLASSIFIED'
}

export function summarizeFinancialInboxGroups(
  siiInvoices: ReconciledInvoiceEntry[],
  financialByKey?: Record<string, InvoiceFinancialStatusOverlay>,
): FinancialInboxSummaryCounts {
  let confirmedDebtCount = 0
  let confirmedDebtTotalClp = 0
  let historicalExcelPendingCount = 0
  let historicalExcelPendingTotalClp = 0
  let unclassifiedCount = 0
  let paidCount = 0
  let historicalExcelPaidCount = 0
  let accreditedPaidCount = 0

  for (const entry of siiInvoices) {
    const overlay = financialByKey?.[entry.reconciliationKey]
    const group = resolveFinancialInboxGroup(overlay)
    if (group === 'CONFIRMED_DEBT') {
      confirmedDebtCount++
      confirmedDebtTotalClp += overlay?.financialBalance.currentBalanceClp ?? 0
    } else if (group === 'TO_PAY_EXCEL') {
      historicalExcelPendingCount++
      historicalExcelPendingTotalClp +=
        overlay?.financialBalance.historicalPendingExcelEvidence
          ?.pendingBalanceClp ?? 0
    } else if (group === 'PAID') {
      paidCount++
      if (
        overlay?.financialBalance.accreditationStatus ===
        'HISTORICAL_EXCEL_PAID'
      ) {
        historicalExcelPaidCount++
      } else {
        accreditedPaidCount++
      }
    } else {
      unclassifiedCount++
    }
  }

  return {
    totalInvoices: siiInvoices.length,
    confirmedDebtCount,
    confirmedDebtTotalClp,
    historicalExcelPendingCount,
    historicalExcelPendingTotalClp,
    unclassifiedCount,
    paidCount,
    historicalExcelPaidCount,
    accreditedPaidCount,
  }
}

export function hasConfirmedPayableDueDate(
  overlay: InvoiceFinancialStatusOverlay | undefined,
): boolean {
  return (
    resolveFinancialInboxGroup(overlay) === 'CONFIRMED_DEBT' &&
    Boolean(overlay?.dueDateInfo.dueDate)
  )
}

/**
 * Resuelve el badge de Estado Financiero / Saldo acreditado, sin clasificar nunca
 * una factura no acreditada como impaga.
 */
export function resolveFinancialAccreditationBadge(
  overlay: InvoiceFinancialStatusOverlay | undefined,
): BsaleStatusBadgeModel {
  if (!overlay) {
    return {
      label: 'Sin clasificar',
      detail: 'No figura en Excel · No presunta impaga',
      tone: 'slate',
    }
  }

  const { financialBalance } = overlay

  if (financialBalance.accreditationStatus === 'HISTORICAL_EXCEL_PAID') {
    const ev = financialBalance.historicalExcelEvidence
    const dateText = ev ? formatIsoShortDate(ev.referencePaymentDate) : '—'
    const basisTag =
      ev?.paymentDateBasis === 'EXCEL_COLUMN_H' ? 'Informada' : 'Asumida'
    return {
      label: 'Pagada según Excel',
      detail: `Saldo $0 · ${dateText} (${basisTag})`,
      tone: 'emerald',
    }
  }

  if (financialBalance.accreditationStatus === 'HISTORICAL_EXCEL_PENDING') {
    const ev = financialBalance.historicalPendingExcelEvidence
    const pendingText = ev ? formatClp(ev.pendingBalanceClp) : '—'
    const detail =
      ev && ev.creditNoteAmountClp > 0
        ? `Orig. ${formatClp(ev.originalAmountClp)} − NC ${formatClp(ev.creditNoteAmountClp)}`
        : 'Saldo según Excel · Sin validar ERP'
    return {
      label: `Saldo según Excel · ${pendingText}`,
      detail,
      tone: 'amber',
    }
  }

  if (financialBalance.accreditationStatus === 'ACCREDITED_PAID') {
    return {
      label: 'Pagada · Saldo $0',
      detail: financialBalance.accreditationDetail,
      tone: 'emerald',
    }
  }

  if (financialBalance.accreditationStatus === 'ACCREDITED_PARTIAL_BALANCE') {
    return {
      label: `Deuda confirmada · ${formatClp(financialBalance.currentBalanceClp)}`,
      detail: financialBalance.accreditationDetail,
      tone: 'sky',
    }
  }

  if (financialBalance.accreditationStatus === 'ACCREDITED_OPEN_BALANCE') {
    return {
      label: `Deuda confirmada · ${formatClp(financialBalance.currentBalanceClp)}`,
      detail: 'Obligación validada pendiente',
      tone: 'sky',
    }
  }

  if (financialBalance.accreditationStatus === 'BLOCKED_BY_DISCREPANCY') {
    return {
      label: 'Sin clasificar · Bloqueo doc.',
      detail: financialBalance.accreditationDetail,
      tone: 'amber',
    }
  }

  return {
    label: 'Sin clasificar',
    detail: 'No figura en Excel · No presunta impaga',
    tone: 'slate',
  }
}

/**
 * Construye las alertas documentales y de discrepancia de fechas para el panel lateral.
 */
export function buildDocumentaryAlertsForEntry(
  entry: ReconciledInvoiceEntry,
): BsaleDocumentaryAlert[] {
  const alerts: BsaleDocumentaryAlert[] = []

  if (entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL') {
    alerts.push({
      id: 'historical-pre-erp',
      tone: 'slate',
      title: 'Documento histórico previo a recepciones del ERP',
      description:
        'Emitido antes del 01/10/2026 (puesta en marcha de recepciones de Bodega). No representa una alerta operativa ni se clasifica automáticamente como Servicio.',
    })
  } else if (entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL') {
    alerts.push({
      id: 'operational-no-receipt',
      tone: 'sky',
      title: 'Factura en período operativo sin recepción vinculada en Bodega',
      description:
        'Emitida desde octubre de 2026 sin recepción FA asociada por RUT y folio. Puede corresponder a mercadería en tránsito, recepción pendiente de registro o compra no inventariable; no se clasifica automáticamente como Servicio.',
    })
  }

  if (entry.category === 'RECEIPT_WITHOUT_BSALE_INVOICE') {
    alerts.push({
      id: 'receipt-without-bsale',
      tone: 'amber',
      title: 'Recepción FA de Bodega sin documento tributario en espejo Bsale',
      description: `La recepción en Bodega para el folio ${entry.documentFolio ?? '—'} (${entry.purchaseOrderCorrelatives.join(', ') || 'Sin OC'}) no registra par tributario 33/34 para el RUT ${formatRut(entry.issuerRutNormalized)}. Verifique posible diferencia de digitación de folio.`,
    })
  }

  if (entry.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE') {
    alerts.push({
      id: 'gd-without-invoice',
      tone: 'amber',
      title: 'Recepción con Guía de Despacho sin factura vinculada',
      description:
        entry.ambiguityReason ||
        'La recepción ingresó con Guía de Despacho (GD) sin folio de factura SII asociado. No se vincula automáticamente por monto ni por Orden de Compra.',
    })
  }

  if (
    entry.monetary.status === 'AMOUNT_DIFFERENCE' &&
    entry.monetary.differenceClp !== null
  ) {
    const diff = entry.monetary.differenceClp
    alerts.push({
      id: 'monetary-difference',
      tone: 'amber',
      title: `Diferencia monetaria entre SII y Bodega: ${formatSignedClpDifference(diff)}`,
      description:
        diff > 0
          ? `El total oficial del SII (${formatClp(entry.monetary.siiTotalAmountClp)}) supera en ${formatClp(Math.abs(diff))} al monto consolidado recibido en Bodega (${formatClp(entry.monetary.receivedGrossAmountClp)}).`
          : `El monto consolidado recibido en Bodega (${formatClp(entry.monetary.receivedGrossAmountClp)}) supera en ${formatClp(Math.abs(diff))} al total oficial del SII (${formatClp(entry.monetary.siiTotalAmountClp)}).`,
    })
  }

  if (entry.dates.hasInconsistentReceiptDates) {
    alerts.push({
      id: 'inconsistent-receipt-dates',
      tone: 'amber',
      title: 'Múltiples fechas de documento en recepciones consolidadas',
      description: `Las ${entry.receiptCount} recepciones asociadas registran distintas fechas de documento en Bodega (${entry.dates.receiptDocumentDates.join(', ')}) frente a la fecha oficial de emisión SII (${entry.dates.siiEmissionDate ?? '—'}).`,
    })
  } else if (entry.dates.hasDocumentDateMismatch && entry.dates.siiEmissionDate) {
    alerts.push({
      id: 'document-date-mismatch',
      tone: 'amber',
      title: 'Diferencia entre fecha de documento en Bodega y emisión SII',
      description: `Fecha digitada en recepción de Bodega (${entry.dates.receiptDocumentDates.join(', ') || 'Sin fecha'}) difiere de la fecha oficial de emisión SII (${entry.dates.siiEmissionDate}).`,
    })
  }

  if (
    entry.dates.receivedAfterSiiEmission &&
    entry.dates.maxReceptionLagDays !== null &&
    entry.dates.maxReceptionLagDays > 0
  ) {
    alerts.push({
      id: 'reception-lag-days',
      tone: 'sky',
      title: `Recepción física registrada ${entry.dates.maxReceptionLagDays} día(s) después de la emisión SII`,
      description: `Emisión SII: ${entry.dates.siiEmissionDate ?? '—'} · Última recepción en Bodega: ${entry.dates.receiptReceivedDates[entry.dates.receiptReceivedDates.length - 1] ?? '—'}.`,
    })
  }

  if (entry.hasCrossSupplierFolioCollision) {
    alerts.push({
      id: 'cross-supplier-folio-collision',
      tone: 'amber',
      title: `Folio ${entry.documentFolio} repetido en más de un proveedor`,
      description: `El folio ${entry.documentFolio} existe en documentos de distintos RUT (${entry.collidingSupplierRuts.map(r => formatRut(r)).join(' y ')}). El motor desambiguó utilizando el RUT normalizado del emisor (${formatRut(entry.issuerRutNormalized)}).`,
    })
  }

  return alerts
}

function matchesReconciliationFilter(
  entry: ReconciledInvoiceEntry,
  filter: BsaleReconciliationFilterValue,
  financialByKey?: Record<string, InvoiceFinancialStatusOverlay>,
): boolean {
  switch (filter) {
    case 'ALL':
      return true
    case 'MATCHED_ALL':
      return (
        entry.category === 'MATCHED_COMPLETE_EXACT' ||
        entry.category === 'MATCHED_COMPLETE_DIFFERENCE' ||
        entry.category === 'MATCHED_PARTIAL_EXACT' ||
        entry.category === 'MATCHED_PARTIAL_DIFFERENCE'
      )
    case 'MONETARY_EXACT':
      return entry.monetary.status === 'EXACT_MATCH'
    case 'MONETARY_DIFFERENCE':
      return entry.monetary.status === 'AMOUNT_DIFFERENCE'
    case 'RECEPTION_COMPLETE':
      return entry.receptionStatus === 'COMPLETE'
    case 'RECEPTION_PARTIAL':
      return entry.receptionStatus === 'PARTIAL'
    case 'NO_RECEIPT_OPERATIONAL':
      return entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'
    case 'NO_RECEIPT_HISTORICAL':
      return entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL'
    case 'HISTORICAL_EXCEL_PAID':
      return (
        financialByKey?.[entry.reconciliationKey]?.financialBalance
          .accreditationStatus === 'HISTORICAL_EXCEL_PAID'
      )
    default:
      return true
  }
}

function compareEntries(
  a: ReconciledInvoiceEntry,
  b: ReconciledInvoiceEntry,
  column: BsaleInvoiceSortColumn,
  direction: 'asc' | 'desc',
  financialByKey?: Record<string, InvoiceFinancialStatusOverlay>,
): number {
  const factor = direction === 'asc' ? 1 : -1

  switch (column) {
    case 'emissionDate': {
      const dA = a.dates.siiEmissionDate ?? ''
      const dB = b.dates.siiEmissionDate ?? ''
      if (dA !== dB) return dA.localeCompare(dB) * factor
      return (Number(a.documentFolio ?? 0) - Number(b.documentFolio ?? 0)) * factor
    }
    case 'dueDate': {
      const dueA =
        financialByKey?.[a.reconciliationKey]?.dueDateInfo.dueDate ?? ''
      const dueB =
        financialByKey?.[b.reconciliationKey]?.dueDateInfo.dueDate ?? ''
      if (dueA !== dueB) {
        if (!dueA) return 1
        if (!dueB) return -1
        return dueA.localeCompare(dueB) * factor
      }
      return (Number(a.documentFolio ?? 0) - Number(b.documentFolio ?? 0)) * factor
    }
    case 'supplier': {
      const sA = a.bodegaSupplierName || a.bsaleSupplierName || ''
      const sB = b.bodegaSupplierName || b.bsaleSupplierName || ''
      const cmp = sA.localeCompare(sB, 'es-CL', { sensitivity: 'base' })
      if (cmp !== 0) return cmp * factor
      return (Number(b.documentFolio ?? 0) - Number(a.documentFolio ?? 0))
    }
    case 'folio': {
      const fA = Number(a.documentFolio ?? 0)
      const fB = Number(b.documentFolio ?? 0)
      return (fA - fB) * factor
    }
    case 'siiAmount': {
      const mA = a.monetary.siiTotalAmountClp ?? -1
      const mB = b.monetary.siiTotalAmountClp ?? -1
      return (mA - mB) * factor
    }
    case 'receivedAmount': {
      const rA = a.monetary.receivedGrossAmountClp ?? -1
      const rB = b.monetary.receivedGrossAmountClp ?? -1
      return (rA - rB) * factor
    }
    case 'difference': {
      const diffA =
        a.monetary.absDifferenceClp !== null
          ? a.monetary.absDifferenceClp
          : -1
      const diffB =
        b.monetary.absDifferenceClp !== null
          ? b.monetary.absDifferenceClp
          : -1
      return (diffA - diffB) * factor
    }
    case 'monetaryStatus': {
      const rank = (e: ReconciledInvoiceEntry) =>
        e.monetary.status === 'EXACT_MATCH'
          ? 1
          : e.monetary.status === 'AMOUNT_DIFFERENCE'
            ? 2
            : e.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'
              ? 3
              : 4
      return (rank(a) - rank(b)) * factor
    }
    case 'receptionStatus': {
      const rank = (e: ReconciledInvoiceEntry) =>
        e.receptionStatus === 'COMPLETE'
          ? 1
          : e.receptionStatus === 'PARTIAL'
            ? 2
            : e.isHistoricalPreErpReceipts
              ? 4
              : 3
      return (rank(a) - rank(b)) * factor
    }
    case 'financialStatus': {
      const rank = (e: ReconciledInvoiceEntry) => {
        const status =
          financialByKey?.[e.reconciliationKey]?.financialBalance
            .accreditationStatus
        return status === 'ACCREDITED_PAID'
          ? 1
          : status === 'HISTORICAL_EXCEL_PAID'
            ? 2
            : status === 'ACCREDITED_PARTIAL_BALANCE'
              ? 3
              : status === 'ACCREDITED_OPEN_BALANCE'
                ? 4
                : status === 'HISTORICAL_EXCEL_PENDING'
                  ? 5
                  : status === 'BLOCKED_BY_DISCREPANCY'
                    ? 6
                    : 7
      }
      return (rank(a) - rank(b)) * factor
    }
    default:
      return 0
  }
}

/**
 * Filtra, ordena y pagina en memoria las 777 facturas SII sin recalcular la conciliación.
 */
export function filterAndPaginateBsaleInvoices(
  siiInvoices: ReconciledInvoiceEntry[],
  params?: BsaleInvoiceFilterParams,
): PaginatedBsaleInvoicesResult {
  const searchQuery = (params?.searchQuery ?? '')
    .toLocaleLowerCase('es-CL')
    .trim()
  const supplierRut = (params?.supplierRut ?? 'ALL').trim()
  const folioQuery = (params?.folioQuery ?? '').trim()
  const dateFrom = (params?.dateFrom ?? '').trim()
  const dateTo = (params?.dateTo ?? '').trim()
  const financialPrimaryFilter = params?.financialPrimaryFilter ?? 'ALL'
  const reconciliationFilter = params?.reconciliationFilter ?? 'ALL'
  const sortColumn = params?.sortColumn ?? 'emissionDate'
  const sortDirection = params?.sortDirection ?? 'desc'
  const pageSize = Math.max(1, params?.pageSize ?? 50)

  const filtered = siiInvoices.filter(entry => {
    if (
      supplierRut !== 'ALL' &&
      entry.issuerRutNormalized !== supplierRut
    ) {
      return false
    }

    if (folioQuery) {
      const cleanFolioQuery = folioQuery.replace(/^0+([0-9])/, '$1')
      const entryFolio = entry.documentFolio ?? ''
      if (!entryFolio.includes(cleanFolioQuery)) {
        return false
      }
    }

    const emissionDate = entry.dates.siiEmissionDate ?? ''
    if (dateFrom && emissionDate < dateFrom) {
      return false
    }
    if (dateTo && emissionDate > dateTo) {
      return false
    }

    if (financialPrimaryFilter !== 'ALL') {
      const group = resolveFinancialInboxGroup(
        params?.financialByKey?.[entry.reconciliationKey],
      )
      if (
        financialPrimaryFilter === 'TO_PAY' &&
        group !== 'TO_PAY_EXCEL' &&
        group !== 'CONFIRMED_DEBT'
      ) {
        return false
      }
      if (financialPrimaryFilter === 'PAID' && group !== 'PAID') {
        return false
      }
      if (
        financialPrimaryFilter === 'UNCLASSIFIED' &&
        group !== 'UNCLASSIFIED'
      ) {
        return false
      }
    }

    if (
      !matchesReconciliationFilter(
        entry,
        reconciliationFilter,
        params?.financialByKey,
      )
    ) {
      return false
    }

    if (!searchQuery) {
      return true
    }

    const haystack = [
      entry.bsaleSupplierName ?? '',
      entry.bodegaSupplierName ?? '',
      entry.issuerRutNormalized ?? '',
      formatRut(entry.issuerRutNormalized),
      entry.documentFolio ?? '',
      `FA ${entry.documentFolio ?? ''}`,
      entry.codeSii ?? '',
      ...entry.purchaseOrderCorrelatives,
    ]
      .join(' ')
      .toLocaleLowerCase('es-CL')

    return haystack.includes(searchQuery)
  })

  const sorted = [...filtered].sort((a, b) =>
    compareEntries(a, b, sortColumn, sortDirection, params?.financialByKey),
  )

  const totalItems = sorted.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const currentPage = Math.min(
    Math.max(1, params?.page ?? 1),
    totalPages,
  )
  const startOffset = (currentPage - 1) * pageSize
  const items = sorted.slice(startOffset, startOffset + pageSize)

  return {
    items,
    allFilteredItems: sorted,
    totalItems,
    totalPages,
    currentPage,
    pageSize,
    startIndex: totalItems === 0 ? 0 : startOffset + 1,
    endIndex: totalItems === 0 ? 0 : startOffset + items.length,
  }
}
