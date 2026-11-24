import { KNOWN_COMPANY_IDS } from '@/lib/bsale/company-config'

export const CAYLO_COMPANY_ID = KNOWN_COMPANY_IDS.CAYLO

/**
 * Fecha de referencia por defecto de puesta en marcha operativa de las recepciones
 * de Bodega en el ERP (octubre 2026). Permite distinguir documentos históricos
 * anteriores al inicio de operación de Bodega para evitar falsas alertas operativas.
 */
export const DEFAULT_ERP_RECEIPTS_GO_LIVE_DATE = '2026-10-01'

export type ReconcilableBsaleCodeSii = '33' | '34'
export type DeferredBsaleNoteCodeSii = '61' | '56'

export type MonetaryReconciliationStatus =
  | 'EXACT_MATCH'
  | 'AMOUNT_DIFFERENCE'
  | 'UNCOMPARABLE'

export type ReceptionReconciliationStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NO_RECEIPT'
  | 'PENDING_DOCUMENT_LINK'

export type ReconciliationCategory =
  | 'MATCHED_COMPLETE_EXACT'
  | 'MATCHED_COMPLETE_DIFFERENCE'
  | 'MATCHED_PARTIAL_EXACT'
  | 'MATCHED_PARTIAL_DIFFERENCE'
  | 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL'
  | 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'
  | 'RECEIPT_WITHOUT_BSALE_INVOICE'
  | 'GD_RECEIPT_WITHOUT_LINKED_INVOICE'
  | 'AMBIGUOUS_DOCUMENT_IDENTITY'

export interface BsaleMirrorDocumentInput {
  id?: string | null
  company_id: string
  bsale_document_id: number | string
  code_sii: string
  document_number: number | string
  document_folio: string
  client_code: string
  issuer_rut_normalized: string
  client_activity: string
  emission_date: string
  sii_reception_date?: string | null
  tax_month?: number | null
  tax_year?: number | null
  exempt_amount?: number | string | null
  net_amount?: number | string | null
  iva_rate?: number | string | null
  iva_amount?: number | string | null
  specific_tax_amount?: number | string | null
  total_amount: number | string
  sii_status?: string[] | null
  add_book?: number | null
  include_flag?: number | null
  canceled?: number | null
  url_pdf?: string | null
  url_xml?: string | null
}

export interface BodegaReceiptInput {
  id: string
  company_id: string
  purchase_order_id: string | null
  receipt_number?: string | null
  receiving_type: string
  status: string
  document_type: string | null
  document_number: string | null
  document_date: string | null
  received_at?: string | null
  created_at?: string | null
  receipt_total_net?: number | string | null
  receipt_total_tax?: number | string | null
  receipt_total_gross?: number | string | null
  supplier_id?: string | null
}

export interface BodegaPurchaseOrderInput {
  id: string
  company_id: string
  correlative: string
  supplier_id: string
  po_type?: string | null
  status: string
  receipt_status: string
  is_active?: boolean | null
  net_total?: number | string | null
  tax_total?: number | string | null
  grand_total?: number | string | null
}

export interface BodegaSupplierInput {
  id: string
  company_id?: string | null
  business_name: string
  rut?: string | null
  rut_normalized?: string | null
}

export interface BodegaReceiptItemInput {
  id: string
  receipt_id: string
  purchase_order_item_id?: string | null
  quantity_ordered?: number | string | null
  quantity_previously_received?: number | string | null
  quantity_received?: number | string | null
  quantity_pending_after?: number | string | null
  quantity_rejected?: number | string | null
  quantity_missing?: number | string | null
  net_amount?: number | string | null
  tax_amount?: number | string | null
  gross_amount?: number | string | null
}

export interface BodegaReceiptDocumentInput {
  id: string
  company_id: string
  receipt_id: string
  document_type: string
  document_number?: string | null
  storage_path?: string | null
  file_url?: string | null
}

export interface AttributableReceiptBreakdown {
  receiptId: string
  receiptNumber: string | null
  purchaseOrderId: string | null
  purchaseOrderCorrelative: string | null
  purchaseOrderReceiptStatus: string | null
  documentType: string
  documentFolio: string | null
  documentDate: string | null
  receivedDate: string | null
  attributableNetAmount: number
  attributableTaxAmount: number
  attributableGrossAmountExact: number
  attributableGrossAmountClp: number
  itemsCount: number
  unitsReceived: number
  hasPendingItemsAfterReceipt: boolean
  hasAttachmentInBodega: boolean
}

export interface MonetaryReconciliationDetail {
  status: MonetaryReconciliationStatus
  siiExemptAmount: number | null
  siiNetAmount: number | null
  siiTaxAmount: number | null
  siiSpecificTaxAmount: number | null
  siiTotalAmountClp: number | null
  receivedNetAmountExact: number | null
  receivedTaxAmountExact: number | null
  receivedGrossAmountExact: number | null
  receivedGrossAmountClp: number | null
  /** Diferencia en CLP enteros: siiTotalAmountClp - receivedGrossAmountClp */
  differenceClp: number | null
  absDifferenceClp: number | null
  /** Diferencia exacta con decimales: siiTotalAmountClp - receivedGrossAmountExact */
  differenceExact: number | null
  hasSubPesoRoundingOnly: boolean
}

export interface DateReconciliationDetail {
  siiEmissionDate: string | null
  receiptDocumentDates: string[]
  receiptReceivedDates: string[]
  hasDocumentDateMismatch: boolean
  hasInconsistentReceiptDates: boolean
  /** Días transcurridos entre emission_date SII y fecha máxima de recepción en Bodega */
  maxReceptionLagDays: number | null
  receivedAfterSiiEmission: boolean
}

export interface ReconciledInvoiceEntry {
  reconciliationKey: string
  category: ReconciliationCategory
  companyId: string
  issuerRutNormalized: string | null
  supplierId: string | null
  bsaleSupplierName: string | null
  bodegaSupplierName: string | null
  codeSii: ReconcilableBsaleCodeSii | null
  bodegaDocumentType: string | null
  documentFolio: string | null
  bsaleDocumentId: number | null
  siiStatus: string[] | null
  hasBsalePdf: boolean
  hasBsaleXml: boolean
  hasBodegaAttachment: boolean
  monetary: MonetaryReconciliationDetail
  receptionStatus: ReceptionReconciliationStatus
  dates: DateReconciliationDetail
  isHistoricalPreErpReceipts: boolean
  hasCrossSupplierFolioCollision: boolean
  collidingSupplierRuts: string[]
  ambiguityReason: string | null
  receiptCount: number
  purchaseOrderCount: number
  purchaseOrderIds: string[]
  purchaseOrderCorrelatives: string[]
  purchaseOrderReceiptStatuses: string[]
  receipts: AttributableReceiptBreakdown[]
}

export interface DeferredBsaleNoteEntry {
  bsaleDocumentId: number
  codeSii: DeferredBsaleNoteCodeSii
  documentFolio: string
  issuerRutNormalized: string
  supplierName: string
  emissionDate: string
  totalAmountClp: number
  siiStatus: string[] | null
}

export interface CrossSupplierAmbiguousFolioEntry {
  documentFolio: string
  suppliers: Array<{
    issuerRutNormalized: string
    supplierName: string
    source: 'BSALE' | 'BODEGA'
    codeSiiOrDocType: string
    emissionOrDocDate: string | null
    amountClp: number
  }>
}

export interface BsaleBodegaReconciliationReport {
  companyId: string
  erpReceiptsGoLiveDate: string
  earliestWarehouseReceiptCreatedDate: string | null
  earliestMatchedInvoiceEmissionDate: string | null
  counts: {
    totalBsaleMirrorDocuments: number
    totalBsaleInvoices: number
    totalBsaleInvoices33: number
    totalBsaleInvoices34: number
    deferredBsaleNotesTotal: number
    deferredBsaleCreditNotes61: number
    deferredBsaleDebitNotes56: number
    totalRawReceiptsRead: number
    excludedNonWarehouseOrServiceReceiptsCount: number
    eligibleWarehouseReceiptsCount: number
    eligibleWarehouseFaReceiptsCount: number
    eligibleWarehouseGdReceiptsCount: number
    consolidatedWarehouseFaGroupsCount: number
    matchedInvoicesCount: number
    matchedMultiReceiptInvoicesCount: number
    matchedMultiPurchaseOrderInvoicesCount: number
    monetaryExactMatchCount: number
    monetaryAmountDifferenceCount: number
    receptionCompleteCount: number
    receptionPartialCount: number
    receptionNoReceiptCount: number
    receptionPendingDocumentLinkCount: number
    byCategory: Record<ReconciliationCategory, number>
    bsaleInvoicesWithoutReceiptTotal: number
    bsaleInvoicesWithoutReceiptHistoricalCount: number
    bsaleInvoicesWithoutReceiptOperationalCount: number
    receiptsWithoutBsaleInvoiceCount: number
    gdReceiptsWithoutLinkedInvoiceCount: number
    ambiguousDocumentIdentityCount: number
    crossSupplierAmbiguousFoliosCount: number
    matchedWithDocumentDateMismatchCount: number
    matchedWithInconsistentReceiptDatesCount: number
    matchedReceivedAfterSiiEmissionCount: number
  }
  entries: ReconciledInvoiceEntry[]
  matchedEntries: ReconciledInvoiceEntry[]
  receiptsWithoutBsaleInvoice: ReconciledInvoiceEntry[]
  gdReceiptsWithoutLinkedInvoice: ReconciledInvoiceEntry[]
  ambiguousEntries: ReconciledInvoiceEntry[]
  bsaleInvoicesWithoutReceipt: ReconciledInvoiceEntry[]
  deferredNotes: DeferredBsaleNoteEntry[]
  crossSupplierAmbiguousFolios: CrossSupplierAmbiguousFolioEntry[]
}

export function normalizeRutForReconciliation(
  rawRut: string | null | undefined
): string | null {
  const cleaned = String(rawRut ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-\s]/g, '')
  if (!/^[0-9]{7,8}[0-9K]$/.test(cleaned)) {
    return null
  }
  return cleaned
}

export function normalizeNumericFolioForReconciliation(
  rawFolio: string | number | null | undefined
): string | null {
  const trimmed = String(rawFolio ?? '').trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return null
  }
  return trimmed.replace(/^0+([0-9])/, '$1')
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback
  }
  const num = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(num) ? num : fallback
}

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100
}

function diffDaysIso(startIsoDate: string, endIsoDate: string): number {
  const startMs = Date.parse(`${startIsoDate}T00:00:00Z`)
  const endMs = Date.parse(`${endIsoDate}T00:00:00Z`)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0
  return Math.round((endMs - startMs) / 86_400_000)
}

/**
 * Verifica si una recepción de Bodega corresponde a una recepción elegible de mercadería
 * en almacén (WAREHOUSE + OC de productos activa y recepcionada total o parcialmente),
 * siguiendo exactamente los contratos vigentes de Cuentas por Pagar / Logística.
 */
export function isEligibleWarehouseProductReceipt(
  receipt: BodegaReceiptInput,
  purchaseOrder: BodegaPurchaseOrderInput | undefined
): boolean {
  if (receipt.company_id !== CAYLO_COMPANY_ID) return false
  if (receipt.status !== 'COMPLETED') return false
  if (receipt.receiving_type !== 'WAREHOUSE') return false
  if (!purchaseOrder || purchaseOrder.company_id !== CAYLO_COMPANY_ID) return false
  if (purchaseOrder.is_active === false) return false
  if ((purchaseOrder.po_type ?? 'PRODUCTOS') === 'SERVICIOS') return false
  if (['CANCELADA', 'RECHAZADA', 'BORRADOR'].includes(purchaseOrder.status)) {
    return false
  }
  if (
    !['RECEPCION_TOTAL', 'RECEPCION_PARCIAL'].includes(
      purchaseOrder.receipt_status
    )
  ) {
    return false
  }
  return true
}

/**
 * Motor puro de conciliación de solo lectura entre el espejo `integraciones.bsale_third_party_documents`
 * y las recepciones de Bodega de Caylo.
 *
 * No modifica ninguna fuente ni realiza inferencias inseguras por monto o proveedor.
 */
export function reconcileBsaleAndBodegaForCaylo(params: {
  companyId?: string
  erpReceiptsGoLiveDate?: string
  bsaleDocuments: BsaleMirrorDocumentInput[]
  receipts: BodegaReceiptInput[]
  purchaseOrders: BodegaPurchaseOrderInput[]
  suppliers: BodegaSupplierInput[]
  receiptItems?: BodegaReceiptItemInput[]
  receiptDocuments?: BodegaReceiptDocumentInput[]
}): BsaleBodegaReconciliationReport {
  const companyId = params.companyId ?? CAYLO_COMPANY_ID
  if (companyId !== CAYLO_COMPANY_ID) {
    throw new Error(
      `El motor de conciliación Bsale-Bodega está restringido exclusivamente a Caylo (${CAYLO_COMPANY_ID})`
    )
  }

  const erpReceiptsGoLiveDate =
    params.erpReceiptsGoLiveDate ?? DEFAULT_ERP_RECEIPTS_GO_LIVE_DATE

  const poById = new Map<string, BodegaPurchaseOrderInput>()
  for (const po of params.purchaseOrders) {
    if (po.company_id === companyId) {
      poById.set(po.id, po)
    }
  }

  const supplierById = new Map<string, BodegaSupplierInput>()
  for (const sup of params.suppliers) {
    if (!sup.company_id || sup.company_id === companyId) {
      supplierById.set(sup.id, sup)
    }
  }

  const itemsByReceiptId = new Map<string, BodegaReceiptItemInput[]>()
  for (const item of params.receiptItems ?? []) {
    const list = itemsByReceiptId.get(item.receipt_id) ?? []
    list.push(item)
    itemsByReceiptId.set(item.receipt_id, list)
  }

  const docsByReceiptId = new Map<string, BodegaReceiptDocumentInput[]>()
  for (const doc of params.receiptDocuments ?? []) {
    if (doc.company_id !== companyId) continue
    const list = docsByReceiptId.get(doc.receipt_id) ?? []
    list.push(doc)
    docsByReceiptId.set(doc.receipt_id, list)
  }

  // 1. Clasificar documentos del espejo Bsale (33/34 a conciliar vs 61/56 diferidos)
  const bsaleInvoices: Array<
    BsaleMirrorDocumentInput & {
      bsaleDocumentIdNum: number
      codeSiiTyped: ReconcilableBsaleCodeSii
      normalizedRut: string | null
      normalizedFolio: string | null
      totalAmountClp: number
      netAmountNum: number
      ivaAmountNum: number
      exemptAmountNum: number
      specificTaxAmountNum: number | null
    }
  > = []
  const deferredNotes: DeferredBsaleNoteEntry[] = []

  for (const doc of params.bsaleDocuments) {
    if (doc.company_id !== companyId) continue
    const bsaleId = Number(doc.bsale_document_id)
    const codeSii = String(doc.code_sii ?? '').trim()
    const normalizedRut = normalizeRutForReconciliation(
      doc.issuer_rut_normalized || doc.client_code
    )
    const normalizedFolio = normalizeNumericFolioForReconciliation(
      doc.document_folio ?? doc.document_number
    )
    const totalAmountClp = Math.round(toFiniteNumber(doc.total_amount, 0))

    if (codeSii === '61' || codeSii === '56') {
      deferredNotes.push({
        bsaleDocumentId: bsaleId,
        codeSii,
        documentFolio: normalizedFolio ?? String(doc.document_folio ?? ''),
        issuerRutNormalized: normalizedRut ?? String(doc.issuer_rut_normalized ?? ''),
        supplierName: doc.client_activity,
        emissionDate: doc.emission_date,
        totalAmountClp,
        siiStatus: doc.sii_status ?? null,
      })
      continue
    }

    if (codeSii === '33' || codeSii === '34') {
      bsaleInvoices.push({
        ...doc,
        bsaleDocumentIdNum: bsaleId,
        codeSiiTyped: codeSii,
        normalizedRut,
        normalizedFolio,
        totalAmountClp,
        netAmountNum: roundTo2(toFiniteNumber(doc.net_amount, 0)),
        ivaAmountNum: roundTo2(toFiniteNumber(doc.iva_amount, 0)),
        exemptAmountNum: roundTo2(toFiniteNumber(doc.exempt_amount, 0)),
        specificTaxAmountNum:
          doc.specific_tax_amount !== null &&
          doc.specific_tax_amount !== undefined &&
          String(doc.specific_tax_amount).trim() !== ''
            ? roundTo2(toFiniteNumber(doc.specific_tax_amount, 0))
            : null,
      })
    }
  }

  // 2. Filtrar y normalizar recepciones elegibles de Bodega (WAREHOUSE + PRODUCTOS)
  //    Deduplicamos por receipt.id para evitar cualquier duplicación de importes.
  const seenReceiptIds = new Set<string>()
  let excludedNonWarehouseOrServiceReceiptsCount = 0
  let eligibleWarehouseReceiptsCount = 0
  let eligibleWarehouseFaReceiptsCount = 0
  let eligibleWarehouseGdReceiptsCount = 0
  let earliestWarehouseReceiptCreatedDate: string | null = null

  interface EnrichedWarehouseReceipt {
    receipt: BodegaReceiptInput
    po: BodegaPurchaseOrderInput
    supplier: BodegaSupplierInput | undefined
    supplierId: string
    normalizedRut: string | null
    normalizedFolio: string | null
    docType: string
    breakdown: AttributableReceiptBreakdown
  }

  const warehouseFaReceipts: EnrichedWarehouseReceipt[] = []
  const warehouseOtherReceipts: EnrichedWarehouseReceipt[] = []

  for (const receipt of params.receipts) {
    if (receipt.company_id !== companyId) continue
    if (seenReceiptIds.has(receipt.id)) continue
    seenReceiptIds.add(receipt.id)

    const po = receipt.purchase_order_id
      ? poById.get(receipt.purchase_order_id)
      : undefined

    if (!isEligibleWarehouseProductReceipt(receipt, po) || !po) {
      excludedNonWarehouseOrServiceReceiptsCount++
      continue
    }

    eligibleWarehouseReceiptsCount++
    const createdIso = receipt.created_at
      ? String(receipt.created_at).slice(0, 10)
      : receipt.received_at
        ? String(receipt.received_at).slice(0, 10)
        : null
    if (
      createdIso &&
      (!earliestWarehouseReceiptCreatedDate ||
        createdIso < earliestWarehouseReceiptCreatedDate)
    ) {
      earliestWarehouseReceiptCreatedDate = createdIso
    }

    const supplier = supplierById.get(po.supplier_id)
    const normalizedRut = normalizeRutForReconciliation(
      supplier?.rut || supplier?.rut_normalized
    )
    const docType = String(receipt.document_type ?? '')
      .trim()
      .toUpperCase()
    const normalizedFolio = normalizeNumericFolioForReconciliation(
      receipt.document_number
    )

    const rItems = itemsByReceiptId.get(receipt.id) ?? []
    const rDocs = docsByReceiptId.get(receipt.id) ?? []

    // Importe realmente atribuible a esta recepción:
    // usa el importe propio de la recepción (o suma de líneas de recepción si el encabezado viniera nulo),
    // NUNCA el total de la Orden de Compra.
    const itemsNetSum = roundTo2(
      rItems.reduce((acc, it) => acc + toFiniteNumber(it.net_amount, 0), 0)
    )
    const itemsTaxSum = roundTo2(
      rItems.reduce((acc, it) => acc + toFiniteNumber(it.tax_amount, 0), 0)
    )
    const itemsGrossSum = roundTo2(
      rItems.reduce((acc, it) => acc + toFiniteNumber(it.gross_amount, 0), 0)
    )

    const attributableNetAmount =
      receipt.receipt_total_net !== null &&
      receipt.receipt_total_net !== undefined
        ? roundTo2(toFiniteNumber(receipt.receipt_total_net, 0))
        : itemsNetSum
    const attributableTaxAmount =
      receipt.receipt_total_tax !== null &&
      receipt.receipt_total_tax !== undefined
        ? roundTo2(toFiniteNumber(receipt.receipt_total_tax, 0))
        : itemsTaxSum
    const attributableGrossAmountExact =
      receipt.receipt_total_gross !== null &&
      receipt.receipt_total_gross !== undefined
        ? roundTo2(toFiniteNumber(receipt.receipt_total_gross, 0))
        : itemsGrossSum
    const attributableGrossAmountClp = Math.round(attributableGrossAmountExact)

    const unitsReceived = roundTo2(
      rItems.reduce((acc, it) => acc + toFiniteNumber(it.quantity_received, 0), 0)
    )
    const hasPendingItemsAfterReceipt = rItems.some(
      (it) => toFiniteNumber(it.quantity_pending_after, 0) > 0
    )

    const hasAttachmentInBodega = rDocs.some((d) => {
      const hasFile =
        Boolean(d.storage_path && String(d.storage_path).trim()) ||
        Boolean(d.file_url && String(d.file_url).trim())
      if (!hasFile) return false
      if (docType === 'FA' && d.document_type === 'FA') {
        const docFolio = normalizeNumericFolioForReconciliation(d.document_number)
        return docFolio === null || docFolio === normalizedFolio
      }
      return true
    })

    const receivedDate = receipt.received_at
      ? String(receipt.received_at).slice(0, 10)
      : receipt.created_at
        ? String(receipt.created_at).slice(0, 10)
        : null

    const enriched: EnrichedWarehouseReceipt = {
      receipt,
      po,
      supplier,
      supplierId: po.supplier_id,
      normalizedRut,
      normalizedFolio,
      docType,
      breakdown: {
        receiptId: receipt.id,
        receiptNumber: receipt.receipt_number ?? null,
        purchaseOrderId: po.id,
        purchaseOrderCorrelative: po.correlative,
        purchaseOrderReceiptStatus: po.receipt_status,
        documentType: docType,
        documentFolio: normalizedFolio,
        documentDate: receipt.document_date ?? null,
        receivedDate,
        attributableNetAmount,
        attributableTaxAmount,
        attributableGrossAmountExact,
        attributableGrossAmountClp,
        itemsCount: rItems.length,
        unitsReceived,
        hasPendingItemsAfterReceipt,
        hasAttachmentInBodega,
      },
    }

    if (docType === 'FA') {
      eligibleWarehouseFaReceiptsCount++
      warehouseFaReceipts.push(enriched)
    } else {
      if (docType === 'GD') {
        eligibleWarehouseGdReceiptsCount++
      }
      warehouseOtherReceipts.push(enriched)
    }
  }

  // 3. Detectar colisiones de folio entre proveedores distintos (folios ambiguos si se consultara sin RUT)
  const folioSuppliersMap = new Map<
    string,
    Map<
      string,
      {
        issuerRutNormalized: string
        supplierName: string
        source: 'BSALE' | 'BODEGA'
        codeSiiOrDocType: string
        emissionOrDocDate: string | null
        amountClp: number
      }
    >
  >()

  for (const b of bsaleInvoices) {
    if (!b.normalizedFolio || !b.normalizedRut) continue
    let supMap = folioSuppliersMap.get(b.normalizedFolio)
    if (!supMap) {
      supMap = new Map()
      folioSuppliersMap.set(b.normalizedFolio, supMap)
    }
    if (!supMap.has(b.normalizedRut)) {
      supMap.set(b.normalizedRut, {
        issuerRutNormalized: b.normalizedRut,
        supplierName: b.client_activity,
        source: 'BSALE',
        codeSiiOrDocType: b.codeSiiTyped,
        emissionOrDocDate: b.emission_date,
        amountClp: b.totalAmountClp,
      })
    }
  }

  for (const r of warehouseFaReceipts) {
    if (!r.normalizedFolio || !r.normalizedRut) continue
    let supMap = folioSuppliersMap.get(r.normalizedFolio)
    if (!supMap) {
      supMap = new Map()
      folioSuppliersMap.set(r.normalizedFolio, supMap)
    }
    if (!supMap.has(r.normalizedRut)) {
      supMap.set(r.normalizedRut, {
        issuerRutNormalized: r.normalizedRut,
        supplierName: r.supplier?.business_name ?? 'Proveedor Bodega',
        source: 'BODEGA',
        codeSiiOrDocType: 'FA',
        emissionOrDocDate: r.breakdown.documentDate,
        amountClp: r.breakdown.attributableGrossAmountClp,
      })
    }
  }

  const crossSupplierAmbiguousFolios: CrossSupplierAmbiguousFolioEntry[] = []
  const collidingRutsByFolio = new Map<string, string[]>()

  for (const [folio, supMap] of folioSuppliersMap.entries()) {
    if (supMap.size > 1) {
      const suppliersList = Array.from(supMap.values()).sort((a, b) =>
        a.issuerRutNormalized.localeCompare(b.issuerRutNormalized)
      )
      crossSupplierAmbiguousFolios.push({
        documentFolio: folio,
        suppliers: suppliersList,
      })
      collidingRutsByFolio.set(
        folio,
        suppliersList.map((s) => s.issuerRutNormalized)
      )
    }
  }
  crossSupplierAmbiguousFolios.sort(
    (a, b) => Number(a.documentFolio) - Number(b.documentFolio)
  )

  // 4. Consolidar recepciones FA de Bodega por (issuer_rut_normalized, document_folio)
  //    Si una recepción carece de RUT válido o folio numérico, se mantiene aislada por receipt.id (como en cxp_receipt_candidates).
  interface ConsolidatedFaReceiptGroup {
    groupKey: string
    normalizedRut: string | null
    normalizedFolio: string | null
    supplierIds: Set<string>
    supplierName: string | null
    receipts: EnrichedWarehouseReceipt[]
    purchaseOrders: Map<string, BodegaPurchaseOrderInput>
  }

  const faGroupsMap = new Map<string, ConsolidatedFaReceiptGroup>()
  for (const r of warehouseFaReceipts) {
    const hasValidIdentity =
      r.normalizedRut !== null && r.normalizedFolio !== null
    const groupKey = hasValidIdentity
      ? `FA:${r.normalizedRut}:${r.normalizedFolio}`
      : `FA_INVALID:${r.receipt.id}`

    let group = faGroupsMap.get(groupKey)
    if (!group) {
      group = {
        groupKey,
        normalizedRut: r.normalizedRut,
        normalizedFolio: r.normalizedFolio,
        supplierIds: new Set<string>(),
        supplierName: r.supplier?.business_name ?? null,
        receipts: [],
        purchaseOrders: new Map<string, BodegaPurchaseOrderInput>(),
      }
      faGroupsMap.set(groupKey, group)
    }
    group.supplierIds.add(r.supplierId)
    if (!group.supplierName && r.supplier?.business_name) {
      group.supplierName = r.supplier.business_name
    }
    group.receipts.push(r)
    group.purchaseOrders.set(r.po.id, r.po)
  }

  // Indexar facturas Bsale (33 y 34) por (normalizedRut, normalizedFolio)
  const bsaleInvoicesByIdentity = new Map<string, typeof bsaleInvoices>()
  for (const b of bsaleInvoices) {
    const key =
      b.normalizedRut && b.normalizedFolio
        ? `${b.normalizedRut}:${b.normalizedFolio}`
        : `BSALE_INVALID:${b.bsaleDocumentIdNum}`
    const list = bsaleInvoicesByIdentity.get(key) ?? []
    list.push(b)
    bsaleInvoicesByIdentity.set(key, list)
  }

  const consumedBsaleIds = new Set<number>()
  const entries: ReconciledInvoiceEntry[] = []
  let earliestMatchedInvoiceEmissionDate: string | null = null

  // 5. Evaluar cada grupo consolidado de recepciones FA de Bodega
  for (const group of faGroupsMap.values()) {
    const breakdowns = group.receipts.map((r) => r.breakdown)
    const receivedNetExact = roundTo2(
      breakdowns.reduce((acc, b) => acc + b.attributableNetAmount, 0)
    )
    const receivedTaxExact = roundTo2(
      breakdowns.reduce((acc, b) => acc + b.attributableTaxAmount, 0)
    )
    const receivedGrossExact = roundTo2(
      breakdowns.reduce((acc, b) => acc + b.attributableGrossAmountExact, 0)
    )
    const receivedGrossClp = Math.round(receivedGrossExact)

    const poList = Array.from(group.purchaseOrders.values())
    const poIds = poList.map((p) => p.id)
    const poCorrelatives = poList.map((p) => p.correlative).sort()
    const poReceiptStatuses = poList.map((p) => p.receipt_status)

    const receiptDocDates = Array.from(
      new Set(
        breakdowns
          .map((b) => b.documentDate)
          .filter((d): d is string => Boolean(d))
      )
    ).sort()
    const receiptReceivedDates = Array.from(
      new Set(
        breakdowns
          .map((b) => b.receivedDate)
          .filter((d): d is string => Boolean(d))
      )
    ).sort()
    const hasInconsistentReceiptDates =
      receiptDocDates.length > 1 ||
      breakdowns.some((b) => b.documentDate === null)
    const hasBodegaAttachment = breakdowns.some((b) => b.hasAttachmentInBodega)

    const collidingRuts =
      group.normalizedFolio && collidingRutsByFolio.has(group.normalizedFolio)
        ? collidingRutsByFolio.get(group.normalizedFolio)!
        : []
    const hasCrossSupplierFolioCollision = collidingRuts.length > 1

    // Verificar si la identidad documental de la recepción en Bodega es válida y unívoca
    let ambiguityReason: string | null = null
    if (!group.normalizedRut) {
      ambiguityReason = 'Proveedor en Bodega sin RUT chileno válido'
    } else if (!group.normalizedFolio) {
      ambiguityReason = 'Recepción FA en Bodega sin folio numérico válido'
    } else if (group.supplierIds.size > 1) {
      ambiguityReason =
        'Mismo RUT y folio asociados a múltiples registros de proveedor en Bodega'
    }

    const identityKey =
      group.normalizedRut && group.normalizedFolio
        ? `${group.normalizedRut}:${group.normalizedFolio}`
        : null
    const matchingBsaleDocs = identityKey
      ? bsaleInvoicesByIdentity.get(identityKey) ?? []
      : []

    if (!ambiguityReason && matchingBsaleDocs.length > 1) {
      ambiguityReason = `Existen ${matchingBsaleDocs.length} facturas SII en Bsale con el mismo RUT (${group.normalizedRut}) y folio (${group.normalizedFolio})`
      for (const b of matchingBsaleDocs) {
        consumedBsaleIds.add(b.bsaleDocumentIdNum)
      }
    }

    if (ambiguityReason) {
      entries.push({
        reconciliationKey: group.groupKey,
        category: 'AMBIGUOUS_DOCUMENT_IDENTITY',
        companyId,
        issuerRutNormalized: group.normalizedRut,
        supplierId: Array.from(group.supplierIds)[0] ?? null,
        bsaleSupplierName: matchingBsaleDocs[0]?.client_activity ?? null,
        bodegaSupplierName: group.supplierName,
        codeSii: null,
        bodegaDocumentType: 'FA',
        documentFolio: group.normalizedFolio,
        bsaleDocumentId: null,
        siiStatus: null,
        hasBsalePdf: false,
        hasBsaleXml: false,
        hasBodegaAttachment,
        monetary: {
          status: 'UNCOMPARABLE',
          siiExemptAmount: null,
          siiNetAmount: null,
          siiTaxAmount: null,
          siiSpecificTaxAmount: null,
          siiTotalAmountClp: null,
          receivedNetAmountExact: receivedNetExact,
          receivedTaxAmountExact: receivedTaxExact,
          receivedGrossAmountExact: receivedGrossExact,
          receivedGrossAmountClp: receivedGrossClp,
          differenceClp: null,
          absDifferenceClp: null,
          differenceExact: null,
          hasSubPesoRoundingOnly: false,
        },
        receptionStatus: 'PENDING_DOCUMENT_LINK',
        dates: {
          siiEmissionDate: null,
          receiptDocumentDates: receiptDocDates,
          receiptReceivedDates,
          hasDocumentDateMismatch: false,
          hasInconsistentReceiptDates,
          maxReceptionLagDays: null,
          receivedAfterSiiEmission: false,
        },
        isHistoricalPreErpReceipts: false,
        hasCrossSupplierFolioCollision,
        collidingSupplierRuts: collidingRuts,
        ambiguityReason,
        receiptCount: breakdowns.length,
        purchaseOrderCount: poList.length,
        purchaseOrderIds: poIds,
        purchaseOrderCorrelatives: poCorrelatives,
        purchaseOrderReceiptStatuses: poReceiptStatuses,
        receipts: breakdowns,
      })
      continue
    }

    const hasPartialPurchaseOrder = poReceiptStatuses.some(
      (st) => st === 'RECEPCION_PARCIAL'
    )
    const receptionStatus: ReceptionReconciliationStatus =
      hasPartialPurchaseOrder ? 'PARTIAL' : 'COMPLETE'

    // Recepción FA de Bodega sin factura SII en el espejo Bsale (ej. FA 3908, FA 203)
    if (matchingBsaleDocs.length === 0) {
      entries.push({
        reconciliationKey: group.groupKey,
        category: 'RECEIPT_WITHOUT_BSALE_INVOICE',
        companyId,
        issuerRutNormalized: group.normalizedRut,
        supplierId: Array.from(group.supplierIds)[0] ?? null,
        bsaleSupplierName: null,
        bodegaSupplierName: group.supplierName,
        codeSii: null,
        bodegaDocumentType: 'FA',
        documentFolio: group.normalizedFolio,
        bsaleDocumentId: null,
        siiStatus: null,
        hasBsalePdf: false,
        hasBsaleXml: false,
        hasBodegaAttachment,
        monetary: {
          status: 'UNCOMPARABLE',
          siiExemptAmount: null,
          siiNetAmount: null,
          siiTaxAmount: null,
          siiSpecificTaxAmount: null,
          siiTotalAmountClp: null,
          receivedNetAmountExact: receivedNetExact,
          receivedTaxAmountExact: receivedTaxExact,
          receivedGrossAmountExact: receivedGrossExact,
          receivedGrossAmountClp: receivedGrossClp,
          differenceClp: null,
          absDifferenceClp: null,
          differenceExact: null,
          hasSubPesoRoundingOnly: false,
        },
        receptionStatus,
        dates: {
          siiEmissionDate: null,
          receiptDocumentDates: receiptDocDates,
          receiptReceivedDates,
          hasDocumentDateMismatch: false,
          hasInconsistentReceiptDates,
          maxReceptionLagDays: null,
          receivedAfterSiiEmission: false,
        },
        isHistoricalPreErpReceipts: false,
        hasCrossSupplierFolioCollision,
        collidingSupplierRuts: collidingRuts,
        ambiguityReason: null,
        receiptCount: breakdowns.length,
        purchaseOrderCount: poList.length,
        purchaseOrderIds: poIds,
        purchaseOrderCorrelatives: poCorrelatives,
        purchaseOrderReceiptStatuses: poReceiptStatuses,
        receipts: breakdowns,
      })
      continue
    }

    // Match unívoco por (company_id, issuer_rut_normalized, code_sii IN ('33','34') <-> FA, document_folio)
    const bsaleDoc = matchingBsaleDocs[0]
    consumedBsaleIds.add(bsaleDoc.bsaleDocumentIdNum)

    if (
      !earliestMatchedInvoiceEmissionDate ||
      bsaleDoc.emission_date < earliestMatchedInvoiceEmissionDate
    ) {
      earliestMatchedInvoiceEmissionDate = bsaleDoc.emission_date
    }

    const siiTotalClp = bsaleDoc.totalAmountClp
    const differenceClp = siiTotalClp - receivedGrossClp
    const absDifferenceClp = Math.abs(differenceClp)
    const differenceExact = roundTo2(siiTotalClp - receivedGrossExact)
    const monetaryStatus: MonetaryReconciliationStatus =
      differenceClp === 0 ? 'EXACT_MATCH' : 'AMOUNT_DIFFERENCE'
    const hasSubPesoRoundingOnly =
      differenceClp === 0 && Math.abs(differenceExact) > 0

    const hasDocumentDateMismatch =
      receiptDocDates.length === 0 ||
      receiptDocDates.some((d) => d !== bsaleDoc.emission_date)

    const latestReceivedDate =
      receiptReceivedDates.length > 0
        ? receiptReceivedDates[receiptReceivedDates.length - 1]
        : null
    const maxReceptionLagDays = latestReceivedDate
      ? diffDaysIso(bsaleDoc.emission_date, latestReceivedDate)
      : null
    const receivedAfterSiiEmission =
      maxReceptionLagDays !== null && maxReceptionLagDays > 0

    let category: ReconciliationCategory
    if (receptionStatus === 'COMPLETE' && monetaryStatus === 'EXACT_MATCH') {
      category = 'MATCHED_COMPLETE_EXACT'
    } else if (
      receptionStatus === 'COMPLETE' &&
      monetaryStatus === 'AMOUNT_DIFFERENCE'
    ) {
      category = 'MATCHED_COMPLETE_DIFFERENCE'
    } else if (
      receptionStatus === 'PARTIAL' &&
      monetaryStatus === 'EXACT_MATCH'
    ) {
      category = 'MATCHED_PARTIAL_EXACT'
    } else {
      category = 'MATCHED_PARTIAL_DIFFERENCE'
    }

    entries.push({
      reconciliationKey: `MATCH:${bsaleDoc.issuer_rut_normalized}:${bsaleDoc.codeSiiTyped}:${bsaleDoc.document_folio}`,
      category,
      companyId,
      issuerRutNormalized: bsaleDoc.normalizedRut,
      supplierId: Array.from(group.supplierIds)[0] ?? null,
      bsaleSupplierName: bsaleDoc.client_activity,
      bodegaSupplierName: group.supplierName,
      codeSii: bsaleDoc.codeSiiTyped,
      bodegaDocumentType: 'FA',
      documentFolio: bsaleDoc.normalizedFolio,
      bsaleDocumentId: bsaleDoc.bsaleDocumentIdNum,
      siiStatus: bsaleDoc.sii_status ?? null,
      hasBsalePdf: Boolean(bsaleDoc.url_pdf && bsaleDoc.url_pdf.trim()),
      hasBsaleXml: Boolean(bsaleDoc.url_xml && bsaleDoc.url_xml.trim()),
      hasBodegaAttachment,
      monetary: {
        status: monetaryStatus,
        siiExemptAmount: bsaleDoc.exemptAmountNum,
        siiNetAmount: bsaleDoc.netAmountNum,
        siiTaxAmount: bsaleDoc.ivaAmountNum,
        siiSpecificTaxAmount: bsaleDoc.specificTaxAmountNum,
        siiTotalAmountClp: siiTotalClp,
        receivedNetAmountExact: receivedNetExact,
        receivedTaxAmountExact: receivedTaxExact,
        receivedGrossAmountExact: receivedGrossExact,
        receivedGrossAmountClp: receivedGrossClp,
        differenceClp,
        absDifferenceClp,
        differenceExact,
        hasSubPesoRoundingOnly,
      },
      receptionStatus,
      dates: {
        siiEmissionDate: bsaleDoc.emission_date,
        receiptDocumentDates: receiptDocDates,
        receiptReceivedDates,
        hasDocumentDateMismatch,
        hasInconsistentReceiptDates,
        maxReceptionLagDays,
        receivedAfterSiiEmission,
      },
      isHistoricalPreErpReceipts: false,
      hasCrossSupplierFolioCollision,
      collidingSupplierRuts: collidingRuts,
      ambiguityReason: null,
      receiptCount: breakdowns.length,
      purchaseOrderCount: poList.length,
      purchaseOrderIds: poIds,
      purchaseOrderCorrelatives: poCorrelatives,
      purchaseOrderReceiptStatuses: poReceiptStatuses,
      receipts: breakdowns,
    })
  }

  // 6. Registrar recepciones de Bodega con Guía de Despacho (GD) u otro tipo sin factura vinculada
  //    Nunca se vinculan automáticamente por monto ni por OC/proveedor.
  for (const r of warehouseOtherReceipts) {
    const b = r.breakdown
    const isGd = r.docType === 'GD'
    entries.push({
      reconciliationKey: `${r.docType || 'OTHER'}:${r.normalizedRut ?? 'NORUT'}:${r.normalizedFolio ?? r.receipt.id}`,
      category: isGd
        ? 'GD_RECEIPT_WITHOUT_LINKED_INVOICE'
        : 'AMBIGUOUS_DOCUMENT_IDENTITY',
      companyId,
      issuerRutNormalized: r.normalizedRut,
      supplierId: r.supplierId,
      bsaleSupplierName: null,
      bodegaSupplierName: r.supplier?.business_name ?? null,
      codeSii: null,
      bodegaDocumentType: r.docType || null,
      documentFolio: r.normalizedFolio,
      bsaleDocumentId: null,
      siiStatus: null,
      hasBsalePdf: false,
      hasBsaleXml: false,
      hasBodegaAttachment: b.hasAttachmentInBodega,
      monetary: {
        status: 'UNCOMPARABLE',
        siiExemptAmount: null,
        siiNetAmount: null,
        siiTaxAmount: null,
        siiSpecificTaxAmount: null,
        siiTotalAmountClp: null,
        receivedNetAmountExact: b.attributableNetAmount,
        receivedTaxAmountExact: b.attributableTaxAmount,
        receivedGrossAmountExact: b.attributableGrossAmountExact,
        receivedGrossAmountClp: b.attributableGrossAmountClp,
        differenceClp: null,
        absDifferenceClp: null,
        differenceExact: null,
        hasSubPesoRoundingOnly: false,
      },
      receptionStatus: 'PENDING_DOCUMENT_LINK',
      dates: {
        siiEmissionDate: null,
        receiptDocumentDates: b.documentDate ? [b.documentDate] : [],
        receiptReceivedDates: b.receivedDate ? [b.receivedDate] : [],
        hasDocumentDateMismatch: false,
        hasInconsistentReceiptDates: false,
        maxReceptionLagDays: null,
        receivedAfterSiiEmission: false,
      },
      isHistoricalPreErpReceipts: false,
      hasCrossSupplierFolioCollision: false,
      collidingSupplierRuts: [],
      ambiguityReason: isGd
        ? 'Recepción registrada con Guía de Despacho (GD) sin folio de factura vinculado'
        : `Tipo de documento de recepción no conciliable directamente con factura SII: "${r.docType}"`,
      receiptCount: 1,
      purchaseOrderCount: 1,
      purchaseOrderIds: [r.po.id],
      purchaseOrderCorrelatives: [r.po.correlative],
      purchaseOrderReceiptStatuses: [r.po.receipt_status],
      receipts: [b],
    })
  }

  // 7. Evaluar facturas SII de Bsale (33 y 34) sin recepción en Bodega
  //    Nunca se clasifican automáticamente como Servicios.
  //    Se distinguen las históricas previas a la puesta en marcha de recepciones ERP (< erpReceiptsGoLiveDate)
  //    de las emitidas durante el período operativo (>= erpReceiptsGoLiveDate).
  for (const bsaleDoc of bsaleInvoices) {
    if (consumedBsaleIds.has(bsaleDoc.bsaleDocumentIdNum)) continue

    const isHistoricalPreErpReceipts =
      bsaleDoc.emission_date < erpReceiptsGoLiveDate
    const collidingRuts =
      bsaleDoc.normalizedFolio &&
      collidingRutsByFolio.has(bsaleDoc.normalizedFolio)
        ? collidingRutsByFolio.get(bsaleDoc.normalizedFolio)!
        : []
    const hasCrossSupplierFolioCollision = collidingRuts.length > 1

    const category: ReconciliationCategory = isHistoricalPreErpReceipts
      ? 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL'
      : 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'

    entries.push({
      reconciliationKey: `BSALE_ONLY:${bsaleDoc.bsaleDocumentIdNum}`,
      category,
      companyId,
      issuerRutNormalized: bsaleDoc.normalizedRut,
      supplierId: null,
      bsaleSupplierName: bsaleDoc.client_activity,
      bodegaSupplierName: null,
      codeSii: bsaleDoc.codeSiiTyped,
      bodegaDocumentType: null,
      documentFolio: bsaleDoc.normalizedFolio,
      bsaleDocumentId: bsaleDoc.bsaleDocumentIdNum,
      siiStatus: bsaleDoc.sii_status ?? null,
      hasBsalePdf: Boolean(bsaleDoc.url_pdf && bsaleDoc.url_pdf.trim()),
      hasBsaleXml: Boolean(bsaleDoc.url_xml && bsaleDoc.url_xml.trim()),
      hasBodegaAttachment: false,
      monetary: {
        status: 'UNCOMPARABLE',
        siiExemptAmount: bsaleDoc.exemptAmountNum,
        siiNetAmount: bsaleDoc.netAmountNum,
        siiTaxAmount: bsaleDoc.ivaAmountNum,
        siiSpecificTaxAmount: bsaleDoc.specificTaxAmountNum,
        siiTotalAmountClp: bsaleDoc.totalAmountClp,
        receivedNetAmountExact: null,
        receivedTaxAmountExact: null,
        receivedGrossAmountExact: null,
        receivedGrossAmountClp: null,
        differenceClp: null,
        absDifferenceClp: null,
        differenceExact: null,
        hasSubPesoRoundingOnly: false,
      },
      receptionStatus: 'NO_RECEIPT',
      dates: {
        siiEmissionDate: bsaleDoc.emission_date,
        receiptDocumentDates: [],
        receiptReceivedDates: [],
        hasDocumentDateMismatch: false,
        hasInconsistentReceiptDates: false,
        maxReceptionLagDays: null,
        receivedAfterSiiEmission: false,
      },
      isHistoricalPreErpReceipts,
      hasCrossSupplierFolioCollision,
      collidingSupplierRuts: collidingRuts,
      ambiguityReason: null,
      receiptCount: 0,
      purchaseOrderCount: 0,
      purchaseOrderIds: [],
      purchaseOrderCorrelatives: [],
      purchaseOrderReceiptStatuses: [],
      receipts: [],
    })
  }

  // 8. Calcular resúmenes y subconjuntos
  const byCategory: Record<ReconciliationCategory, number> = {
    MATCHED_COMPLETE_EXACT: 0,
    MATCHED_COMPLETE_DIFFERENCE: 0,
    MATCHED_PARTIAL_EXACT: 0,
    MATCHED_PARTIAL_DIFFERENCE: 0,
    BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL: 0,
    BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL: 0,
    RECEIPT_WITHOUT_BSALE_INVOICE: 0,
    GD_RECEIPT_WITHOUT_LINKED_INVOICE: 0,
    AMBIGUOUS_DOCUMENT_IDENTITY: 0,
  }

  const matchedEntries: ReconciledInvoiceEntry[] = []
  const receiptsWithoutBsaleInvoice: ReconciledInvoiceEntry[] = []
  const gdReceiptsWithoutLinkedInvoice: ReconciledInvoiceEntry[] = []
  const ambiguousEntries: ReconciledInvoiceEntry[] = []
  const bsaleInvoicesWithoutReceipt: ReconciledInvoiceEntry[] = []

  let monetaryExactMatchCount = 0
  let monetaryAmountDifferenceCount = 0
  let receptionCompleteCount = 0
  let receptionPartialCount = 0
  let receptionNoReceiptCount = 0
  let receptionPendingDocumentLinkCount = 0
  let matchedMultiReceiptInvoicesCount = 0
  let matchedMultiPurchaseOrderInvoicesCount = 0
  let matchedWithDocumentDateMismatchCount = 0
  let matchedWithInconsistentReceiptDatesCount = 0
  let matchedReceivedAfterSiiEmissionCount = 0

  for (const entry of entries) {
    byCategory[entry.category]++

    if (entry.monetary.status === 'EXACT_MATCH') monetaryExactMatchCount++
    if (entry.monetary.status === 'AMOUNT_DIFFERENCE') {
      monetaryAmountDifferenceCount++
    }

    if (entry.receptionStatus === 'COMPLETE') receptionCompleteCount++
    if (entry.receptionStatus === 'PARTIAL') receptionPartialCount++
    if (entry.receptionStatus === 'NO_RECEIPT') receptionNoReceiptCount++
    if (entry.receptionStatus === 'PENDING_DOCUMENT_LINK') {
      receptionPendingDocumentLinkCount++
    }

    if (
      entry.category === 'MATCHED_COMPLETE_EXACT' ||
      entry.category === 'MATCHED_COMPLETE_DIFFERENCE' ||
      entry.category === 'MATCHED_PARTIAL_EXACT' ||
      entry.category === 'MATCHED_PARTIAL_DIFFERENCE'
    ) {
      matchedEntries.push(entry)
      if (entry.receiptCount > 1) matchedMultiReceiptInvoicesCount++
      if (entry.purchaseOrderCount > 1) matchedMultiPurchaseOrderInvoicesCount++
      if (entry.dates.hasDocumentDateMismatch) {
        matchedWithDocumentDateMismatchCount++
      }
      if (entry.dates.hasInconsistentReceiptDates) {
        matchedWithInconsistentReceiptDatesCount++
      }
      if (entry.dates.receivedAfterSiiEmission) {
        matchedReceivedAfterSiiEmissionCount++
      }
    } else if (entry.category === 'RECEIPT_WITHOUT_BSALE_INVOICE') {
      receiptsWithoutBsaleInvoice.push(entry)
    } else if (entry.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE') {
      gdReceiptsWithoutLinkedInvoice.push(entry)
    } else if (entry.category === 'AMBIGUOUS_DOCUMENT_IDENTITY') {
      ambiguousEntries.push(entry)
    } else if (
      entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL' ||
      entry.category === 'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'
    ) {
      bsaleInvoicesWithoutReceipt.push(entry)
    }
  }

  return {
    companyId,
    erpReceiptsGoLiveDate,
    earliestWarehouseReceiptCreatedDate,
    earliestMatchedInvoiceEmissionDate,
    counts: {
      totalBsaleMirrorDocuments:
        bsaleInvoices.length + deferredNotes.length,
      totalBsaleInvoices: bsaleInvoices.length,
      totalBsaleInvoices33: bsaleInvoices.filter((b) => b.codeSiiTyped === '33')
        .length,
      totalBsaleInvoices34: bsaleInvoices.filter((b) => b.codeSiiTyped === '34')
        .length,
      deferredBsaleNotesTotal: deferredNotes.length,
      deferredBsaleCreditNotes61: deferredNotes.filter(
        (n) => n.codeSii === '61'
      ).length,
      deferredBsaleDebitNotes56: deferredNotes.filter((n) => n.codeSii === '56')
        .length,
      totalRawReceiptsRead: seenReceiptIds.size,
      excludedNonWarehouseOrServiceReceiptsCount,
      eligibleWarehouseReceiptsCount,
      eligibleWarehouseFaReceiptsCount,
      eligibleWarehouseGdReceiptsCount,
      consolidatedWarehouseFaGroupsCount: faGroupsMap.size,
      matchedInvoicesCount: matchedEntries.length,
      matchedMultiReceiptInvoicesCount,
      matchedMultiPurchaseOrderInvoicesCount,
      monetaryExactMatchCount,
      monetaryAmountDifferenceCount,
      receptionCompleteCount,
      receptionPartialCount,
      receptionNoReceiptCount,
      receptionPendingDocumentLinkCount,
      byCategory,
      bsaleInvoicesWithoutReceiptTotal: bsaleInvoicesWithoutReceipt.length,
      bsaleInvoicesWithoutReceiptHistoricalCount:
        byCategory.BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL,
      bsaleInvoicesWithoutReceiptOperationalCount:
        byCategory.BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL,
      receiptsWithoutBsaleInvoiceCount: receiptsWithoutBsaleInvoice.length,
      gdReceiptsWithoutLinkedInvoiceCount:
        gdReceiptsWithoutLinkedInvoice.length,
      ambiguousDocumentIdentityCount: ambiguousEntries.length,
      crossSupplierAmbiguousFoliosCount: crossSupplierAmbiguousFolios.length,
      matchedWithDocumentDateMismatchCount,
      matchedWithInconsistentReceiptDatesCount,
      matchedReceivedAfterSiiEmissionCount,
    },
    entries,
    matchedEntries,
    receiptsWithoutBsaleInvoice,
    gdReceiptsWithoutLinkedInvoice,
    ambiguousEntries,
    bsaleInvoicesWithoutReceipt,
    deferredNotes,
    crossSupplierAmbiguousFolios,
  }
}

/**
 * Carga en modo estrictamente de solo lectura los datos del espejo Bsale y de Bodega Caylo
 * desde Supabase y ejecuta el motor de conciliación.
 */
export interface SupabaseReconciliationReadClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: (schemaName: string) => any
}

export async function fetchAndReconcileBsaleBodegaForCaylo(
  supabaseReadClient: SupabaseReconciliationReadClient,
  options?: {
    erpReceiptsGoLiveDate?: string
  }
): Promise<BsaleBodegaReconciliationReport> {
  const [
    bsaleRes,
    receiptsRes,
    posRes,
    suppliersRes,
    receiptItemsRes,
    receiptDocsRes,
  ] = await Promise.all([
    supabaseReadClient
      .schema('integraciones')
      .from('bsale_third_party_documents')
      .select(
        'id, company_id, bsale_document_id, code_sii, document_number, document_folio, client_code, issuer_rut_normalized, client_activity, emission_date, sii_reception_date, tax_month, tax_year, exempt_amount, net_amount, iva_rate, iva_amount, specific_tax_amount, total_amount, sii_status, add_book, include_flag, canceled, url_pdf, url_xml'
      )
      .eq('company_id', CAYLO_COMPANY_ID),
    supabaseReadClient
      .schema('logistica')
      .from('purchase_receipts')
      .select(
        'id, company_id, purchase_order_id, receipt_number, receiving_type, status, document_type, document_number, document_date, received_at, created_at, receipt_total_net, receipt_total_tax, receipt_total_gross'
      )
      .eq('company_id', CAYLO_COMPANY_ID),
    supabaseReadClient
      .schema('adquisiciones')
      .from('purchase_orders')
      .select(
        'id, company_id, correlative, supplier_id, po_type, status, receipt_status, is_active, net_total, tax_total, grand_total'
      )
      .eq('company_id', CAYLO_COMPANY_ID),
    supabaseReadClient
      .schema('adquisiciones')
      .from('suppliers')
      .select('id, company_id, business_name, rut, rut_normalized'),
    supabaseReadClient
      .schema('logistica')
      .from('purchase_receipt_items')
      .select(
        'id, receipt_id, purchase_order_item_id, quantity_ordered, quantity_previously_received, quantity_received, quantity_pending_after, quantity_rejected, quantity_missing, net_amount, tax_amount, gross_amount'
      )
      .eq('company_id', CAYLO_COMPANY_ID),
    supabaseReadClient
      .schema('logistica')
      .from('receipt_documents')
      .select(
        'id, company_id, receipt_id, document_type, document_number, storage_path, file_url'
      )
      .eq('company_id', CAYLO_COMPANY_ID),
  ])

  for (const [label, res] of [
    ['integraciones.bsale_third_party_documents', bsaleRes],
    ['logistica.purchase_receipts', receiptsRes],
    ['adquisiciones.purchase_orders', posRes],
    ['adquisiciones.suppliers', suppliersRes],
    ['logistica.purchase_receipt_items', receiptItemsRes],
    ['logistica.receipt_documents', receiptDocsRes],
  ] as const) {
    if (res.error) {
      throw new Error(`Error al leer ${label}: ${res.error.message}`)
    }
  }

  return reconcileBsaleAndBodegaForCaylo({
    companyId: CAYLO_COMPANY_ID,
    erpReceiptsGoLiveDate: options?.erpReceiptsGoLiveDate,
    bsaleDocuments: (bsaleRes.data ?? []) as BsaleMirrorDocumentInput[],
    receipts: (receiptsRes.data ?? []) as BodegaReceiptInput[],
    purchaseOrders: (posRes.data ?? []) as BodegaPurchaseOrderInput[],
    suppliers: (suppliersRes.data ?? []) as BodegaSupplierInput[],
    receiptItems: (receiptItemsRes.data ?? []) as BodegaReceiptItemInput[],
    receiptDocuments: (receiptDocsRes.data ??
      []) as BodegaReceiptDocumentInput[],
  })
}
