import type {
  ReceiptInvoiceCandidate,
  ServiceDeliveryStatus,
  ServiceInvoiceRow,
  ServiceSupplierOption,
} from './types.ts'

export const ALLOWED_SERVICE_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export const MAX_SERVICE_ATTACHMENT_BYTES = 20 * 1024 * 1024

export type ServiceAmountSource = 'net' | 'total'
export type ServiceTaxType = 'taxable' | 'exempt'

const serviceAmountFormatter = new Intl.NumberFormat('es-CL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatServiceAmount(amount: number): string {
  return `$${serviceAmountFormatter.format(amount)}`
}

// Los cálculos se realizan en centavos para mantener exactamente neto + IVA = total.
export function calculateServiceAmounts(raw: string, source: ServiceAmountSource, taxType: ServiceTaxType): {
  netAmount: number | null
  taxAmount: number | null
  totalAmount: number | null
} {
  const empty = { netAmount: null, taxAmount: null, totalAmount: null }
  const text = raw.trim().replace(/^\$\s*/, '')
  if (!text) return empty
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{0,2})?$/.test(text)) {
    return { netAmount: NaN, taxAmount: NaN, totalAmount: NaN }
  }
  const [whole, fraction = ''] = text.replace(/\./g, '').split(',')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > Math.floor(Number.MAX_SAFE_INTEGER / 119)) {
    return { netAmount: NaN, taxAmount: NaN, totalAmount: NaN }
  }
  const net = source === 'net' || taxType === 'exempt' ? cents : Math.round(cents * 100 / 119)
  const tax = taxType === 'exempt' ? 0 : source === 'net' ? Math.round(cents * 19 / 100) : cents - net
  const total = source === 'total' ? cents : net + tax
  return { netAmount: net / 100, taxAmount: tax / 100, totalAmount: total / 100 }
}

export function normalizeChileanRut(rut: string | null | undefined): string {
  if (!rut) return ''
  return rut.replace(/[.-\s]/g, '').toUpperCase()
}

export function isValidNormalizedRut(rut: string | null | undefined): boolean {
  return /^[0-9]{7,8}[0-9K]$/.test(normalizeChileanRut(rut))
}

export function isValidChileanRut(rut: string | null | undefined): boolean {
  const normalized = normalizeChileanRut(rut)
  if (!/^[0-9]{7,8}[0-9K]$/.test(normalized)) return false
  const body = normalized.slice(0, -1)
  const dv = normalized.slice(-1)
  let sum = 0
  let multiplier = 2
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier
    multiplier = multiplier === 7 ? 2 : multiplier + 1
  }
  const remainder = 11 - (sum % 11)
  const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder)
  return dv === expected
}

export function filterServiceSuppliers(suppliers: ServiceSupplierOption[]): ServiceSupplierOption[] {
  return suppliers.filter(supplier => isValidChileanRut(supplier.rut))
}

export function formatChileanRut(rut: string | null | undefined): string {
  const normalized = normalizeChileanRut(rut)
  if (normalized.length < 2) return normalized
  const body = normalized.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${body}-${normalized.slice(-1)}`
}

export interface QuickSupplierDraftInput {
  rut: string
  businessName: string
  contactEmail?: string | null
  contactPhone?: string | null
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateQuickSupplierDraft(input: QuickSupplierDraftInput): string[] {
  const errors: string[] = []
  if (!isValidChileanRut(input.rut)) {
    errors.push('Ingrese un RUT chileno válido (con dígito verificador correcto).')
  }
  const name = input.businessName.trim()
  if (name.length < 2) {
    errors.push('La razón social es obligatoria.')
  } else if (name.length > 200) {
    errors.push('La razón social no puede superar los 200 caracteres.')
  }
  const email = (input.contactEmail ?? '').trim()
  if (email && !SIMPLE_EMAIL_RE.test(email)) {
    errors.push('Correo electrónico inválido.')
  }
  const phone = (input.contactPhone ?? '').trim()
  if (phone.length > 50) {
    errors.push('El teléfono no puede superar los 50 caracteres.')
  }
  return errors
}

export function upsertSupplierOption(
  suppliers: ServiceSupplierOption[],
  created: ServiceSupplierOption,
): ServiceSupplierOption[] {
  const next = [...suppliers.filter(s => s.id !== created.id), created]
  return next.sort((a, b) =>
    a.business_name.localeCompare(b.business_name, 'es', { sensitivity: 'base' }),
  )
}

export function normalizeNumericFolio(folio: string | null | undefined): string | null {
  const trimmed = (folio ?? '').trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  return trimmed.replace(/^0+([0-9])/, '$1')
}

export interface ServiceInvoiceDraftInput {
  supplierId: string
  supplierRut: string | null
  folio: string
  serviceDescription: string
  issueDate: string
  dueDate: string
  netAmount: number | null
  taxAmount: number | null
  totalAmount: number | null
  serviceDeliveryStatus: ServiceDeliveryStatus
  attachment?: { size: number; type: string; name: string } | null
}

export function validateServiceInvoiceDraft(input: ServiceInvoiceDraftInput): string[] {
  const errors: string[] = []

  if (!input.supplierId.trim()) {
    errors.push('Debe seleccionar un proveedor del catálogo.')
  } else if (!isValidNormalizedRut(input.supplierRut)) {
    errors.push('El proveedor seleccionado no tiene un RUT válido registrado.')
  }

  if (!normalizeNumericFolio(input.folio)) {
    errors.push('El folio debe contener solo dígitos numéricos.')
  }

  if (input.serviceDescription.trim().length < 3) {
    errors.push('La descripción del servicio es obligatoria (mínimo 3 caracteres).')
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) {
    errors.push('La fecha de emisión es obligatoria.')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    errors.push('La fecha de vencimiento es obligatoria.')
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate) && input.dueDate < input.issueDate) {
    errors.push('La fecha de vencimiento no puede ser anterior a la fecha de emisión.')
  }

  if (input.totalAmount === null || !Number.isFinite(input.totalAmount) || input.totalAmount <= 0) {
    errors.push('El monto total debe ser mayor a $0.')
  }
  if (input.netAmount === null || !Number.isFinite(input.netAmount) || input.netAmount < 0) {
    errors.push('El monto neto es obligatorio y no puede ser negativo.')
  }
  if (input.taxAmount === null || !Number.isFinite(input.taxAmount) || input.taxAmount < 0) {
    errors.push('El IVA es obligatorio y no puede ser negativo.')
  }
  if (
    input.netAmount !== null &&
    input.taxAmount !== null &&
    input.totalAmount !== null &&
    Number.isFinite(input.netAmount) &&
    Number.isFinite(input.taxAmount) &&
    Number.isFinite(input.totalAmount) &&
    Math.round((input.netAmount + input.taxAmount) * 100) !== Math.round(input.totalAmount * 100)
  ) {
    errors.push('La suma de neto más IVA debe coincidir exactamente con el total.')
  }

  if (input.serviceDeliveryStatus !== 'DELIVERED' && input.serviceDeliveryStatus !== 'PENDING') {
    errors.push('Seleccione el estado de prestación del servicio.')
  }

  if (!input.attachment) {
    errors.push('Debe adjuntar el PDF o imagen de respaldo de la factura.')
  } else {
    if (input.attachment.size <= 0 || input.attachment.size > MAX_SERVICE_ATTACHMENT_BYTES) {
      errors.push('El archivo adjunto debe pesar hasta 20 MB.')
    }
    if (!ALLOWED_SERVICE_ATTACHMENT_MIME_TYPES.has(input.attachment.type)) {
      errors.push('Formato no permitido. Adjunte PDF, JPG, PNG o WEBP.')
    }
  }

  return errors
}

export function serviceInvoiceToInboxCandidate(row: ServiceInvoiceRow): ReceiptInvoiceCandidate {
  return {
    candidate_id: `service:${row.id}`,
    issuer_rut: row.issuer_rut,
    supplier_name: row.supplier_name,
    folio: row.folio,
    issue_date: row.issue_date,
    purchase_orders: [],
    receipt_ids: [],
    reference_amount: null,
    has_document: row.has_document,
    invoice_id: row.id,
    invoice_status: row.validation_status,
    blocked_reason: null,
    purchase_type: 'SERVICES',
    reception_status: row.service_delivery_status === 'DELIVERED' ? 'RECEIVED' : 'PENDING',
    service_description: row.service_description,
  }
}

export function mergeInboxCandidates(
  productCandidates: ReceiptInvoiceCandidate[],
  serviceInvoices: ServiceInvoiceRow[],
): ReceiptInvoiceCandidate[] {
  const merged = [
    ...productCandidates,
    ...serviceInvoices.map(serviceInvoiceToInboxCandidate),
  ]
  return merged.sort((a, b) => {
    const dateA = a.issue_date ?? ''
    const dateB = b.issue_date ?? ''
    if (dateA !== dateB) return dateB.localeCompare(dateA)
    const supCmp = a.supplier_name.localeCompare(b.supplier_name, 'es', { sensitivity: 'base' })
    if (supCmp !== 0) return supCmp
    return (a.folio ?? '').localeCompare(b.folio ?? '', 'es', { numeric: true })
  })
}
