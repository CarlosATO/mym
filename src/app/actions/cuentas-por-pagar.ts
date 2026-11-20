'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import type {
  CreateServiceInvoiceResult,
  InvoiceDetail,
  InvoiceInboxSummary,
  ReceiptDocumentSignedLink,
  ReceiptInvoiceCandidate,
  SaveInvoiceValidationInput,
  SaveInvoiceValidationResult,
  ServiceDeliveryStatus,
  ServiceInvoiceRow,
  ServiceSupplierOption,
} from '@/modules/cuentas-por-pagar/types'
import {
  classifyAndFilterReceiptCandidates,
  type PurchaseOrderClassificationRow,
  type ReceiptClassificationRow,
} from '@/modules/cuentas-por-pagar/classification'
import {
  ALLOWED_SERVICE_ATTACHMENT_MIME_TYPES,
  MAX_SERVICE_ATTACHMENT_BYTES,
  normalizeNumericFolio,
  validateQuickSupplierDraft,
} from '@/modules/cuentas-por-pagar/service-rules'

const CAYLO = 'd1000000-0000-0000-0000-000000000001'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const RECEIPT_DOCUMENT_BUCKET = 'recepciones'
const SERVICE_DOCUMENT_BUCKET = 'cuentas-por-pagar'
const ALLOWED_DOCUMENT_BUCKETS = new Set([RECEIPT_DOCUMENT_BUCKET, SERVICE_DOCUMENT_BUCKET])
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const MIME_TO_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
const ALLOWED_PRIOR_PAYMENT_STATUSES = new Set([
  'UNREVIEWED',
  'NO_PRIOR_PAYMENTS',
  'PARTIAL_PRIOR_PAYMENTS',
  'FULLY_PAID_PRIOR',
])

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function inferMimeType(fileName: string | null, storagePath: string): string | null {
  const extension = (fileName || storagePath).split('.').pop()?.toLowerCase()
  return extension === 'pdf' ? 'application/pdf'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'png' ? 'image/png'
        : extension === 'webp' ? 'image/webp'
          : null
}

function storageAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

function extractSafeRpcError(
  error: { code?: string | null; message?: string | null },
  fallback: string,
): string {
  if (error.code === '42501') return 'No tiene acceso autorizado a Cuentas por Pagar.'
  if (error.code === 'P0001' && error.message) return error.message
  return fallback
}

async function authorizedClient() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || await getActiveCompanyId(user) !== CAYLO) {
    throw new Error('Seleccione Caylo y acceda con un usuario autorizado.')
  }
  return supabase.schema('public')
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function enrichAndFilterReceiptCandidates(
  candidates: ReceiptInvoiceCandidate[],
): Promise<ReceiptInvoiceCandidate[]> {
  if (candidates.length === 0) return []

  const allReceiptIds = Array.from(
    new Set(candidates.flatMap(candidate => candidate.receipt_ids ?? []).filter(isUuid)),
  )
  if (allReceiptIds.length === 0) return []

  const admin = storageAdminClient()
  const receiptsById = new Map<string, ReceiptClassificationRow>()
  const poIds = new Set<string>()

  for (const batch of chunkArray(allReceiptIds, 200)) {
    const { data, error } = await admin
      .schema('logistica')
      .from('purchase_receipts')
      .select('id, purchase_order_id, status, document_type, document_number, receiving_type')
      .eq('company_id', CAYLO)
      .in('id', batch)

    if (error) throw new Error('No se pudo consultar el estado de recepciones asociadas.')
    for (const row of (data ?? []) as ReceiptClassificationRow[]) {
      receiptsById.set(row.id, row)
      if (row.purchase_order_id) poIds.add(row.purchase_order_id)
    }
  }

  const purchaseOrdersById = new Map<string, PurchaseOrderClassificationRow>()
  for (const batch of chunkArray(Array.from(poIds), 200)) {
    const { data, error } = await admin
      .schema('adquisiciones')
      .from('purchase_orders')
      .select('id, correlative, po_type, status, receipt_status, is_active')
      .eq('company_id', CAYLO)
      .in('id', batch)

    if (error) throw new Error('No se pudo consultar el estado de órdenes de compra asociadas.')
    for (const row of (data ?? []) as PurchaseOrderClassificationRow[]) {
      purchaseOrdersById.set(row.id, row)
    }
  }

  return classifyAndFilterReceiptCandidates(candidates, receiptsById, purchaseOrdersById)
}

export async function getReceiptInvoiceCandidates(): Promise<ReceiptInvoiceCandidate[]> {
  const db = await authorizedClient()
  const rows: ReceiptInvoiceCandidate[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.rpc('cxp_receipt_candidates').range(offset, offset + pageSize - 1)
    if (error) throw new Error('No se pudo cargar la bandeja de facturas o no tiene acceso.')
    const page = (data ?? []) as ReceiptInvoiceCandidate[]
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return enrichAndFilterReceiptCandidates(rows)
}

export async function getInvoiceSummaries(): Promise<InvoiceInboxSummary[]> {
  const db = await authorizedClient()
  const rows: InvoiceInboxSummary[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.rpc('cxp_invoice_summaries').range(offset, offset + pageSize - 1)
    if (error) throw new Error('No se pudieron cargar los estados de validación de facturas.')
    const page = (data ?? []) as InvoiceInboxSummary[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export async function incorporateReceiptInvoices(ids: string[]): Promise<{ count: number }> {
  const db = await authorizedClient()
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some(id => !isUuid(id))) {
    throw new Error('Seleccione entre 1 y 100 facturas válidas.')
  }
  const eligible = await getReceiptInvoiceCandidates()
  const eligibleIds = new Set(eligible.filter(c => !c.blocked_reason).map(c => c.candidate_id))
  if (ids.some(id => !eligibleIds.has(id))) {
    throw new Error('La selección incluye facturas no elegibles para incorporación. Actualice la bandeja.')
  }
  const { data, error } = await db.rpc('cxp_incorporate_receipts', { p_candidate_ids: ids })
  if (error) throw new Error('No se pudieron incorporar las facturas. Actualice la bandeja y revise los datos.')
  revalidatePath('/dashboard/cuentas-por-pagar')
  return { count: Number(data) }
}

export async function getInvoiceValidationDetail(
  invoiceId: string,
): Promise<{ ok: true; data: InvoiceDetail } | { ok: false; error: string }> {
  if (!isUuid(invoiceId)) {
    return { ok: false, error: 'Identificador de factura inválido.' }
  }
  try {
    const db = await authorizedClient()
    const { data, error } = await db.rpc('cxp_invoice_detail', { p_invoice_id: invoiceId })
    if (error || !data) {
      return {
        ok: false,
        error: extractSafeRpcError(error ?? {}, 'No se pudo cargar el detalle de la factura o no tiene acceso.'),
      }
    }
    return { ok: true, data: data as InvoiceDetail }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo cargar el detalle de la factura.',
    }
  }
}

export async function saveInvoiceValidation(
  input: SaveInvoiceValidationInput,
): Promise<{ ok: true; data: SaveInvoiceValidationResult } | { ok: false; error: string }> {
  if (!input || !isUuid(input.invoiceId)) {
    return { ok: false, error: 'Identificador de factura inválido.' }
  }
  if (!input.issueDate || !CIVIL_DATE_RE.test(input.issueDate)) {
    return { ok: false, error: 'La fecha de emisión es obligatoria y debe tener formato válido.' }
  }
  if (input.dueDate !== null && !CIVIL_DATE_RE.test(input.dueDate)) {
    return { ok: false, error: 'La fecha de vencimiento no tiene un formato válido.' }
  }
  if (input.historicalBalanceCutoffDate !== null && !CIVIL_DATE_RE.test(input.historicalBalanceCutoffDate)) {
    return { ok: false, error: 'La fecha de corte del saldo inicial no tiene un formato válido.' }
  }
  if (!ALLOWED_PRIOR_PAYMENT_STATUSES.has(input.priorPaymentStatus)) {
    return { ok: false, error: 'Situación de pagos anteriores inválida.' }
  }
  for (const numericValue of [input.netAmount, input.taxAmount, input.totalAmount, input.historicalInitialBalance]) {
    if (numericValue !== null && (typeof numericValue !== 'number' || !Number.isFinite(numericValue))) {
      return { ok: false, error: 'Uno de los montos ingresados no es válido.' }
    }
  }

  try {
    const db = await authorizedClient()
    const { data, error } = await db.rpc('cxp_save_invoice_validation', {
      p_invoice_id: input.invoiceId,
      p_issue_date: input.issueDate,
      p_due_date: input.dueDate,
      p_net_amount: input.netAmount,
      p_tax_amount: input.taxAmount,
      p_total_amount: input.totalAmount,
      p_prior_payment_status: input.priorPaymentStatus,
      p_historical_initial_balance: input.historicalInitialBalance,
      p_historical_balance_cutoff_date: input.historicalBalanceCutoffDate,
      p_resolve_discrepancy: Boolean(input.resolveDiscrepancy),
      p_discrepancy_resolution_note: input.discrepancyResolutionNote,
      p_confirm_validation: Boolean(input.confirmValidation),
    })

    if (error || !data) {
      return {
        ok: false,
        error: extractSafeRpcError(error ?? {}, 'No se pudo guardar la validación de la factura.'),
      }
    }

    revalidatePath('/dashboard/cuentas-por-pagar')
    return { ok: true, data: data as SaveInvoiceValidationResult }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo guardar la validación de la factura.',
    }
  }
}

export async function getCxpReceiptDocumentSignedUrl(
  invoiceId: string,
  documentId: string,
): Promise<ReceiptDocumentSignedLink | { error: string }> {
  if (!isUuid(invoiceId) || !isUuid(documentId)) {
    return { error: 'Identificador de factura o documento inválido.' }
  }

  try {
    const db = await authorizedClient()
    const { data, error } = await db.rpc('cxp_receipt_document_for_invoice', {
      p_invoice_id: invoiceId,
      p_document_id: documentId,
    })

    if (error) {
      return { error: extractSafeRpcError(error, 'No se pudo validar el respaldo adjunto.') }
    }

    const doc = (Array.isArray(data) ? data[0] : data) as {
      id: string
      document_number: string | null
      storage_bucket: string | null
      storage_path: string | null
      file_name: string | null
      mime_type: string | null
    } | undefined

    if (!doc) return { error: 'Documento no encontrado o no vinculado a esta factura.' }
    if (!doc.storage_path) return { error: 'Este respaldo no tiene un archivo adjunto disponible.' }
    const bucket = doc.storage_bucket || RECEIPT_DOCUMENT_BUCKET
    if (!ALLOWED_DOCUMENT_BUCKETS.has(bucket)) {
      return { error: 'El respaldo no pertenece al almacenamiento autorizado.' }
    }

    const expectedPrefix = `${CAYLO}/`
    if (
      !doc.storage_path.startsWith(expectedPrefix) ||
      doc.storage_path.includes('..') ||
      doc.storage_path.includes('//')
    ) {
      return { error: 'Ruta de almacenamiento inválida.' }
    }

    const mimeType = doc.mime_type || inferMimeType(doc.file_name, doc.storage_path)
    if (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType)) {
      return { error: 'Tipo de archivo no permitido para previsualización.' }
    }

    const storage = storageAdminClient().storage.from(bucket)
    const expiresIn = 300
    const [{ data: signedData, error: signedError }, { data: downloadData, error: downloadError }] = await Promise.all([
      storage.createSignedUrl(doc.storage_path, expiresIn),
      storage.createSignedUrl(doc.storage_path, expiresIn, { download: doc.file_name || true }),
    ])

    if (signedError || downloadError || !signedData?.signedUrl || !downloadData?.signedUrl) {
      return { error: 'No se pudo generar el enlace temporal del documento.' }
    }

    return {
      signedUrl: signedData.signedUrl,
      downloadUrl: downloadData.signedUrl,
      fileName: doc.file_name || `factura-${doc.id}`,
      mimeType,
      expiresIn,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'No se pudo obtener el enlace temporal del documento.',
    }
  }
}

export async function getServiceSuppliers(): Promise<ServiceSupplierOption[]> {
  const db = await authorizedClient()
  const { data, error } = await db.rpc('cxp_service_suppliers')
  if (!error && Array.isArray(data)) {
    return data as ServiceSupplierOption[]
  }
  // Fallback read-only si la migración de servicios aún está pendiente en la base conectada.
  const admin = storageAdminClient()
  const { data: fallback, error: fallbackError } = await admin
    .schema('adquisiciones')
    .from('suppliers')
    .select('id, business_name, fantasy_name, rut, rut_normalized, payment_terms, credit_days')
    .or(`company_id.is.null,company_id.eq.${CAYLO}`)
    .eq('supplier_kind', 'REAL')
    .eq('is_active', true)
    .eq('status', 'ACTIVE')
    .order('business_name')
    .range(0, 1999)

  if (fallbackError) throw new Error('No se pudo cargar el catálogo de proveedores.')
  return (fallback ?? []).map(row => ({
    id: row.id as string,
    business_name: row.business_name as string,
    fantasy_name: (row.fantasy_name as string | null) ?? null,
    rut: (row.rut as string | null) || (row.rut_normalized as string | null) || null,
    payment_terms: (row.payment_terms as string | null) ?? null,
    credit_days: (row.credit_days as number | null) ?? null,
  }))
}

export async function createQuickServiceSupplier(input: {
  rut: string
  businessName: string
  contactEmail?: string | null
  contactPhone?: string | null
}): Promise<{ ok: true; data: ServiceSupplierOption } | { ok: false; error: string }> {
  const errors = validateQuickSupplierDraft(input)
  if (errors.length > 0) {
    return { ok: false, error: errors[0] }
  }

  try {
    const db = await authorizedClient()
    const { data, error } = await db.rpc('cxp_create_service_supplier', {
      p_rut: input.rut.trim(),
      p_business_name: input.businessName.trim(),
      p_contact_email: input.contactEmail?.trim() || null,
      p_contact_phone: input.contactPhone?.trim() || null,
    })

    if (error || !data) {
      return {
        ok: false,
        error: extractSafeRpcError(error ?? {}, 'No se pudo crear el proveedor.'),
      }
    }

    revalidatePath('/dashboard/cuentas-por-pagar/ingreso-servicios')
    return { ok: true, data: data as ServiceSupplierOption }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo crear el proveedor.',
    }
  }
}

export async function getServiceInvoices(): Promise<ServiceInvoiceRow[]> {
  const db = await authorizedClient()
  const rows: ServiceInvoiceRow[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.rpc('cxp_service_invoices').range(offset, offset + pageSize - 1)
    if (error) throw new Error('No se pudieron cargar las facturas de servicios.')
    const page = (data ?? []) as ServiceInvoiceRow[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export async function createServiceInvoice(
  formData: FormData,
): Promise<{ ok: true; data: CreateServiceInvoiceResult } | { ok: false; error: string }> {
  const supplierId = String(formData.get('supplierId') ?? '').trim()
  const rawFolio = String(formData.get('folio') ?? '').trim()
  const serviceDescription = String(formData.get('serviceDescription') ?? '').trim()
  const issueDate = String(formData.get('issueDate') ?? '').trim()
  const dueDate = String(formData.get('dueDate') ?? '').trim()
  const netAmount = Number(formData.get('netAmount'))
  const taxAmount = Number(formData.get('taxAmount'))
  const totalAmount = Number(formData.get('totalAmount'))
  const serviceDeliveryStatus = String(formData.get('serviceDeliveryStatus') ?? '').trim() as ServiceDeliveryStatus
  const attachmentEntry = formData.get('attachment')
  const attachmentFile = attachmentEntry instanceof File && attachmentEntry.size > 0 ? attachmentEntry : null

  if (!isUuid(supplierId)) return { ok: false, error: 'Debe seleccionar un proveedor válido del catálogo.' }
  const normalizedFolio = normalizeNumericFolio(rawFolio)
  if (!normalizedFolio) return { ok: false, error: 'El folio debe contener solo dígitos numéricos.' }
  if (serviceDescription.length < 3) {
    return { ok: false, error: 'La descripción del servicio es obligatoria (mínimo 3 caracteres).' }
  }
  if (!CIVIL_DATE_RE.test(issueDate) || !CIVIL_DATE_RE.test(dueDate)) {
    return { ok: false, error: 'Las fechas de emisión y vencimiento son obligatorias.' }
  }
  if (dueDate < issueDate) {
    return { ok: false, error: 'La fecha de vencimiento no puede ser anterior a la emisión.' }
  }
  if (
    !Number.isFinite(totalAmount) ||
    totalAmount <= 0 ||
    !Number.isFinite(netAmount) ||
    netAmount < 0 ||
    !Number.isFinite(taxAmount) ||
    taxAmount < 0 ||
    Math.round((netAmount + taxAmount) * 100) !== Math.round(totalAmount * 100)
  ) {
    return { ok: false, error: 'Neto, IVA y Total deben ser consistentes y mayores a 0.' }
  }
  if (serviceDeliveryStatus !== 'DELIVERED' && serviceDeliveryStatus !== 'PENDING') {
    return { ok: false, error: 'Estado de prestación inválido.' }
  }
  if (!attachmentFile) {
    return { ok: false, error: 'Debe adjuntar un archivo PDF o imagen de respaldo para registrar la factura de servicio.' }
  }

  let uploadedPath: string | null = null
  let attachmentName: string | null = null
  let attachmentMime: string | null = null

  try {
    const db = await authorizedClient()

    if (attachmentFile.size > MAX_SERVICE_ATTACHMENT_BYTES) {
      return { ok: false, error: 'El archivo adjunto supera el límite de 20 MB.' }
    }
    const mimeType = attachmentFile.type || inferMimeType(attachmentFile.name, attachmentFile.name)
    if (!mimeType || !ALLOWED_SERVICE_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      return { ok: false, error: 'Formato de respaldo no permitido. Use PDF, JPG, PNG o WEBP.' }
    }
    const ext = MIME_TO_EXTENSION[mimeType]
    if (!ext) {
      return { ok: false, error: 'Extensión de archivo no permitida.' }
    }
    uploadedPath = `${CAYLO}/services/${randomUUID()}.${ext}`
    attachmentName = attachmentFile.name.replace(/[^\w.\-\s()]/g, '_').slice(0, 180) || `factura-servicio.${ext}`
    attachmentMime = mimeType

    const buffer = Buffer.from(await attachmentFile.arrayBuffer())
    const { error: uploadError } = await storageAdminClient()
      .storage.from(SERVICE_DOCUMENT_BUCKET)
      .upload(uploadedPath, buffer, {
        contentType: mimeType,
        upsert: false,
      })

    if (uploadError) {
      uploadedPath = null
      return { ok: false, error: 'No se pudo almacenar el archivo adjunto de la factura.' }
    }

    const { data, error } = await db.rpc('cxp_create_service_invoice', {
      p_supplier_id: supplierId,
      p_document_folio: normalizedFolio,
      p_service_description: serviceDescription,
      p_issue_date: issueDate,
      p_due_date: dueDate,
      p_net_amount: netAmount,
      p_tax_amount: taxAmount,
      p_total_amount: totalAmount,
      p_service_delivery_status: serviceDeliveryStatus,
      p_attachment_storage_path: uploadedPath,
      p_attachment_file_name: attachmentName,
      p_attachment_mime_type: attachmentMime,
    })

    if (error || !data) {
      if (uploadedPath) {
        await storageAdminClient().storage.from(SERVICE_DOCUMENT_BUCKET).remove([uploadedPath]).catch(() => undefined)
      }
      return {
        ok: false,
        error: extractSafeRpcError(error ?? {}, 'No se pudo registrar la factura de servicio.'),
      }
    }

    revalidatePath('/dashboard/cuentas-por-pagar')
    return { ok: true, data: data as CreateServiceInvoiceResult }
  } catch (error) {
    if (uploadedPath) {
      await storageAdminClient().storage.from(SERVICE_DOCUMENT_BUCKET).remove([uploadedPath]).catch(() => undefined)
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo registrar la factura de servicio.',
    }
  }
}
