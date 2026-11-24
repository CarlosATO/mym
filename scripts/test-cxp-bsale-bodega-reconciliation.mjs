import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'))

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const targetPath = path.join(repoRoot, 'src', specifier.slice(2))
      const withExt = fs.existsSync(`${targetPath}.ts`)
        ? `${targetPath}.ts`
        : targetPath
      return nextResolve(pathToFileURL(withExt).href, context)
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL))
      const candidateTs = path.resolve(parentDir, `${specifier}.ts`)
      if (fs.existsSync(candidateTs)) {
        return nextResolve(pathToFileURL(candidateTs).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

const {
  CAYLO_COMPANY_ID,
  fetchAndReconcileBsaleBodegaForCaylo,
  normalizeNumericFolioForReconciliation,
  normalizeRutForReconciliation,
  reconcileBsaleAndBodegaForCaylo,
} = await import('../src/modules/cuentas-por-pagar/bsale-bodega-reconciliation.ts')

const {
  buildBsaleSupplierFilterOptions,
  buildDocumentaryAlertsForEntry,
  extractBodegaIncidentsFromReport,
  extractSiiInvoicesFromReport,
  filterAndPaginateBsaleInvoices,
  HISTORICAL_PAYMENT_PENDING_LABEL,
  resolveFinancialAccreditationBadge,
  resolveFinancialInboxGroup,
  resolveMonetaryReconciliationBadge,
  resolvePhysicalReceptionBadge,
  summarizeFinancialInboxGroups,
} = await import('../src/modules/cuentas-por-pagar/bsale-reconciliation-view-model.ts')

const {
  addCivilDaysToIsoDate,
  buildBsaleBodegaFinancialReconciliationView,
  parseExplicitCreditDays,
} = await import('../src/modules/cuentas-por-pagar/bsale-financial-balance-resolver.ts')

function loadEnvLocal() {
  const envPath = path.join(repoRoot, '.env.local')
  if (!fs.existsSync(envPath)) return
  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

async function runUnitTests() {
  console.log('1. Pruebas unitarias del motor de conciliación Bsale ↔ Bodega...')

  assert.equal(normalizeRutForReconciliation('76.100.687-8'), '761006878')
  assert.equal(normalizeRutForReconciliation('77.763.917-k'), '77763917K')
  assert.equal(normalizeRutForReconciliation('INVALID'), null)

  assert.equal(normalizeNumericFolioForReconciliation('00163496'), '163496')
  assert.equal(normalizeNumericFolioForReconciliation('GD-147'), null)

  const suppliers = [
    {
      id: 'sup-marben',
      company_id: CAYLO_COMPANY_ID,
      business_name: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
      rut: '76.100.687-8',
    },
    {
      id: 'sup-south',
      company_id: CAYLO_COMPANY_ID,
      business_name: 'SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA',
      rut: '76661486-8',
    },
    {
      id: 'sup-caf',
      company_id: CAYLO_COMPANY_ID,
      business_name: 'CHILEAN ANIMAL FOOD COMPANY SPA',
      rut: '77152885-6',
    },
    {
      id: 'sup-atompet',
      company_id: CAYLO_COMPANY_ID,
      business_name: 'ATOMPET CHILE SPA',
      rut: '77763917-K',
    },
    {
      id: 'sup-nano',
      company_id: CAYLO_COMPANY_ID,
      business_name: 'INDUSTRIAL NANO LIMITADA',
      rut: '76036890-3',
    },
  ]

  const purchaseOrders = [
    {
      id: 'po-86',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000086',
      supplier_id: 'sup-marben',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_TOTAL',
      receipt_status: 'RECEPCION_TOTAL',
      is_active: true,
      grand_total: 373184,
    },
    {
      id: 'po-52',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000052',
      supplier_id: 'sup-south',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_TOTAL',
      receipt_status: 'RECEPCION_TOTAL',
      is_active: true,
      grand_total: 99999999, // No debe sumarse nunca el total de la OC
    },
    {
      id: 'po-72',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000072',
      supplier_id: 'sup-south',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_TOTAL',
      receipt_status: 'RECEPCION_TOTAL',
      is_active: true,
      grand_total: 88888888,
    },
    {
      id: 'po-53',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000053',
      supplier_id: 'sup-caf',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_PARCIAL',
      receipt_status: 'RECEPCION_PARCIAL',
      is_active: true,
      grand_total: 15000000,
    },
    {
      id: 'po-69',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000069',
      supplier_id: 'sup-atompet',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_TOTAL',
      receipt_status: 'RECEPCION_TOTAL',
      is_active: true,
    },
    {
      id: 'po-57',
      company_id: CAYLO_COMPANY_ID,
      correlative: 'OC-2026-000057',
      supplier_id: 'sup-nano',
      po_type: 'PRODUCTOS',
      status: 'RECEPCION_TOTAL',
      receipt_status: 'RECEPCION_TOTAL',
      is_active: true,
    },
  ]

  const bsaleDocuments = [
    // 1. FA 163496 Marben Pets: match exacto ($373.184)
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9565,
      code_sii: '33',
      document_number: 163496,
      document_folio: '163496',
      client_code: '76100687-8',
      issuer_rut_normalized: '761006878',
      client_activity: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
      emission_date: '2026-11-19',
      net_amount: 313600,
      iva_amount: 59584,
      total_amount: 373184,
      sii_status: null,
    },
    // 2. FA 98958 Southernking: múltiples recepciones y múltiples OCs
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9484,
      code_sii: '33',
      document_number: 98958,
      document_folio: '98958',
      client_code: '76661486-8',
      issuer_rut_normalized: '766614868',
      client_activity: 'SOCIEDAD IMPORTADORA SOUTHERNKING LIMITADA',
      emission_date: '2026-10-28',
      net_amount: 3344663,
      iva_amount: 635485,
      total_amount: 3980148,
      sii_status: ['ERM'],
    },
    // 3. FA 1605 Chilean Animal Food: recepción parcial
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9491,
      code_sii: '33',
      document_number: 1605,
      document_folio: '1605',
      client_code: '77152885-6',
      issuer_rut_normalized: '771528856',
      client_activity: 'CHILEAN ANIMAL FOOD COMPANY SPA',
      emission_date: '2026-10-31',
      net_amount: 9750000,
      iva_amount: 1852500,
      total_amount: 11602500,
      sii_status: ['ERM'],
    },
    // 4. Colisión de folio 2458 entre dos proveedores distintos (Atompet en abr-2026 vs Industrial Nano en nov-2026)
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 8799,
      code_sii: '33',
      document_number: 2458,
      document_folio: '2458',
      client_code: '77763917-K',
      issuer_rut_normalized: '77763917K',
      client_activity: 'Atompet Chile SPA',
      emission_date: '2026-04-17', // Histórico pre go-live
      net_amount: 2735940,
      iva_amount: 519829,
      total_amount: 3255769,
      sii_status: ['ACD', 'ERM'],
    },
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9510,
      code_sii: '33',
      document_number: 2458,
      document_folio: '2458',
      client_code: '76036890-3',
      issuer_rut_normalized: '760368903',
      client_activity: 'INDUSTRIAL NANO LIMITADA',
      emission_date: '2026-11-04',
      net_amount: 628900,
      iva_amount: 119491,
      total_amount: 748391,
      sii_status: ['ERM'],
    },
    // 5. Factura SII en período operativo (>= 2026-10-01) sin recepción en Bodega (no debe clasificarse como Servicio)
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9560,
      code_sii: '34',
      document_number: 9991,
      document_folio: '9991',
      client_code: '77763917-K',
      issuer_rut_normalized: '77763917K',
      client_activity: 'ATOMPET CHILE SPA',
      emission_date: '2026-11-18',
      exempt_amount: 3973481, // Mismo monto que FA 3908 pero distinto folio: NO debe conciliar por monto
      net_amount: 0,
      iva_amount: 0,
      total_amount: 3973481,
      sii_status: ['ERM'],
    },
    // 6. Nota de crédito (61) y Nota de débito (56): deben quedar fuera del cálculo inicial
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 9231,
      code_sii: '61',
      document_number: 7211,
      document_folio: '7211',
      client_code: '76100687-8',
      issuer_rut_normalized: '761006878',
      client_activity: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
      emission_date: '2026-03-20',
      total_amount: 43226,
      sii_status: null,
    },
    {
      company_id: CAYLO_COMPANY_ID,
      bsale_document_id: 8913,
      code_sii: '56',
      document_number: 66064,
      document_folio: '66064',
      client_code: '76100687-8',
      issuer_rut_normalized: '761006878',
      client_activity: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
      emission_date: '2026-02-18',
      total_amount: 11900,
      sii_status: null,
    },
  ]

  const receipts = [
    // FA 163496
    {
      id: 'rec-163496',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-86',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '163496',
      document_date: '2026-11-18',
      received_at: '2026-11-19T16:20:30Z',
      receipt_total_net: 313600,
      receipt_total_tax: 59584,
      receipt_total_gross: 373184,
    },
    // FA 98958: 3 recepciones en 2 OCs (+ 1 copia duplicada del mismo receipt.id para verificar deduplicación)
    {
      id: 'rec-98958-1',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-52',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '98958',
      document_date: '2026-10-28',
      received_at: '2026-10-30T18:26:43Z',
      receipt_total_net: 3173682,
      receipt_total_tax: 602999.58,
      receipt_total_gross: 3776681.58,
    },
    {
      id: 'rec-98958-1', // Duplicado intencional del mismo ID de recepción
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-52',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '98958',
      document_date: '2026-10-28',
      received_at: '2026-10-30T18:26:43Z',
      receipt_total_net: 3173682,
      receipt_total_tax: 602999.58,
      receipt_total_gross: 3776681.58,
    },
    {
      id: 'rec-98958-2',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-52',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '98958',
      document_date: '2026-10-30',
      received_at: '2026-10-30T19:23:00Z',
      receipt_total_net: 122784,
      receipt_total_tax: 23328.96,
      receipt_total_gross: 146112.96,
    },
    {
      id: 'rec-98958-3',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-72',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '98958',
      document_date: '2026-11-04',
      received_at: '2026-11-04T18:50:11Z',
      receipt_total_net: 69607.04,
      receipt_total_tax: 13225.3376,
      receipt_total_gross: 82832.3776,
    },
    // FA 1605 (recepción parcial)
    {
      id: 'rec-1605',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-53',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '1605',
      document_date: '2026-10-31',
      received_at: '2026-11-09T18:11:02Z',
      receipt_total_net: 7500000,
      receipt_total_tax: 1425000,
      receipt_total_gross: 8925000,
    },
    // GD 147 (Guía de despacho en la misma OC-2026-000053, sin asociación segura)
    {
      id: 'rec-gd-147',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-53',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'GD',
      document_number: '147',
      document_date: '2026-11-16',
      received_at: '2026-11-16T17:43:35Z',
      receipt_total_net: 1000000,
      receipt_total_tax: 190000,
      receipt_total_gross: 1190000,
    },
    // FA 3908 (sin factura en Bsale; aunque existe factura folio 9991 del mismo proveedor y mismo monto, NO debe vincularse por monto)
    {
      id: 'rec-3908',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-69',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '3908',
      document_date: '2026-10-30',
      received_at: '2026-11-03T20:19:49Z',
      receipt_total_net: 3339060,
      receipt_total_tax: 634421.4,
      receipt_total_gross: 3973481.4,
    },
    // FA 2458 de Industrial Nano (760368903) -> debe conciliar con Industrial Nano y no con Atompet (77763917K)
    {
      id: 'rec-2458-nano',
      company_id: CAYLO_COMPANY_ID,
      purchase_order_id: 'po-57',
      receiving_type: 'WAREHOUSE',
      status: 'COMPLETED',
      document_type: 'FA',
      document_number: '2458',
      document_date: '2026-11-04',
      received_at: '2026-11-09T12:00:00Z',
      receipt_total_net: 628900,
      receipt_total_tax: 119491,
      receipt_total_gross: 748391,
    },
  ]

  const report = reconcileBsaleAndBodegaForCaylo({
    bsaleDocuments,
    receipts,
    purchaseOrders,
    suppliers,
  })

  // Notas de crédito y débito excluidas del cálculo inicial
  assert.equal(report.counts.deferredBsaleNotesTotal, 2)
  assert.equal(report.counts.deferredBsaleCreditNotes61, 1)
  assert.equal(report.counts.deferredBsaleDebitNotes56, 1)

  // Verificar FA 163496: diferencia $0
  const fa163496 = report.matchedEntries.find((e) => e.documentFolio === '163496')
  assert.ok(fa163496)
  assert.equal(fa163496.category, 'MATCHED_COMPLETE_EXACT')
  assert.equal(fa163496.monetary.status, 'EXACT_MATCH')
  assert.equal(fa163496.monetary.siiTotalAmountClp, 373184)
  assert.equal(fa163496.monetary.receivedGrossAmountClp, 373184)
  assert.equal(fa163496.monetary.differenceClp, 0)
  assert.equal(fa163496.receptionStatus, 'COMPLETE')
  assert.equal(fa163496.dates.hasDocumentDateMismatch, true)

  // Verificar FA 98958: 3 recepciones consolidadas (4.ª duplicada ignorada), 2 OCs, sin sumar total de OCs
  const fa98958 = report.matchedEntries.find((e) => e.documentFolio === '98958')
  assert.ok(fa98958)
  assert.equal(fa98958.receiptCount, 3)
  assert.equal(fa98958.purchaseOrderCount, 2)
  assert.deepEqual(fa98958.purchaseOrderCorrelatives, [
    'OC-2026-000052',
    'OC-2026-000072',
  ])
  assert.equal(fa98958.monetary.siiTotalAmountClp, 3980148)
  assert.equal(fa98958.monetary.receivedGrossAmountExact, 4005626.92)
  assert.equal(fa98958.monetary.receivedGrossAmountClp, 4005627)
  assert.equal(fa98958.monetary.differenceClp, -25479)
  assert.equal(fa98958.monetary.status, 'AMOUNT_DIFFERENCE')
  assert.equal(fa98958.receptionStatus, 'COMPLETE')
  assert.equal(fa98958.dates.hasInconsistentReceiptDates, true)

  // Verificar FA 1605: recepción parcial
  const fa1605 = report.matchedEntries.find((e) => e.documentFolio === '1605')
  assert.ok(fa1605)
  assert.equal(fa1605.category, 'MATCHED_PARTIAL_DIFFERENCE')
  assert.equal(fa1605.receptionStatus, 'PARTIAL')
  assert.equal(fa1605.monetary.status, 'AMOUNT_DIFFERENCE')
  assert.equal(fa1605.monetary.siiTotalAmountClp, 11602500)
  assert.equal(fa1605.monetary.receivedGrossAmountClp, 8925000)
  assert.equal(fa1605.monetary.differenceClp, 2677500)

  // Verificar FA 3908: sin factura Bsale (NO se vincula por monto con folio 9991)
  const fa3908 = report.receiptsWithoutBsaleInvoice.find(
    (e) => e.documentFolio === '3908'
  )
  assert.ok(fa3908)
  assert.equal(fa3908.category, 'RECEIPT_WITHOUT_BSALE_INVOICE')
  assert.equal(fa3908.bsaleDocumentId, null)
  assert.equal(fa3908.monetary.status, 'UNCOMPARABLE')
  assert.equal(fa3908.monetary.receivedGrossAmountClp, 3973481)

  // Verificar GD 147: recepción con Guía de Despacho sin asociación segura
  const gd147 = report.gdReceiptsWithoutLinkedInvoice.find(
    (e) => e.documentFolio === '147'
  )
  assert.ok(gd147)
  assert.equal(gd147.category, 'GD_RECEIPT_WITHOUT_LINKED_INVOICE')
  assert.equal(gd147.receptionStatus, 'PENDING_DOCUMENT_LINK')
  assert.equal(gd147.monetary.status, 'UNCOMPARABLE')
  assert.equal(gd147.monetary.receivedGrossAmountClp, 1190000)

  // Verificar colisión de folio 2458 entre dos proveedores y distinción histórica vs operativa
  assert.equal(report.crossSupplierAmbiguousFolios.length, 1)
  assert.equal(report.crossSupplierAmbiguousFolios[0].documentFolio, '2458')
  const matched2458 = report.matchedEntries.find((e) => e.documentFolio === '2458')
  assert.ok(matched2458)
  assert.equal(matched2458.issuerRutNormalized, '760368903')
  assert.equal(matched2458.hasCrossSupplierFolioCollision, true)

  const unmatchedHistorical2458 = report.bsaleInvoicesWithoutReceipt.find(
    (e) => e.bsaleDocumentId === 8799
  )
  assert.ok(unmatchedHistorical2458)
  assert.equal(
    unmatchedHistorical2458.category,
    'BSALE_INVOICE_WITHOUT_RECEIPT_HISTORICAL'
  )
  assert.equal(unmatchedHistorical2458.isHistoricalPreErpReceipts, true)

  const unmatchedOperational9991 = report.bsaleInvoicesWithoutReceipt.find(
    (e) => e.bsaleDocumentId === 9560
  )
  assert.ok(unmatchedOperational9991)
  assert.equal(
    unmatchedOperational9991.category,
    'BSALE_INVOICE_WITHOUT_RECEIPT_OPERATIONAL'
  )
  assert.equal(unmatchedOperational9991.isHistoricalPreErpReceipts, false)

  // Verificar modelo de vista de la pantalla Bloque 3 (separación de 777 facturas SII vs incidencias de Bodega, filtros, badges y alertas)
  const siiInvoices = extractSiiInvoicesFromReport(report)
  const bodegaIncidents = extractBodegaIncidentsFromReport(report)
  assert.equal(
    siiInvoices.length,
    6,
    'Solo las facturas SII 33/34 entran a la tabla principal'
  )
  assert.equal(
    bodegaIncidents.length,
    2,
    'FA 3908 sin SII y GD 147 van a la sección separada de incidencias de Bodega'
  )
  assert.ok(
    siiInvoices[0].dates.siiEmissionDate >=
      siiInvoices[siiInvoices.length - 1].dates.siiEmissionDate,
    'Ordenadas desde la más reciente por defecto'
  )

  // Verificar separación de badges monetario vs físico y alertas en FA 163496, FA 98958, FA 1605 e históricas/operativas
  assert.equal(
    HISTORICAL_PAYMENT_PENDING_LABEL,
    'Situación de pago pendiente de conciliación histórica'
  )
  assert.equal(resolveMonetaryReconciliationBadge(fa163496).label, 'Coincidencia exacta')
  assert.equal(resolvePhysicalReceptionBadge(fa163496).label, 'Recepción completa')
  assert.ok(
    buildDocumentaryAlertsForEntry(fa163496).some(
      (a) => a.id === 'document-date-mismatch'
    )
  )

  assert.equal(resolveMonetaryReconciliationBadge(fa98958).label, 'Con diferencia')
  assert.equal(resolvePhysicalReceptionBadge(fa98958).label, 'Recepción completa')
  assert.ok(
    buildDocumentaryAlertsForEntry(fa98958).some(
      (a) => a.id === 'inconsistent-receipt-dates'
    )
  )

  assert.equal(resolveMonetaryReconciliationBadge(fa1605).label, 'Con diferencia')
  assert.equal(resolvePhysicalReceptionBadge(fa1605).label, 'Recepción parcial')

  assert.equal(
    resolveMonetaryReconciliationBadge(unmatchedHistorical2458).label,
    'Histórica pre-Bodega'
  )
  assert.equal(
    resolvePhysicalReceptionBadge(unmatchedHistorical2458).label,
    'Sin recepción (Histórica)'
  )
  assert.equal(
    resolveMonetaryReconciliationBadge(unmatchedOperational9991).label,
    'Sin cruce Bodega'
  )
  assert.equal(
    resolvePhysicalReceptionBadge(unmatchedOperational9991).label,
    'Sin recepción en Bodega'
  )

  // Verificar filtros por proveedor, folio, rango de fechas, estado y paginación
  const filteredByFolio = filterAndPaginateBsaleInvoices(siiInvoices, {
    folioQuery: '0163496',
  })
  assert.equal(filteredByFolio.totalItems, 1)
  assert.equal(filteredByFolio.items[0].documentFolio, '163496')

  const filteredBySupplier = filterAndPaginateBsaleInvoices(siiInvoices, {
    supplierRut: '766614868',
  })
  assert.equal(filteredBySupplier.totalItems, 1)
  assert.equal(filteredBySupplier.items[0].documentFolio, '98958')

  const filteredHistorical = filterAndPaginateBsaleInvoices(siiInvoices, {
    reconciliationFilter: 'NO_RECEIPT_HISTORICAL',
  })
  assert.equal(filteredHistorical.totalItems, 1)
  assert.equal(filteredHistorical.items[0].bsaleDocumentId, 8799)

  const supplierOpts = buildBsaleSupplierFilterOptions(siiInvoices)
  assert.equal(supplierOpts.length, 5)

  // Verificar Bloque 4A: resolución de saldos acreditados, fechas de vencimiento y bloqueos de pago
  assert.equal(parseExplicitCreditDays('30'), 30)
  assert.equal(parseExplicitCreditDays('28 dias'), 28)
  assert.equal(parseExplicitCreditDays('15 días'), 15)
  assert.equal(parseExplicitCreditDays('PRE PAGO'), null)
  assert.equal(parseExplicitCreditDays('76.890.517-6'), null)
  assert.equal(addCivilDaysToIsoDate('2026-11-19', 28), '2026-12-17')

  const financialView = buildBsaleBodegaFinancialReconciliationView({
    report,
    cxpCandidates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut: '76100687-8',
        document_type: 'FA',
        folio: '163496',
        issue_date: '2026-11-19',
        suggested_due_date: '2026-12-17',
        referential_net_amount: 313600,
        referential_tax_amount: 59584,
        referential_total_amount: 373184,
        receipt_count: 1,
        purchase_order_count: 1,
        receipt_ids: ['rec-163496'],
        purchase_order_numbers: ['OC-2026-000086'],
        has_date_inconsistency: false,
        has_supplier_inconsistency: false,
        has_partial_receipt: false,
        last_received_at: '2026-11-19T16:20:30Z',
        attachment_count: 1,
        already_incorporated: true,
        validation_status: 'VALIDATED',
        discrepancy_status: 'NONE',
        blocked_reason: null,
      },
    ],
    cxpSummaries: [
      {
        id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name_raw: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut_raw: '76100687-8',
        issuer_rut_normalized: '761006878',
        document_type: 'FA',
        document_folio: '163496',
        issue_date: '2026-11-19',
        due_date: '2026-12-17',
        net_amount: 313600,
        tax_amount: 59584,
        total_amount: 373184,
        referential_total_amount: 373184,
        amount_matches_reference: true,
        validation_status: 'VALIDATED',
        discrepancy_status: 'NONE',
        origin: 'RECEIPT_DERIVED',
        prior_payment_status: 'NO_PRIOR_PAYMENTS',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        receipt_count: 1,
        purchase_order_count: 1,
        document_count: 1,
        incorporated_at: '2026-11-22T20:29:00Z',
        validated_at: '2026-11-22T20:29:00Z',
      },
    ],
    cxpDueDates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        due_date: '2026-12-17',
        suggested_due_date: '2026-12-17',
        due_date_source: 'SAVED',
      },
    ],
    cxpPaymentsByInvoiceId: {
      'inv-163496': {
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        validation_status: 'VALIDATED',
        total_amount: 373184,
        prior_payment_status: 'NO_PRIOR_PAYMENTS',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        initial_balance: 373184,
        prior_paid_amount: 0,
        module_paid_amount: 373184,
        total_paid_amount: 373184,
        current_balance: 0,
        is_fully_paid: true,
        can_register_payment: false,
        payment_count: 1,
        reversed_payment_count: 0,
        reversed_amount: 0,
        payments: [
          {
            id: 'pay-163496',
            company_id: CAYLO_COMPANY_ID,
            invoice_id: 'inv-163496',
            operation_id: 'op-163496',
            payment_date: '2026-11-23',
            amount: 373184,
            reference: null,
            created_at: '2026-11-23T01:47:17Z',
            created_by: 'user-1',
            is_reversed: false,
            status: 'ACTIVE',
            reversal: null,
          },
        ],
      },
    },
    purchaseOrders: [
      { id: 'po-86', correlative: 'OC-2026-000086', payment_terms: '28 dias' },
      { id: 'po-52', correlative: 'OC-2026-000052', payment_terms: '30' },
      { id: 'po-72', correlative: 'OC-2026-000072', payment_terms: '30' },
      { id: 'po-53', correlative: 'OC-2026-000053', payment_terms: 'PRE PAGO' },
    ],
    suppliers: [
      {
        id: 'sup-marben',
        rut: '76.100.687-8',
        credit_days: 28,
        payment_terms: '28 dias',
      },
      {
        id: 'sup-south',
        rut: '76661486-8',
        credit_days: 30,
        payment_terms: '30',
      },
      {
        id: 'sup-caf',
        rut: '77152885-6',
        credit_days: 0,
        payment_terms: 'PRE PAGO',
      },
      {
        id: 'sup-atompet',
        rut: '77763917-K',
        credit_days: 28,
        payment_terms: '28 dias',
      },
    ],
  })

  // 1) FA 163496: Saldo acreditado $0 (Pagada), vencimiento SAVED 2026-12-17
  const fin163496 = financialView.financialByKey[fa163496.reconciliationKey]
  assert.ok(fin163496)
  assert.equal(fin163496.dueDateInfo.dueDate, '2026-12-17')
  assert.equal(fin163496.dueDateInfo.source, 'SAVED')
  assert.equal(fin163496.financialBalance.isBalanceAccredited, true)
  assert.equal(fin163496.financialBalance.accreditationStatus, 'ACCREDITED_PAID')
  assert.equal(fin163496.financialBalance.totalPaidAmountClp, 373184)
  assert.equal(fin163496.financialBalance.currentBalanceClp, 0)
  assert.equal(
    resolveFinancialAccreditationBadge(fin163496).label,
    'Pagada · Saldo $0'
  )

  // 1b) FA 163496 tras anular el pago de prueba ($373.184): conserva trazabilidad (1 pago anulado) y restituye saldo pendiente ($373.184) para volver a pagar cuando corresponda
  const financialViewAfterReversal = buildBsaleBodegaFinancialReconciliationView({
    report,
    cxpCandidates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut: '76100687-8',
        document_type: 'FA',
        folio: '163496',
        issue_date: '2026-11-19',
        suggested_due_date: '2026-12-17',
        referential_net_amount: 313600,
        referential_tax_amount: 59584,
        referential_total_amount: 373184,
        receipt_count: 1,
        purchase_order_count: 1,
        receipt_ids: ['rec-163496'],
        purchase_order_numbers: ['OC-2026-000086'],
        has_date_inconsistency: false,
        has_supplier_inconsistency: false,
        has_partial_receipt: false,
        last_received_at: '2026-11-19T16:20:30Z',
        attachment_count: 1,
        already_incorporated: true,
        validation_status: 'VALIDATED',
        discrepancy_status: 'NONE',
        blocked_reason: null,
      },
    ],
    cxpSummaries: [
      {
        id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name_raw: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut_raw: '76100687-8',
        issuer_rut_normalized: '761006878',
        document_type: 'FA',
        document_folio: '163496',
        issue_date: '2026-11-19',
        due_date: '2026-12-17',
        net_amount: 313600,
        tax_amount: 59584,
        total_amount: 373184,
        referential_total_amount: 373184,
        amount_matches_reference: true,
        validation_status: 'VALIDATED',
        discrepancy_status: 'NONE',
        origin: 'RECEIPT_DERIVED',
        prior_payment_status: 'NO_PRIOR_PAYMENTS',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        receipt_count: 1,
        purchase_order_count: 1,
        document_count: 1,
        incorporated_at: '2026-11-22T20:29:00Z',
        validated_at: '2026-11-22T20:29:00Z',
      },
    ],
    cxpDueDates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        due_date: '2026-12-17',
        suggested_due_date: '2026-12-17',
        due_date_source: 'SAVED',
      },
    ],
    cxpPaymentsByInvoiceId: {
      'inv-163496': {
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        validation_status: 'VALIDATED',
        total_amount: 373184,
        prior_payment_status: 'NO_PRIOR_PAYMENTS',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        initial_balance: 373184,
        prior_paid_amount: 0,
        module_paid_amount: 0,
        total_paid_amount: 0,
        current_balance: 373184,
        is_fully_paid: false,
        can_register_payment: true,
        payment_count: 0,
        reversed_payment_count: 1,
        reversed_amount: 373184,
        payments: [
          {
            id: 'pay-163496',
            company_id: CAYLO_COMPANY_ID,
            invoice_id: 'inv-163496',
            operation_id: 'op-163496',
            payment_date: '2026-11-23',
            amount: 373184,
            reference: null,
            created_at: '2026-11-23T01:47:17Z',
            created_by: 'user-1',
            is_reversed: true,
            status: 'REVERSED',
            reversal: {
              id: 'rev-163496',
              payment_id: 'pay-163496',
              invoice_id: 'inv-163496',
              company_id: CAYLO_COMPANY_ID,
              reason: 'Operación ficticia utilizada para pruebas',
              operation_id: 'op-rev-163496',
              created_at: '2026-11-23T18:55:00Z',
              created_by: 'user-1',
            },
          },
        ],
      },
    },
  })

  const fin163496Reversed =
    financialViewAfterReversal.financialByKey[fa163496.reconciliationKey]
  assert.ok(fin163496Reversed)
  assert.equal(
    fin163496Reversed.financialBalance.accreditationStatus,
    'ACCREDITED_OPEN_BALANCE'
  )
  assert.equal(fin163496Reversed.financialBalance.totalPaidAmountClp, 0)
  assert.equal(fin163496Reversed.financialBalance.currentBalanceClp, 373184)
  assert.equal(fin163496Reversed.financialBalance.activePaymentsCount, 0)
  assert.equal(fin163496Reversed.financialBalance.reversedPaymentsCount, 1)
  assert.equal(fin163496Reversed.financialBalance.reversedAmountClp, 373184)
  assert.equal(
    fin163496Reversed.financialBalance.paymentsHistory[0].is_reversed,
    true
  )
  assert.equal(
    fin163496Reversed.financialBalance.paymentsHistory[0].reversal?.reason,
    'Operación ficticia utilizada para pruebas'
  )
  assert.equal(fin163496Reversed.paymentBlock.canRegisterPayment, true)
  assert.equal(fin163496Reversed.paymentBlock.isBlocked, false)
  assert.equal(
    resolveFinancialAccreditationBadge(fin163496Reversed).label,
    'Deuda confirmada · $373.184'
  )

  // 1c) FA 163496 tras ejecutar «Reabrir validación» (acción independiente posterior a la reversa del pago):
  //     Pasa a PENDING / UNREVIEWED, muestra «Saldo por acreditar» (sin presentar $373.184 como deuda confirmada)
  //     y conserva en su historial el pago reversado de $373.184.
  const financialViewAfterReopen = buildBsaleBodegaFinancialReconciliationView({
    report,
    cxpCandidates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut: '76100687-8',
        document_type: 'FA',
        folio: '163496',
        issue_date: '2026-11-19',
        suggested_due_date: '2026-12-17',
        referential_net_amount: 313600,
        referential_tax_amount: 59584,
        referential_total_amount: 373184,
        receipt_count: 1,
        purchase_order_count: 1,
        receipt_ids: ['rec-163496'],
        purchase_order_numbers: ['OC-2026-000086'],
        has_date_inconsistency: false,
        has_supplier_inconsistency: false,
        has_partial_receipt: false,
        last_received_at: '2026-11-19T16:20:30Z',
        attachment_count: 1,
        already_incorporated: true,
        validation_status: 'PENDING',
        discrepancy_status: 'NONE',
        blocked_reason: null,
      },
    ],
    cxpSummaries: [
      {
        id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        supplier_id: 'sup-marben',
        supplier_name_raw: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
        issuer_rut_raw: '76100687-8',
        issuer_rut_normalized: '761006878',
        document_type: 'FA',
        document_folio: '163496',
        issue_date: '2026-11-19',
        due_date: '2026-12-17',
        net_amount: 313600,
        tax_amount: 59584,
        total_amount: 373184,
        referential_total_amount: 373184,
        amount_matches_reference: true,
        validation_status: 'PENDING',
        discrepancy_status: 'NONE',
        origin: 'RECEIPT_DERIVED',
        prior_payment_status: 'UNREVIEWED',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        receipt_count: 1,
        purchase_order_count: 1,
        document_count: 1,
        incorporated_at: '2026-11-22T20:29:00Z',
        validated_at: null,
      },
    ],
    cxpDueDates: [
      {
        candidate_id: 'cand-163496',
        invoice_id: 'inv-163496',
        due_date: '2026-12-17',
        suggested_due_date: '2026-12-17',
        due_date_source: 'SAVED',
      },
    ],
    cxpPaymentsByInvoiceId: {
      'inv-163496': {
        invoice_id: 'inv-163496',
        company_id: CAYLO_COMPANY_ID,
        validation_status: 'PENDING',
        total_amount: 373184,
        prior_payment_status: 'UNREVIEWED',
        historical_initial_balance: null,
        historical_balance_cutoff_date: null,
        initial_balance: null,
        prior_paid_amount: null,
        module_paid_amount: 0,
        total_paid_amount: null,
        current_balance: null,
        is_fully_paid: false,
        can_register_payment: false,
        payment_count: 0,
        reversed_payment_count: 1,
        reversed_amount: 373184,
        payments: [
          {
            id: 'pay-163496',
            company_id: CAYLO_COMPANY_ID,
            invoice_id: 'inv-163496',
            operation_id: 'op-163496',
            payment_date: '2026-11-23',
            amount: 373184,
            reference: null,
            created_at: '2026-11-23T01:47:17Z',
            created_by: 'user-1',
            is_reversed: true,
            status: 'REVERSED',
            reversal: {
              id: 'rev-163496',
              payment_id: 'pay-163496',
              invoice_id: 'inv-163496',
              company_id: CAYLO_COMPANY_ID,
              reason: 'Operación ficticia utilizada para pruebas',
              operation_id: 'op-rev-163496',
              created_at: '2026-11-23T18:55:00Z',
              created_by: 'user-1',
            },
          },
        ],
      },
    },
  })

  const fin163496Reopened =
    financialViewAfterReopen.financialByKey[fa163496.reconciliationKey]
  assert.ok(fin163496Reopened)
  assert.equal(fin163496Reopened.cxpValidationStatus, 'PENDING')
  assert.equal(fin163496Reopened.cxpPriorPaymentStatus, 'UNREVIEWED')
  assert.equal(fin163496Reopened.financialBalance.isBalanceAccredited, false)
  assert.equal(
    fin163496Reopened.financialBalance.accreditationStatus,
    'UNACCREDITED_HISTORICAL_PAYMENT'
  )
  assert.equal(
    fin163496Reopened.financialBalance.accreditedTotalAmountClp,
    null,
    'No debe presentar el importe como deuda confirmada tras reabrir la validación'
  )
  assert.equal(fin163496Reopened.financialBalance.currentBalanceClp, null)
  assert.equal(fin163496Reopened.financialBalance.totalPaidAmountClp, null)
  assert.equal(fin163496Reopened.financialBalance.reversedPaymentsCount, 1)
  assert.equal(fin163496Reopened.financialBalance.reversedAmountClp, 373184)
  assert.equal(fin163496Reopened.financialBalance.paymentsHistory.length, 1)
  assert.equal(
    fin163496Reopened.financialBalance.paymentsHistory[0].is_reversed,
    true
  )
  assert.equal(
    resolveFinancialAccreditationBadge(fin163496Reopened).label,
    'Sin clasificar'
  )

  // 1d) Evidencia histórica Excel (Pagada históricamente · Excel):
  //     - Coincidencia EXACT con fecha informada (EXCEL_COLUMN_H) vs fecha asumida (ASSUMED_DOCUMENT_DATE)
  //     - Coincidencias no exactas (AMOUNT_MISMATCH, AMOUNT_MATCH_DATE_DIFF, NO_SII_IN_MIRROR) NO se asocian
  //     - FA 163496 no está en el Excel, por lo que sigue como «Saldo por acreditar»
  const financialViewWithExcel = buildBsaleBodegaFinancialReconciliationView({
    report,
    historicalPaidExcelMatches: [
      {
        batch_id: 'batch-excel-1',
        source_row: 120,
        issuer_rut_normalized: '77763917K',
        document_folio: '2458',
        document_issue_date: '2026-04-17',
        reference_payment_date: '2026-05-02',
        payment_date_basis: 'EXCEL_COLUMN_H',
        document_total_clp: 3255769,
        credit_note_amount_clp: null,
        has_excel_observation: false,
        declared_payment_status: 'FULLY_PAID_PRIOR',
        declared_pending_balance_clp: 0,
        sii_matches: 1,
        sii_document_id: 8799,
        sii_emission_date: '2026-04-17',
        sii_total_clp: 3255769,
        sii_code: '33',
        sii_match_status: 'EXACT',
      },
      {
        batch_id: 'batch-excel-1',
        source_row: 121,
        issuer_rut_normalized: '77763917K',
        document_folio: '9991',
        document_issue_date: '2026-11-18',
        reference_payment_date: '2026-11-18',
        payment_date_basis: 'ASSUMED_DOCUMENT_DATE',
        document_total_clp: 3973481,
        credit_note_amount_clp: null,
        has_excel_observation: false,
        declared_payment_status: 'FULLY_PAID_PRIOR',
        declared_pending_balance_clp: 0,
        sii_matches: 1,
        sii_document_id: 9560,
        sii_emission_date: '2026-11-18',
        sii_total_clp: 3973481,
        sii_code: '34',
        sii_match_status: 'EXACT',
      },
      // Registro NO exacto (AMOUNT_MISMATCH) sobre FA 1605: NO debe asociarse por aproximación
      {
        batch_id: 'batch-excel-1',
        source_row: 122,
        issuer_rut_normalized: '771528856',
        document_folio: '1605',
        document_issue_date: '2026-10-31',
        reference_payment_date: '2026-11-10',
        payment_date_basis: 'EXCEL_COLUMN_H',
        document_total_clp: 11600000,
        credit_note_amount_clp: null,
        has_excel_observation: false,
        declared_payment_status: 'FULLY_PAID_PRIOR',
        declared_pending_balance_clp: 0,
        sii_matches: 1,
        sii_document_id: 9491,
        sii_emission_date: '2026-10-31',
        sii_total_clp: 11602500,
        sii_code: '33',
        sii_match_status: 'AMOUNT_MISMATCH',
      },
    ],
  })

  const finExcelInformed =
    financialViewWithExcel.financialByKey[unmatchedHistorical2458.reconciliationKey]
  assert.equal(
    finExcelInformed.financialBalance.accreditationStatus,
    'HISTORICAL_EXCEL_PAID'
  )
  assert.equal(finExcelInformed.financialBalance.currentBalanceClp, 0)
  assert.equal(finExcelInformed.paymentBlock.primaryReasonCode, 'ALREADY_FULLY_PAID')
  assert.equal(finExcelInformed.paymentBlock.primaryReasonLabel, 'Factura pagada (Saldo $0)')
  assert.doesNotMatch(
    finExcelInformed.paymentBlock.primaryReasonLabel,
    /Sin recepción en Bodega/
  )

  // Factura operativa (>= 2026-10-01) sin recepción debe conservar el bloqueo de recepción en Bodega
  const finExcelAssumed =
    financialViewWithExcel.financialByKey[unmatchedOperational9991.reconciliationKey]
  assert.equal(
    finExcelAssumed.financialBalance.accreditationStatus,
    'HISTORICAL_EXCEL_PAID'
  )
  assert.equal(finExcelAssumed.paymentBlock.primaryReasonCode, 'NO_WAREHOUSE_RECEIPT')
  assert.equal(
    finExcelAssumed.paymentBlock.primaryReasonLabel,
    'Pago bloqueado · Sin recepción en Bodega'
  )
  assert.equal(finExcelAssumed.financialBalance.currentBalanceClp, 0)
  assert.equal(
    finExcelAssumed.financialBalance.historicalExcelEvidence?.paymentDateBasis,
    'ASSUMED_DOCUMENT_DATE'
  )
  assert.match(
    resolveFinancialAccreditationBadge(finExcelAssumed).detail,
    /18\/11\/2026 \(Asumida\)/
  )

  // FA 1605 con AMOUNT_MISMATCH no debe quedar pagada por aproximación
  assert.notEqual(
    financialViewWithExcel.financialByKey[fa1605.reconciliationKey]
      .financialBalance.accreditationStatus,
    'HISTORICAL_EXCEL_PAID'
  )

  // FA 163496 sigue sin clasificar cuando no figura en el Excel
  const fin163496SinExcel =
    financialViewWithExcel.financialByKey[fa163496.reconciliationKey]
  assert.equal(
    fin163496SinExcel.financialBalance.accreditationStatus,
    'UNACCREDITED_HISTORICAL_PAYMENT'
  )
  assert.equal(
    resolveFinancialAccreditationBadge(fin163496SinExcel).label,
    'Sin clasificar'
  )
  assert.equal(financialViewWithExcel.financialCounts.historicalExcelPaidCount, 2)
  assert.equal(
    financialViewWithExcel.financialCounts.historicalExcelInformedDateCount,
    1
  )
  assert.equal(
    financialViewWithExcel.financialCounts.historicalExcelAssumedDateCount,
    1
  )

  // Verificar resumen de los grupos financieros mutuamente excluyentes y filtros principales (Por pagar / Pagadas / Sin clasificar / Todas)
  const excelSummary = summarizeFinancialInboxGroups(
    siiInvoices,
    financialViewWithExcel.financialByKey
  )
  assert.equal(
    excelSummary.confirmedDebtCount +
      excelSummary.historicalExcelPendingCount +
      excelSummary.unclassifiedCount +
      excelSummary.paidCount,
    siiInvoices.length
  )
  assert.equal(excelSummary.confirmedDebtCount, 0)
  assert.equal(excelSummary.confirmedDebtTotalClp, 0)
  assert.equal(excelSummary.paidCount, 2)
  assert.equal(excelSummary.unclassifiedCount, siiInvoices.length - 2)
  assert.equal(
    resolveFinancialInboxGroup(fin163496SinExcel),
    'UNCLASSIFIED'
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(siiInvoices, {
      financialPrimaryFilter: 'TO_PAY',
      financialByKey: financialViewWithExcel.financialByKey,
    }).totalItems,
    0
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(siiInvoices, {
      financialPrimaryFilter: 'UNCLASSIFIED',
      financialByKey: financialViewWithExcel.financialByKey,
    }).totalItems,
    siiInvoices.length - 2
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(siiInvoices, {
      financialPrimaryFilter: 'PAID',
      financialByKey: financialViewWithExcel.financialByKey,
    }).totalItems,
    2
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(siiInvoices, {
      financialPrimaryFilter: 'ALL',
      financialByKey: financialViewWithExcel.financialByKey,
    }).totalItems,
    siiInvoices.length
  )

  // 2) FA 98958: Bloqueada por discrepancia monetaria (-$25.479), vencimiento sugerido desde OC (30 días -> 2026-11-27), saldo NO acreditado (null)
  const fin98958 = financialView.financialByKey[fa98958.reconciliationKey]
  assert.ok(fin98958)
  assert.equal(fin98958.dueDateInfo.dueDate, '2026-11-27')
  assert.equal(fin98958.dueDateInfo.source, 'PURCHASE_ORDER')
  assert.equal(fin98958.financialBalance.isBalanceAccredited, false)
  assert.equal(fin98958.financialBalance.currentBalanceClp, null)
  assert.equal(
    fin98958.financialBalance.accreditationStatus,
    'BLOCKED_BY_DISCREPANCY'
  )
  assert.equal(fin98958.paymentBlock.isBlocked, true)
  assert.equal(
    fin98958.paymentBlock.primaryReasonCode,
    'UNRESOLVED_MONETARY_DISCREPANCY'
  )

  // 3) FA 1605: OC con "PRE PAGO" no adivina días de crédito (dueDate: null, Por confirmar), bloqueada por discrepancia (+2.677.500)
  const fin1605 = financialView.financialByKey[fa1605.reconciliationKey]
  assert.ok(fin1605)
  assert.equal(fin1605.dueDateInfo.dueDate, null)
  assert.equal(fin1605.dueDateInfo.source, null)
  assert.equal(fin1605.financialBalance.isBalanceAccredited, false)
  assert.equal(fin1605.financialBalance.currentBalanceClp, null)
  assert.equal(fin1605.paymentBlock.isBlocked, true)

  // 4) Factura histórica sin recepción (Atompet FA 2458): vencimiento sugerido por proveedor (28 días), pero saldo NO acreditado (currentBalanceClp: null, nunca impaga)
  const finHist2458 =
    financialView.financialByKey[unmatchedHistorical2458.reconciliationKey]
  assert.ok(finHist2458)
  assert.equal(finHist2458.dueDateInfo.dueDate, '2026-05-15')
  assert.equal(finHist2458.dueDateInfo.source, 'SUPPLIER')
  assert.equal(finHist2458.financialBalance.isBalanceAccredited, false)
  assert.equal(finHist2458.financialBalance.currentBalanceClp, null)
  assert.equal(
    finHist2458.financialBalance.accreditationStatus,
    'UNACCREDITED_HISTORICAL_PAYMENT'
  )
  assert.equal(
    resolveFinancialAccreditationBadge(finHist2458).label,
    'Sin clasificar'
  )

  // Verificar contrato UI de Bloque 3 + Bloque 4A (pantalla principal y panel lateral)
  const inboxSource = fs.readFileSync(
    path.join(repoRoot, 'src/modules/cuentas-por-pagar/invoice-inbox.tsx'),
    'utf8'
  )
  const detailPanelSource = fs.readFileSync(
    path.join(
      repoRoot,
      'src/modules/cuentas-por-pagar/bsale-reconciliation-detail-panel.tsx'
    ),
    'utf8'
  )
  assert.match(inboxSource, /Incidencias de Bodega sin factura SII vinculada/)
  assert.match(inboxSource, /onDoubleClick/)
  assert.match(inboxSource, /Por pagar según Excel/)
  assert.match(inboxSource, /Pagadas según Excel/)
  assert.match(inboxSource, /Sin clasificar/)
  assert.doesNotMatch(inboxSource, /incorporateReceiptInvoices/)
  assert.doesNotMatch(detailPanelSource, /registerInvoicePayment/)
  assert.doesNotMatch(detailPanelSource, /confirmInvoiceFromFinancialPanel/)
  assert.match(detailPanelSource, /HISTORICAL_PAYMENT_PENDING_LABEL/)
  assert.match(detailPanelSource, /getCxpBsaleDocumentSignedUrl/)
  assert.match(detailPanelSource, /getCxpWarehouseReceiptDocumentSignedUrl/)

  console.log('   ✓ Pruebas unitarias de conciliación y modelo de vista superadas.')
}

async function runLiveReadOnlyValidation() {
  console.log('2. Ejecutando conciliación de lectura real sobre el espejo Bsale y Bodega en Supabase...')
  loadEnvLocal()
  const { createClient } = requireFromRepo('@supabase/supabase-js')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  const report = await fetchAndReconcileBsaleBodegaForCaylo(supabase)

  console.log('--- RESUMEN DE CANTIDADES POR CATEGORÍA ---')
  console.log(JSON.stringify(report.counts, null, 2))

  // Validaciones reales obligatorias
  // 1) FA 163496 (diferencia $0)
  const fa163496 = report.matchedEntries.find(
    (e) =>
      e.documentFolio === '163496' && e.issuerRutNormalized === '761006878'
  )
  assert.ok(fa163496, 'Debe existir FA 163496 conciliada')
  assert.equal(fa163496.monetary.status, 'EXACT_MATCH')
  assert.equal(fa163496.monetary.siiTotalAmountClp, 373184)
  assert.equal(fa163496.monetary.receivedGrossAmountClp, 373184)
  assert.equal(fa163496.monetary.differenceClp, 0)
  assert.equal(fa163496.receptionStatus, 'COMPLETE')

  // 2) FA 98958 (múltiples recepciones/OC)
  const fa98958 = report.matchedEntries.find(
    (e) =>
      e.documentFolio === '98958' && e.issuerRutNormalized === '766614868'
  )
  assert.ok(fa98958, 'Debe existir FA 98958 conciliada')
  assert.equal(fa98958.receiptCount, 3)
  assert.equal(fa98958.purchaseOrderCount, 2)
  assert.deepEqual(fa98958.purchaseOrderCorrelatives, [
    'OC-2026-000052',
    'OC-2026-000072',
  ])
  assert.equal(fa98958.monetary.siiTotalAmountClp, 3980148)
  assert.equal(fa98958.monetary.receivedGrossAmountExact, 4005626.92)
  assert.equal(fa98958.monetary.receivedGrossAmountClp, 4005627)
  assert.equal(fa98958.monetary.differenceClp, -25479)
  assert.equal(fa98958.monetary.status, 'AMOUNT_DIFFERENCE')
  assert.equal(fa98958.receptionStatus, 'COMPLETE')

  // 3) FA 1605 (recepción parcial)
  const fa1605 = report.matchedEntries.find(
    (e) => e.documentFolio === '1605' && e.issuerRutNormalized === '771528856'
  )
  assert.ok(fa1605, 'Debe existir FA 1605 conciliada')
  assert.equal(fa1605.receptionStatus, 'PARTIAL')
  assert.equal(fa1605.monetary.status, 'AMOUNT_DIFFERENCE')
  assert.equal(fa1605.monetary.siiTotalAmountClp, 11602500)
  assert.equal(fa1605.monetary.receivedGrossAmountClp, 8925000)
  assert.equal(fa1605.monetary.differenceClp, 2677500)

  // 4) FA 3908 (sin factura Bsale)
  const fa3908 = report.receiptsWithoutBsaleInvoice.find(
    (e) => e.documentFolio === '3908' && e.issuerRutNormalized === '77763917K'
  )
  assert.ok(fa3908, 'Debe existir FA 3908 como recepción sin factura Bsale')
  assert.equal(fa3908.category, 'RECEIPT_WITHOUT_BSALE_INVOICE')
  assert.equal(fa3908.bsaleDocumentId, null)
  assert.equal(fa3908.monetary.receivedGrossAmountClp, 3973481)

  // 5) GD 147 (sin asociación segura)
  const gd147 = report.gdReceiptsWithoutLinkedInvoice.find(
    (e) => e.documentFolio === '147' && e.issuerRutNormalized === '771528856'
  )
  assert.ok(gd147, 'Debe existir GD 147 sin asociación segura')
  assert.equal(gd147.category, 'GD_RECEIPT_WITHOUT_LINKED_INVOICE')
  assert.equal(gd147.receptionStatus, 'PENDING_DOCUMENT_LINK')
  assert.equal(gd147.monetary.status, 'UNCOMPARABLE')
  assert.equal(gd147.monetary.receivedGrossAmountClp, 1190000)

  // 6) Validación del modelo de vista de la pantalla Bloque 3 con los datos reales
  const liveSiiInvoices = extractSiiInvoicesFromReport(report)
  const liveBodegaIncidents = extractBodegaIncidentsFromReport(report)
  assert.equal(liveSiiInvoices.length, 777)
  assert.equal(liveBodegaIncidents.length, 3)

  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'MATCHED_ALL',
    }).totalItems,
    49
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'MONETARY_EXACT',
    }).totalItems,
    26
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'MONETARY_DIFFERENCE',
    }).totalItems,
    23
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'RECEPTION_COMPLETE',
    }).totalItems,
    33
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'RECEPTION_PARTIAL',
    }).totalItems,
    16
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'NO_RECEIPT_OPERATIONAL',
    }).totalItems,
    84
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      reconciliationFilter: 'NO_RECEIPT_HISTORICAL',
    }).totalItems,
    644
  )
  const page1 = filterAndPaginateBsaleInvoices(liveSiiInvoices, {
    page: 1,
    pageSize: 50,
  })
  assert.equal(page1.items.length, 50)
  assert.equal(page1.totalPages, 16)
  assert.equal(page1.items[0].dates.siiEmissionDate, '2026-11-20')

  // 7) Validación en vivo de Bloque 4A + Evidencia histórica Excel (700 coincidencias exactas)
  const [{ data: livePos }, { data: liveSuppliers }] = await Promise.all([
    supabase
      .schema('adquisiciones')
      .from('purchase_orders')
      .select('id, correlative, payment_terms')
      .eq('company_id', CAYLO_COMPANY_ID),
    supabase
      .schema('adquisiciones')
      .from('suppliers')
      .select('id, business_name, rut, rut_normalized, payment_terms, credit_days')
      .eq('company_id', CAYLO_COMPANY_ID),
  ])

  const { Pool } = requireFromRepo('pg')
  const envSupaPath = path.join(repoRoot, '.env.supabase.local')
  const envSupaContent = fs.existsSync(envSupaPath)
    ? fs.readFileSync(envSupaPath, 'utf8')
    : ''
  const dbPassMatch = envSupaContent.match(/SUPABASE_DB_PASSWORD=(.+)/)
  const connString = dbPassMatch
    ? `postgresql://postgres.oekmztbfasmildyuajji:${dbPassMatch[1].trim()}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`
    : process.env.DATABASE_RUNTIME_DSN
  const pgPool = new Pool({ connectionString: connString })
  let liveHistoricalExcel = []
  let liveHistoricalPendingExcel = []
  try {
    const [excelRes, pendingRes] = await Promise.all([
      pgPool.query(
        `SELECT
           batch_id,
           source_row,
           issuer_rut_normalized,
           document_folio,
           document_issue_date::text AS document_issue_date,
           reference_payment_date::text AS reference_payment_date,
           payment_date_basis,
           document_total_clp::float8 AS document_total_clp,
           credit_note_amount_clp::float8 AS credit_note_amount_clp,
           has_excel_observation,
           declared_payment_status,
           declared_pending_balance_clp::float8 AS declared_pending_balance_clp,
           sii_matches,
           sii_document_id::int8 AS sii_document_id,
           sii_emission_date::text AS sii_emission_date,
           sii_total_clp::float8 AS sii_total_clp,
           sii_code,
           sii_match_status
         FROM cuentas_por_pagar.vw_historical_paid_excel_sii_match
         WHERE company_id = $1
           AND sii_match_status = 'EXACT'
           AND sii_matches = 1
           AND sii_document_id IS NOT NULL`,
        [CAYLO_COMPANY_ID]
      ),
      pgPool.query(
        `SELECT
           batch_id,
           source_row,
           issuer_rut_normalized,
           supplier_name,
           document_folio,
           document_issue_date::text AS document_issue_date,
           excel_due_date::text AS excel_due_date,
           original_amount_clp::float8 AS original_amount_clp,
           credit_note_amount_clp::float8 AS credit_note_amount_clp,
           pending_balance_clp::float8 AS pending_balance_clp,
           excel_observation,
           declared_payment_status,
           sii_matches,
           sii_document_id::int8 AS sii_document_id,
           sii_emission_date::text AS sii_emission_date,
           sii_total_clp::float8 AS sii_total_clp,
           sii_code,
           sii_match_status
         FROM cuentas_por_pagar.vw_historical_pending_excel_sii_match
         WHERE company_id = $1
           AND sii_match_status = 'EXACT'
           AND sii_matches = 1
           AND sii_document_id IS NOT NULL`,
        [CAYLO_COMPANY_ID]
      ),
    ])
    liveHistoricalExcel = excelRes.rows
    liveHistoricalPendingExcel = pendingRes.rows
  } finally {
    await pgPool.end()
  }

  const liveFinancialView = buildBsaleBodegaFinancialReconciliationView({
    report,
    historicalPaidExcelMatches: liveHistoricalExcel,
    historicalPendingExcelMatches: liveHistoricalPendingExcel,
    purchaseOrders: livePos ?? [],
    suppliers: liveSuppliers ?? [],
  })

  console.log('--- RESUMEN FINANCIERO Y DE VENCIMIENTOS (BLOQUE 4A + EXCEL HISTÓRICO) ---')
  console.log(JSON.stringify(liveFinancialView.financialCounts, null, 2))

  assert.equal(
    liveFinancialView.financialCounts.totalEvaluatedInvoices,
    777,
    'Las 777 facturas SII 33/34 deben ser evaluadas por el resolvedor financiero'
  )
  assert.equal(
    liveFinancialView.financialCounts.historicalExcelPaidCount,
    700,
    'Deben mostrarse exactamente las 700 facturas pagadas según Excel'
  )
  assert.equal(
    liveFinancialView.financialCounts.historicalExcelInformedDateCount,
    412
  )
  assert.equal(
    liveFinancialView.financialCounts.historicalExcelAssumedDateCount,
    288
  )
  assert.equal(
    liveFinancialView.financialCounts.historicalExcelPendingCount,
    70,
    'Deben mostrarse exactamente las 70 facturas pendientes según Excel'
  )
  assert.equal(
    liveFinancialView.financialCounts.historicalExcelPendingTotalClp,
    142031346,
    'El saldo pendiente total según Excel debe ser exactamente $142.031.346'
  )

  // Validar que los grupos financieros en vivo son mutuamente excluyentes y cuadran: 700 + 70 + 7 = 777
  const liveInboxSummary = summarizeFinancialInboxGroups(
    liveSiiInvoices,
    liveFinancialView.financialByKey
  )
  assert.equal(liveInboxSummary.totalInvoices, 777)
  assert.equal(
    liveInboxSummary.confirmedDebtCount +
      liveInboxSummary.historicalExcelPendingCount +
      liveInboxSummary.unclassifiedCount +
      liveInboxSummary.paidCount,
    777,
    'Los grupos financieros deben ser mutuamente excluyentes y cuadrar con las 777 facturas'
  )
  assert.equal(liveInboxSummary.confirmedDebtCount, 0)
  assert.equal(liveInboxSummary.confirmedDebtTotalClp, 0)
  assert.equal(liveInboxSummary.historicalExcelPendingCount, 70)
  assert.equal(liveInboxSummary.historicalExcelPendingTotalClp, 142031346)
  assert.equal(liveInboxSummary.paidCount, 700)
  assert.equal(liveInboxSummary.historicalExcelPaidCount, 700)
  assert.equal(liveInboxSummary.unclassifiedCount, 7)
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      financialPrimaryFilter: 'TO_PAY',
      financialByKey: liveFinancialView.financialByKey,
    }).totalItems,
    70
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      financialPrimaryFilter: 'PAID',
      financialByKey: liveFinancialView.financialByKey,
    }).totalItems,
    700
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      financialPrimaryFilter: 'UNCLASSIFIED',
      financialByKey: liveFinancialView.financialByKey,
    }).totalItems,
    7
  )
  assert.equal(
    filterAndPaginateBsaleInvoices(liveSiiInvoices, {
      financialPrimaryFilter: 'ALL',
      financialByKey: liveFinancialView.financialByKey,
    }).totalItems,
    777
  )

  // Validar bloqueos en documentos históricos pre-Bodega (< 2026-10-01) vs período operativo (>= 2026-10-01)
  const liveFa76832 = liveSiiInvoices.find(
    (e) => e.documentFolio === '76832' && e.issuerRutNormalized === '762006626'
  )
  assert.ok(liveFa76832, 'Debe existir FA 76832 en el espejo Bsale')
  assert.equal(liveFa76832.isHistoricalPreErpReceipts, true)
  const finLive76832 = liveFinancialView.financialByKey[liveFa76832.reconciliationKey]
  assert.ok(finLive76832)
  assert.equal(
    finLive76832.financialBalance.accreditationStatus,
    'HISTORICAL_EXCEL_PENDING'
  )
  assert.equal(finLive76832.paymentBlock.isBlocked, true)
  assert.equal(
    finLive76832.paymentBlock.primaryReasonLabel,
    'Pago bloqueado · Pendiente de validación financiera histórica'
  )
  assert.doesNotMatch(
    finLive76832.paymentBlock.primaryReasonLabel,
    /Sin recepción en Bodega/
  )
  assert.ok(
    finLive76832.paymentBlock.reasons.some((r) =>
      r.includes('antes de la implementación del módulo de recepciones de Bodega')
    )
  )

  // Ninguna factura histórica pre-Bodega sin recepción debe tener «Pago bloqueado · Sin recepción en Bodega»
  const preBodegaSinRecep = liveSiiInvoices.filter(
    (e) => e.isHistoricalPreErpReceipts && e.receptionStatus === 'NO_RECEIPT'
  )
  assert.equal(preBodegaSinRecep.length, 644)
  for (const inv of preBodegaSinRecep) {
    const ov = liveFinancialView.financialByKey[inv.reconciliationKey]
    assert.notEqual(
      ov.paymentBlock.primaryReasonCode,
      'NO_WAREHOUSE_RECEIPT',
      `Factura histórica ${inv.documentFolio} no debe bloquearse por Sin recepción en Bodega`
    )
    assert.doesNotMatch(
      ov.paymentBlock.primaryReasonLabel,
      /Sin recepción en Bodega/
    )
  }

  // Las facturas operativas (>= 2026-10-01) sin recepción deben conservar el bloqueo de recepción en Bodega
  const operationalSinRecep = liveSiiInvoices.filter(
    (e) => !e.isHistoricalPreErpReceipts && e.receptionStatus === 'NO_RECEIPT'
  )
  assert.equal(operationalSinRecep.length, 84)
  for (const inv of operationalSinRecep) {
    const ov = liveFinancialView.financialByKey[inv.reconciliationKey]
    assert.equal(ov.paymentBlock.primaryReasonCode, 'NO_WAREHOUSE_RECEIPT')
    assert.equal(
      ov.paymentBlock.primaryReasonLabel,
      'Pago bloqueado · Sin recepción en Bodega'
    )
  }
  assert.equal(
    liveFinancialView.financialCounts.dueDateBySource.PURCHASE_ORDER +
      liveFinancialView.financialCounts.dueDateBySource.SUPPLIER +
      liveFinancialView.financialCounts.dueDateBySource.SAVED +
      liveFinancialView.financialCounts.dueDateBySource.MANUAL,
    liveFinancialView.financialCounts.withEffectiveDueDateCount
  )
  assert.ok(
    liveFinancialView.financialCounts.withEffectiveDueDateCount >= 340,
    'Al menos 340 facturas deben resolver vencimiento desde OC o catálogo de proveedores'
  )

  console.log('--- VALIDACIÓN DE LOS 5 CASOS REALES DE REFERENCIA ---')
  console.log(
    JSON.stringify(
      {
        FA_163496: {
          category: fa163496.category,
          monetaryStatus: fa163496.monetary.status,
          receptionStatus: fa163496.receptionStatus,
          siiTotalClp: fa163496.monetary.siiTotalAmountClp,
          receivedGrossClp: fa163496.monetary.receivedGrossAmountClp,
          differenceClp: fa163496.monetary.differenceClp,
          dates: fa163496.dates,
        },
        FA_98958: {
          category: fa98958.category,
          monetaryStatus: fa98958.monetary.status,
          receptionStatus: fa98958.receptionStatus,
          receiptCount: fa98958.receiptCount,
          purchaseOrderCorrelatives: fa98958.purchaseOrderCorrelatives,
          siiTotalClp: fa98958.monetary.siiTotalAmountClp,
          receivedGrossExact: fa98958.monetary.receivedGrossAmountExact,
          receivedGrossClp: fa98958.monetary.receivedGrossAmountClp,
          differenceClp: fa98958.monetary.differenceClp,
          attributablePerReceipt: fa98958.receipts.map((r) => ({
            receiptId: r.receiptId,
            po: r.purchaseOrderCorrelative,
            docDate: r.documentDate,
            grossExact: r.attributableGrossAmountExact,
            grossClp: r.attributableGrossAmountClp,
          })),
        },
        FA_1605: {
          category: fa1605.category,
          monetaryStatus: fa1605.monetary.status,
          receptionStatus: fa1605.receptionStatus,
          siiTotalClp: fa1605.monetary.siiTotalAmountClp,
          receivedGrossClp: fa1605.monetary.receivedGrossAmountClp,
          differenceClp: fa1605.monetary.differenceClp,
          dates: fa1605.dates,
        },
        FA_3908: {
          category: fa3908.category,
          monetaryStatus: fa3908.monetary.status,
          receptionStatus: fa3908.receptionStatus,
          receivedGrossExact: fa3908.monetary.receivedGrossAmountExact,
          receivedGrossClp: fa3908.monetary.receivedGrossAmountClp,
        },
        GD_147: {
          category: gd147.category,
          monetaryStatus: gd147.monetary.status,
          receptionStatus: gd147.receptionStatus,
          receivedGrossClp: gd147.monetary.receivedGrossAmountClp,
          ambiguityReason: gd147.ambiguityReason,
        },
        crossSupplierAmbiguousFolios: report.crossSupplierAmbiguousFolios,
      },
      null,
      2
    )
  )

  console.log('   ✓ Validación en vivo de los 847 documentos Bsale y 67 recepciones completada con éxito.')
}

async function main() {
  await runUnitTests()
  if (process.argv.includes('--live')) {
    await runLiveReadOnlyValidation()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
