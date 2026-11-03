'use server'

import { requireWmsPermission } from './authorization'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { BsaleApiError, bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { bsaleWriteForCompany } from '@/lib/bsale/write-client'
import { buildInvoiceEmissionIdentity, buildInvoiceEmissionPayload, chileDateToBsaleEpoch, chileToday, formatBsaleRejection, invoiceEmissionEnabled, invoiceAddressResolutionEnabled, fetchAllBsaleClientAddresses, resolveInvoiceEmissionAddress, validateCompleteInvoiceLines, validateInvoiceDocument } from '@/lib/integraciones/invoice-emission-contract'
import { verifyBsaleInvoiceAddress, type BsaleAdditionalAddressItem } from '@/lib/integraciones/bsale-address-resolution'
import { evaluateInvoiceCommercialValidation } from '@/lib/integraciones/invoice-commercial-validation'
import { verifyInvoiceStockDispatch, buildInvoiceStockEvidencePayload, type InvoiceStockVerificationResult } from '@/lib/integraciones/invoice-stock-verification'
import type { InvoiceCommercialSelection } from '@/modules/logistica/preparacion-pedidos/invoice-commercial'

const PREPARE_PERMISSION = 'logistica.preparation.manage'
const STOCK_VERIFICATION_MAX_READS = 2
const STOCK_VERIFICATION_RETRY_DELAY_MS = 250

export async function prevalidateSalesOrderInvoiceAttempt(cardId: string) {
  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  if (auth.isOperatorBodega) throw new Error('No autorizado para facturación')
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('invoice_attempt_prevalidate', { p_company_id: auth.companyId, p_card_id: cardId })
  return { data, error: error?.message ?? null }
}

export async function prepareSalesOrderInvoiceAttempt(cardId: string) {
  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  if (auth.isOperatorBodega) throw new Error('No autorizado para facturación')
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('prepare_sales_order_invoice_attempt', { p_company_id: auth.companyId, p_card_id: cardId })
  return { data, error: error?.message ?? null }
}

export async function getSalesOrderInvoiceAttempt(attemptId: string) {
  const auth = await requireWmsPermission('module.logistica.view')
  if (auth.isOperatorBodega) throw new Error('No autorizado para facturación')
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('get_sales_order_invoice_attempt', { p_attempt_id: attemptId })
  return { data: data?.[0] ?? null, error: error?.message ?? null }
}

function dateFromBsaleEpoch(value: unknown): string | null {
  const epoch = Number(value)
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  return new Date(epoch * 1000).toISOString().slice(0, 10)
}

async function markAttempt(db: Awaited<ReturnType<typeof createClient>>, name: 'mark_sales_order_invoice_unknown' | 'mark_sales_order_invoice_reconciliation_required', attemptId: string, error: string) {
  return db.schema('logistica').rpc(name, { p_attempt_id: attemptId, p_error: error })
}

async function verifyStockWithBoundedReads(input: Parameters<typeof verifyInvoiceStockDispatch>[0]): Promise<InvoiceStockVerificationResult> {
  let result: InvoiceStockVerificationResult = await verifyInvoiceStockDispatch(input)
  for (let read = 1; read < STOCK_VERIFICATION_MAX_READS && result.status !== 'VERIFIED'; read += 1) {
    await new Promise(resolve => setTimeout(resolve, STOCK_VERIFICATION_RETRY_DELAY_MS))
    result = await verifyInvoiceStockDispatch(input)
  }
  return result
}

function describeBsaleRejection(error: unknown): string {
  if (error instanceof BsaleApiError) {
    return formatBsaleRejection({ status: error.status, message: error.message, body: error.body })
  }
  return formatBsaleRejection({ message: error instanceof Error ? error.message : 'UNKNOWN_ERROR' })
}

async function mirrorConfirmedInvoice(companyId: string, document: Record<string, any>) {
  const admin = createAdminClient()
  const details = Array.isArray(document.details?.items) ? document.details.items : []
  const invoiceId = Number(document.id)
  const documentRow = {
    company_id: companyId,
    bsale_id: invoiceId,
    number: document.number ?? null,
    emission_date: dateFromBsaleEpoch(document.emissionDate),
    generation_date: dateFromBsaleEpoch(document.generationDate),
    total_amount: document.totalAmount ?? null,
    net_amount: document.netAmount ?? null,
    tax_amount: document.taxAmount ?? null,
    exempt_amount: document.exemptAmount ?? null,
    document_type_id: Number(document.document_type?.id) || null,
    client_id: Number(document.client?.id) || null,
    office_id: Number(document.office?.id) || null,
    state: Number(document.state),
    url_pdf: document.urlPdf ?? null,
    raw_json: document,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const { error: documentError } = await admin.schema('integraciones').from('bsale_documents').upsert(documentRow, { onConflict: 'company_id,bsale_id' })
  if (documentError) throw new Error(`MIRROR_DOCUMENT_FAILED:${documentError.message}`)

  if (details.length > 0) {
    const detailRows = details.map((detail: Record<string, any>) => ({
      company_id: companyId,
      bsale_id: Number(detail.id),
      bsale_document_id: invoiceId,
      line_number: Number(detail.lineNumber) || null,
      quantity: detail.quantity ?? null,
      net_unit_value: detail.netUnitValue ?? null,
      total_unit_value: detail.totalUnitValue ?? null,
      net_amount: detail.netAmount ?? null,
      tax_amount: detail.taxAmount ?? null,
      total_amount: detail.totalAmount ?? null,
      net_discount: detail.netDiscount ?? null,
      variant_id: Number(detail.variant?.id) || null,
      variant_code: detail.variant?.code ?? null,
      variant_description: detail.variant?.description ?? null,
      related_detail_bsale_id: Number(detail.relatedDetailId) || null,
      raw_json: detail,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))
    const { error: detailError } = await admin.schema('integraciones').from('bsale_document_details').upsert(detailRows, { onConflict: 'company_id,bsale_id' })
    if (detailError) throw new Error(`MIRROR_DETAILS_FAILED:${detailError.message}`)
  }
}

/** Real emission path. Every document value comes from the current NV or the confirmed selection. */
export async function emitSalesOrderInvoice(cardId: string, selection?: InvoiceCommercialSelection | null) {
  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  if (auth.isOperatorBodega) return { status: 'PREVALIDATION_FAILED' as const, error: 'No autorizado para facturación.' }
  if (!invoiceEmissionEnabled()) return { status: 'EMISSION_DISABLED' as const, error: 'La emisión de facturas está temporalmente suspendida.' }

  const db = await createClient()
  const { data: prevalidation, error: prevalidationError } = await db.schema('logistica').rpc('invoice_attempt_prevalidate', { p_company_id: auth.companyId, p_card_id: cardId })
  if (prevalidationError || !prevalidation?.ready) {
    return { status: 'PREVALIDATION_FAILED' as const, error: prevalidationError?.message ?? 'La NV no está habilitada para facturación.' }
  }

  const { data: card, error: cardError } = await db.schema('logistica').from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', cardId).eq('company_id', auth.companyId).maybeSingle()
  if (cardError || !card) return { status: 'PREVALIDATION_FAILED' as const, error: 'No se encontró la card.' }
  const currentNvId = Number(prevalidation.current_bsale_nv_id)
  if (!Number.isSafeInteger(currentNvId) || Number(card.current_bsale_nv_id) !== currentNvId || card.status !== 'AUDITED') {
    return { status: 'PREVALIDATION_FAILED' as const, error: 'La card cambió mientras se validaba la NV.' }
  }

  const [nv, sellers, paymentTypes, saleConditions] = await Promise.all([
    bsaleFetchResourceForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/documents/${currentNvId}.json`, params: { expand: 'details,payments' } }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/documents/${currentNvId}/sellers.json` }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: '/payment_types.json', params: { state: 0 } }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: '/sale_conditions.json', params: { state: 0 } }),
  ])
  const details = Array.isArray(nv.details?.items) ? nv.details.items : []
  const sellerItems = sellers.items ?? []
  const clientId = Number(nv.client?.id)
  const officeId = Number(nv.office?.id)
  const priceListId = Number(nv.priceList?.id)
  const [client, { data: syncedClient, error: syncedClientError }] = await Promise.all([
    bsaleFetchResourceForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/clients/${clientId}.json` }),
    db.schema('integraciones').from('bsale_clients').select('payment_type_id,payment_type_name').eq('company_id', auth.companyId).eq('bsale_client_id', clientId).maybeSingle(),
  ])
  const paymentTypeId = syncedClient?.payment_type_id == null ? null : Number(syncedClient.payment_type_id)
  const commercialValidation = evaluateInvoiceCommercialValidation({
    currentNvId,
    nv,
    sellers,
    paymentTypes,
    saleConditions,
    client,
    clientError: false,
    syncedClientError: Boolean(syncedClientError),
    paymentTypeId,
    selection: selection ?? null,
  })
  const { selectedPaymentTypeId, saleConditionId, confirmedExpirationDate } = commercialValidation
  if (commercialValidation.missingCommercialFields) {
    return { status: 'PREVALIDATION_FAILED' as const, error: 'La facturación requiere forma de pago, condición y vencimiento confirmados.' }
  }
  if (selectedPaymentTypeId == null || saleConditionId == null || !confirmedExpirationDate) {
    return { status: 'PREVALIDATION_FAILED' as const, error: 'La facturación requiere forma de pago, condición y vencimiento confirmados.' }
  }
  if (commercialValidation.commercialBlockTriggered) {
    return { status: 'PREVALIDATION_FAILED' as const, error: 'La NV vigente no tiene datos comerciales completos para facturar.' }
  }

  const { data: mirrorDetails, error: mirrorDetailsError } = await db.schema('integraciones').from('bsale_document_details')
    .select('bsale_id,quantity')
    .eq('company_id', auth.companyId)
    .eq('bsale_document_id', currentNvId)
  if (mirrorDetailsError || !mirrorDetails?.length) return { status: 'PREVALIDATION_FAILED' as const, error: mirrorDetailsError?.message ?? 'No hay detalle vigente espejado para la NV.' }
  const { data: links, error: linksError } = await db.schema('integraciones').from('bsale_invoice_sales_order_links')
    .select('sales_order_detail_bsale_id,invoice_detail_bsale_id,invoice_bsale_id')
    .eq('company_id', auth.companyId)
    .eq('sales_order_bsale_id', currentNvId)
  if (linksError) return { status: 'PREVALIDATION_FAILED' as const, error: linksError.message }
  const preparedDetails = mirrorDetails.map(detail => ({
    detail_id: Number(detail.bsale_id),
    quantity: Number(detail.quantity),
    billable_quantity: Number(detail.quantity),
  }))
  const completeLines = validateCompleteInvoiceLines(
    details.map((detail: Record<string, any>) => ({ detailId: Number(detail.id), quantity: Number(detail.quantity) })),
    preparedDetails.map(detail => ({ detailId: detail.detail_id, quantity: detail.billable_quantity })),
    links?.length ?? 0,
  )
  if (!completeLines.ok) return { status: 'PREVALIDATION_FAILED' as const, error: completeLines.reason === 'INVOICE_ALREADY_LINKED' ? 'La NV ya tiene una factura vinculada y requiere revisión antes de volver a facturar.' : 'La NV vigente no coincide íntegramente con su espejo facturable.' }
  const preparedById = new Map(preparedDetails.map(detail => [detail.detail_id, detail]))

  const emissionDate = chileToday()
  const emissionDateEpoch = chileDateToBsaleEpoch(emissionDate)
  const expirationDateEpoch = chileDateToBsaleEpoch(confirmedExpirationDate)
  const sellerId = Number(sellerItems[0].id)
  const snapshotDetails = details.map((detail: Record<string, any>) => {
    const preparedDetail = preparedById.get(Number(detail.id))
    if (!preparedDetail) throw new Error('DETAIL_SNAPSHOT_MISSING')
    return {
      detail_id: Number(detail.id),
      variant_id: Number(detail.variant?.id),
      sku: detail.variant?.code ?? null,
      quantity: Number(detail.quantity),
      billable_quantity: Number(preparedDetail.billable_quantity),
      net_unit_value: Number(detail.netUnitValue),
      total_unit_value: Number(detail.totalUnitValue),
      net_amount: Number(detail.netAmount),
      tax_amount: Number(detail.taxAmount),
      total_amount: Number(detail.totalAmount),
      net_discount: Number(detail.netDiscount ?? 0),
    }
  })
  const fullTotals = { net: Number(nv.netAmount), tax: Number(nv.taxAmount), total: Number(nv.totalAmount) }
  const snapshot = {
    company_id: auth.companyId,
    canonical_bsale_token: card.canonical_bsale_token,
    current_bsale_nv_id: currentNvId,
    client_id: clientId,
    office_id: officeId,
    sale_condition_id: String(saleConditionId),
    payment_type_id: selectedPaymentTypeId,
    historical_bsale_nv_id: Number(card.bsale_nv_id),
    folio: String(nv.number),
    seller_id: sellerId,
    price_list_id: priceListId,
    emission_date: emissionDate,
    expiration_date: confirmedExpirationDate,
    totals: fullTotals,
    details: snapshotDetails,
    total: fullTotals.total,
  }
  const identity = buildInvoiceEmissionIdentity(snapshot)
  const { data: existingAttempt, error: existingAttemptError } = await db.schema('logistica').from('sales_order_invoice_attempts')
    .select('id,status,sales_id,fingerprint,retry_count')
    .eq('card_id', card.id)
    .eq('current_bsale_nv_id', currentNvId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingAttemptError) return { status: 'PREVALIDATION_FAILED' as const, error: existingAttemptError.message }
  if (existingAttempt?.status === 'CONFIRMED') return { status: 'ALREADY_INVOICED' as const, attempt_id: existingAttempt.id, error: null }
  if (existingAttempt && ['SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(existingAttempt.status)) {
    return { status: 'INVOICE_IN_PROGRESS' as const, attempt_id: existingAttempt.id, error: null }
  }
  if (existingAttempt && (existingAttempt.sales_id !== identity.salesId || existingAttempt.fingerprint !== identity.fingerprint)) {
    return { status: 'PREVALIDATION_FAILED' as const, error: 'El attempt existente no coincide con la identidad persistida.' }
  }
  const attemptSalesId = existingAttempt?.sales_id ?? identity.salesId
  const attemptFingerprint = existingAttempt?.fingerprint ?? identity.fingerprint

  let targetAddressId: number | null = null
  if (invoiceAddressResolutionEnabled()) {
    const addressesResult = await fetchAllBsaleClientAddresses(auth.companyId, clientId, bsaleFetchResourceForCompany)
    if (!addressesResult.ok) {
      return { status: 'PREVALIDATION_FAILED' as const, error: addressesResult.error }
    }

    const resolved = resolveInvoiceEmissionAddress({
      nv,
      client,
      clientAddresses: addressesResult.addresses,
    })
    if (!resolved.ok) {
      return { status: 'PREVALIDATION_FAILED' as const, error: resolved.error }
    }
    targetAddressId = resolved.addressId
  }

  const payload = buildInvoiceEmissionPayload({
    officeId,
    priceListId,
    saleConditionId,
    emissionDate: emissionDateEpoch,
    expirationDate: expirationDateEpoch,
    clientId,
    sellerId,
    salesId: attemptSalesId,
    addressId: targetAddressId,
    details: snapshotDetails.map((detail: Record<string, any>) => ({ detailId: detail.detail_id, quantity: detail.quantity })),
    payments: [{ paymentTypeId: selectedPaymentTypeId, amount: fullTotals.total, recordDate: emissionDateEpoch }],
  })
  const { data: started, error: startError } = await db.schema('logistica').rpc('begin_sales_order_invoice_submission', {
    p_company_id: auth.companyId,
    p_card_id: card.id,
    p_current_bsale_nv_id: currentNvId,
    p_canonical_bsale_token: card.canonical_bsale_token,
    p_sales_id: attemptSalesId,
    p_fingerprint: attemptFingerprint,
    p_payload_snapshot: payload,
    p_nv_snapshot: { client_id: clientId, office_id: officeId, totals: snapshot.totals, current_bsale_nv_id: currentNvId, historical_bsale_nv_id: Number(card.bsale_nv_id), folio: String(nv.number), sale_condition_id: saleConditionId, price_list_id: priceListId },
    p_detail_snapshots: snapshot.details,
  })
  if (startError) return { status: 'PREVALIDATION_FAILED' as const, error: startError.message }
  if (!started?.ok) return { status: started?.code ?? 'INVOICE_IN_PROGRESS', attempt_id: started?.attempt_id ?? null, error: null }

  const attemptId = String(started.attempt_id)
  let posted: Record<string, any>
  try {
    posted = await bsaleWriteForCompany<Record<string, any>>({ companyId: auth.companyId, path: '/documents.json', body: payload })
  } catch (error) {
    const timeout = error instanceof Error && /abort|timeout/i.test(error.message)
    const rejection = timeout ? 'BSALE_TIMEOUT' : describeBsaleRejection(error)
    await markAttempt(db, 'mark_sales_order_invoice_unknown', attemptId, rejection)
    return { status: timeout ? 'UNKNOWN' as const : 'BSALE_REJECTED' as const, attempt_id: attemptId, error: timeout ? null : rejection }
  }

  const invoiceId = Number(posted.id)
  const invoice = Number.isSafeInteger(invoiceId) && invoiceId > 0
    ? await bsaleFetchResourceForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/documents/${invoiceId}.json`, params: { expand: 'details,payments' } })
    : posted
  const validation = validateInvoiceDocument(invoice, {
    salesId: attemptSalesId,
    clientId,
    officeId,
    totals: snapshot.totals,
    details: snapshotDetails.map((detail: Record<string, any>) => ({
      detailId: detail.detail_id,
      quantity: detail.quantity,
      netUnitValue: detail.net_unit_value,
      totalUnitValue: detail.total_unit_value,
      netAmount: detail.net_amount,
      taxAmount: detail.tax_amount,
      totalAmount: detail.total_amount,
      netDiscount: detail.net_discount,
    })),
  })
  if (!validation.ok) {
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, validation.reason)
    return { status: 'RECONCILIATION_REQUIRED' as const, attempt_id: attemptId, error: validation.reason }
  }
  if (invoiceAddressResolutionEnabled()) {
    const addressVerification = verifyBsaleInvoiceAddress(invoice, {
      address: nv.address,
      municipality: nv.municipality,
      city: nv.city,
    })
    if (!addressVerification.ok) {
      try {
        await mirrorConfirmedInvoice(auth.companyId, invoice)
      } catch {
        // No bloquear registro de conciliación si el mirror falla
      }
      await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, addressVerification.reason)
      return { status: 'RECONCILIATION_REQUIRED' as const, attempt_id: attemptId, error: addressVerification.reason }
    }
  }
  const stockVerification = await verifyStockWithBoundedReads({
    companyId: auth.companyId,
    invoiceId,
    invoiceNumber: invoice.number,
    salesId: attemptSalesId,
    officeId,
    details: snapshotDetails.map((detail: Record<string, any>) => ({
      variantId: Number(detail.variant_id),
      sku: detail.sku ?? undefined,
      quantity: Number(detail.quantity),
    })),
  })
  try {
    await mirrorConfirmedInvoice(auth.companyId, invoice)
  } catch (error) {
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, error instanceof Error ? error.message : 'MIRROR_FAILED')
    return { status: 'RECONCILIATION_REQUIRED' as const, attempt_id: attemptId, error: 'No se pudo actualizar el mirror.' }
  }
  if (stockVerification.status !== 'VERIFIED') {
    const reason = `STOCK_${stockVerification.status}:${stockVerification.reasons.join(',')}`
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, reason)
    return {
      status: 'RECONCILIATION_REQUIRED' as const,
      attempt_id: attemptId,
      invoice_id: invoice.id,
      folio: invoice.number,
      error: stockVerification.status === 'PENDING'
        ? 'La factura fue emitida, pero falta comprobar el despacho de inventario.'
        : 'La factura fue emitida, pero el despacho de inventario requiere conciliación.',
    }
  }

  const admin = createAdminClient()
  const evidencePayload = buildInvoiceStockEvidencePayload({
    companyId: auth.companyId,
    attemptId,
    invoiceBsaleId: invoiceId,
    salesId: attemptSalesId,
    attemptFingerprint,
    officeId,
    verification: stockVerification,
    rawEvidence: {
      source: 'BSALE_GET',
      reasons: stockVerification.reasons,
      costsAvailable: stockVerification.evidence?.costsAvailable ?? false,
    },
  })
  const { data: evidenceResult, error: evidenceError } = await admin.schema('logistica').rpc(
    'record_sales_order_invoice_stock_evidence',
    evidencePayload,
  )
  if (evidenceError || evidenceResult?.status !== 'VERIFIED') {
    const errorDetail = evidenceError?.message ?? 'EVIDENCE_RECORD_FAILED'
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, `STOCK_EVIDENCE_FAILED:${errorDetail}`)
    return {
      status: 'RECONCILIATION_REQUIRED' as const,
      attempt_id: attemptId,
      invoice_id: invoice.id,
      folio: invoice.number,
      error: 'La factura fue emitida y verificada, pero ocurrió un error al registrar la evidencia de inventario.',
    }
  }

  const { data: confirmed, error: confirmError } = await db.schema('logistica').rpc('confirm_sales_order_invoice_attempt', {
    p_attempt_id: attemptId,
    p_invoice_id: Number(invoice.id),
    p_invoice_number: String(invoice.number ?? ''),
  })
  if (confirmError) return { status: 'RECONCILIATION_REQUIRED' as const, attempt_id: attemptId, error: confirmError.message }
  return { status: confirmed?.status ?? 'RECONCILIATION_REQUIRED', attempt_id: attemptId, invoice_id: invoice.id, folio: invoice.number, informedSii: invoice.informedSii ?? null, responseMsgSii: invoice.responseMsgSii ?? null, urls: { publicView: invoice.urlPublicView ?? null, pdf: invoice.urlPdf ?? null, xml: invoice.urlXml ?? null } }
}

type CandidateInvoiceResult =
  | { ok: true; invoiceId: number }
  | { ok: false; reason: string }

async function findUniqueCandidateInvoice(
  companyId: string,
  salesId: string,
  bsaleInvoiceId: number | null,
  db: Awaited<ReturnType<typeof createClient>>,
): Promise<CandidateInvoiceResult> {
  // 1. Si se dispone de bsale_invoice_id, priorizar su consulta dirigida en Bsale y validar su identidad
  if (bsaleInvoiceId != null && bsaleInvoiceId > 0) {
    try {
      const direct = await bsaleFetchResourceForCompany<Record<string, any>>({
        companyId,
        path: `/documents/${bsaleInvoiceId}.json`,
        params: { expand: 'details,payments' },
      })
      const docTypeId = Number(direct?.document_type?.id ?? direct?.documentTypeId)
      const state = Number(direct?.state)
      const cancellation = direct?.cancellationStatus != null ? String(direct?.cancellationStatus) : '0'
      const directSalesId = String(direct?.salesId ?? '')

      if (docTypeId !== 5) {
        return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
      }
      if (state !== 0 || cancellation !== '0') {
        return { ok: false, reason: 'INVOICE_CANCELLED' }
      }
      if (directSalesId !== salesId) {
        return { ok: false, reason: 'INVOICE_ID_MISMATCH' }
      }

      return { ok: true, invoiceId: bsaleInvoiceId }
    } catch (error) {
      if (error instanceof BsaleApiError && error.status === 404) {
        // ID no encontrado directamente en Bsale, continuar al mirror por si fue registrado con otro ID
      } else {
        return { ok: false, reason: `BSALE_GET_FAILED:${describeBsaleRejection(error)}` }
      }
    }
  }

  // 2. Fallback de mirror en PostgreSQL/PostgREST: filtrar company_id, tipo 5, activo y raw_json->>salesId
  // directamente en el motor de base de datos sin límite de paginación en memoria
  const { data: mirrorDocs, error: mirrorError } = await db.schema('integraciones').from('bsale_documents')
    .select('bsale_id, state, raw_json')
    .eq('company_id', companyId)
    .eq('document_type_id', 5)
    .eq('state', 0)
    .eq('raw_json->>salesId', salesId)

  if (mirrorError) {
    return { ok: false, reason: `MIRROR_QUERY_FAILED:${mirrorError.message}` }
  }

  const activeMirrorMatches = (mirrorDocs ?? []).filter(d => {
    const cancelStatus = d.raw_json?.cancellationStatus != null ? String(d.raw_json?.cancellationStatus) : '0'
    return cancelStatus === '0'
  })

  if (activeMirrorMatches.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_SALES_ID_MATCH' }
  }

  if (activeMirrorMatches.length === 1) {
    const mirrorId = Number(activeMirrorMatches[0].bsale_id)
    if (bsaleInvoiceId != null && bsaleInvoiceId > 0 && bsaleInvoiceId !== mirrorId) {
      return { ok: false, reason: 'INVOICE_ID_MISMATCH' }
    }

    // Validar estado vivo en Bsale mediante consulta dirigida
    try {
      const direct = await bsaleFetchResourceForCompany<Record<string, any>>({
        companyId,
        path: `/documents/${mirrorId}.json`,
        params: { expand: 'details,payments' },
      })
      const docTypeId = Number(direct?.document_type?.id ?? direct?.documentTypeId)
      const state = Number(direct?.state)
      const cancellation = direct?.cancellationStatus != null ? String(direct?.cancellationStatus) : '0'
      const directSalesId = String(direct?.salesId ?? '')

      if (docTypeId !== 5) {
        return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
      }
      if (state !== 0 || cancellation !== '0') {
        return { ok: false, reason: 'INVOICE_CANCELLED' }
      }
      if (directSalesId !== salesId) {
        return { ok: false, reason: 'INVOICE_ID_MISMATCH' }
      }

      return { ok: true, invoiceId: mirrorId }
    } catch (error) {
      return { ok: false, reason: `BSALE_GET_FAILED:${describeBsaleRejection(error)}` }
    }
  }

  return { ok: false, reason: 'NO_VALID_INVOICE' }
}

export async function reconcileSalesOrderInvoiceAttempt(attemptId: string) {
  const auth = await requireWmsPermission('module.logistica.view')
  if (auth.isOperatorBodega) throw new Error('No autorizado para facturación')
  const db = await createClient()

  const { data: attempt, error: attemptError } = await db.schema('logistica').from('sales_order_invoice_attempts')
    .select('id,company_id,card_id,status,sales_id,fingerprint,bsale_invoice_id,bsale_invoice_number,current_bsale_nv_id,canonical_bsale_token,nv_snapshot,detail_snapshots,created_at')
    .eq('id', attemptId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (attemptError || !attempt) {
    return { data: null, error: attemptError?.message ?? 'ATTEMPT_NOT_FOUND' }
  }

  if (attempt.status === 'CONFIRMED') {
    const { data, error } = await db.schema('logistica').rpc('reconcile_sales_order_invoice_attempt', { p_attempt_id: attemptId })
    return { data, error: error?.message ?? null }
  }

  if (!['UNKNOWN', 'RECONCILIATION_REQUIRED'].includes(attempt.status)) {
    return {
      data: { status: attempt.status, attempt_id: attempt.id, invoice_id: attempt.bsale_invoice_id },
      error: null,
    }
  }

  if (!attempt.sales_id || !attempt.nv_snapshot || !Array.isArray(attempt.detail_snapshots) || attempt.detail_snapshots.length === 0) {
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, 'SNAPSHOT_MISSING')
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: 'SNAPSHOT_MISSING', attempt_id: attemptId },
      error: 'El intento no contiene los snapshots requeridos para conciliar.',
    }
  }

  const clientId = Number(attempt.nv_snapshot?.client_id)
  const officeId = Number(attempt.nv_snapshot?.office_id)
  const totals = attempt.nv_snapshot?.totals
  const detailSnapshots = attempt.detail_snapshots as Array<Record<string, any>>

  const candidate = await findUniqueCandidateInvoice(
    auth.companyId,
    attempt.sales_id,
    attempt.bsale_invoice_id ? Number(attempt.bsale_invoice_id) : null,
    db,
  )

  if (!candidate.ok) {
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, candidate.reason)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: candidate.reason, attempt_id: attemptId },
      error: candidate.reason,
    }
  }

  const invoiceId = candidate.invoiceId

  let invoice: Record<string, any>
  try {
    invoice = await bsaleFetchResourceForCompany<Record<string, any>>({
      companyId: auth.companyId,
      path: `/documents/${invoiceId}.json`,
      params: { expand: 'details,payments' },
    })
  } catch (error) {
    const message = describeBsaleRejection(error)
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, `BSALE_GET_FAILED:${message}`)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: `BSALE_GET_FAILED:${message}`, attempt_id: attemptId },
      error: `Error al consultar Bsale: ${message}`,
    }
  }

  const validation = validateInvoiceDocument(invoice, {
    salesId: attempt.sales_id,
    clientId,
    officeId,
    totals,
    details: detailSnapshots.map(detail => ({
      detailId: Number(detail.detail_id),
      quantity: Number(detail.quantity),
    })),
  })

  if (!validation.ok) {
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, validation.reason)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: validation.reason, attempt_id: attemptId, invoice_id: invoiceId },
      error: validation.reason,
    }
  }

  try {
    await mirrorConfirmedInvoice(auth.companyId, invoice)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'MIRROR_FAILED'
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, reason)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason, attempt_id: attemptId, invoice_id: invoiceId },
      error: 'No se pudo actualizar el mirror.',
    }
  }

  let stockVerification: InvoiceStockVerificationResult
  try {
    stockVerification = await verifyStockWithBoundedReads({
      companyId: auth.companyId,
      invoiceId,
      invoiceNumber: invoice.number,
      salesId: attempt.sales_id,
      officeId,
      details: detailSnapshots.map(detail => ({
        variantId: Number(detail.variant_id),
        sku: detail.sku ?? undefined,
        quantity: Number(detail.quantity),
      })),
    })
  } catch (error) {
    const message = describeBsaleRejection(error)
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, `BSALE_GET_FAILED:${message}`)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: `BSALE_GET_FAILED:${message}`, attempt_id: attemptId, invoice_id: invoiceId },
      error: `Error al consultar despachos en Bsale: ${message}`,
    }
  }

  if (stockVerification.status !== 'VERIFIED') {
    const reason = `STOCK_${stockVerification.status}:${stockVerification.reasons.join(',')}`
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, reason)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason, attempt_id: attemptId, invoice_id: invoiceId },
      error: stockVerification.status === 'PENDING'
        ? 'La factura fue emitida, pero falta comprobar el despacho de inventario.'
        : 'La factura fue emitida, pero el despacho de inventario requiere conciliación.',
    }
  }

  const admin = createAdminClient()
  const evidencePayload = buildInvoiceStockEvidencePayload({
    companyId: auth.companyId,
    attemptId,
    invoiceBsaleId: invoiceId,
    salesId: attempt.sales_id,
    attemptFingerprint: attempt.fingerprint,
    officeId,
    verification: stockVerification,
    rawEvidence: {
      source: 'BSALE_GET',
      reasons: stockVerification.reasons,
      costsAvailable: stockVerification.evidence?.costsAvailable ?? false,
      reconciliation: true,
    },
  })

  const { data: evidenceResult, error: evidenceError } = await admin.schema('logistica').rpc(
    'record_sales_order_invoice_stock_evidence',
    evidencePayload,
  )

  if (evidenceError || evidenceResult?.status !== 'VERIFIED') {
    const errorDetail = evidenceError?.message ?? 'EVIDENCE_RECORD_FAILED'
    await markAttempt(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, `STOCK_EVIDENCE_FAILED:${errorDetail}`)
    return {
      data: { status: 'RECONCILIATION_REQUIRED', reason: `STOCK_EVIDENCE_FAILED:${errorDetail}`, attempt_id: attemptId, invoice_id: invoiceId },
      error: 'La factura fue verificada, pero ocurrió un error al registrar la evidencia de inventario.',
    }
  }

  const { data, error } = await db.schema('logistica').rpc('reconcile_sales_order_invoice_attempt', { p_attempt_id: attemptId })
  return { data, error: error?.message ?? null }
}
