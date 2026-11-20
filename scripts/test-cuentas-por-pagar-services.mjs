import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  formatChileanRut,
  isValidChileanRut,
  mergeInboxCandidates,
  normalizeChileanRut,
  normalizeNumericFolio,
  serviceInvoiceToInboxCandidate,
  upsertSupplierOption,
  validateQuickSupplierDraft,
  validateServiceInvoiceDraft,
} from '../src/modules/cuentas-por-pagar/service-rules.ts'
import { purchaseTypeLabel, receptionStatusLabel } from '../src/modules/cuentas-por-pagar/classification.ts'

const root = new URL('..', import.meta.url)
const migration = await readFile(
  new URL('supabase/migrations/20261120140000_cuentas_por_pagar_service_invoices.sql', root),
  'utf8',
)
const nav = await readFile(new URL('src/modules/cuentas-por-pagar/navigation.ts', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/cuentas-por-pagar.ts', root), 'utf8')
const form = await readFile(new URL('src/modules/cuentas-por-pagar/service-invoice-form.tsx', root), 'utf8')
const quickModal = await readFile(new URL('src/modules/cuentas-por-pagar/quick-supplier-modal.tsx', root), 'utf8')
const page = await readFile(new URL('src/app/dashboard/cuentas-por-pagar/page.tsx', root), 'utf8')

const validDraft = {
  supplierId: '30000000-0000-0000-0000-000000000011',
  supplierRut: '76.123.456-7',
  folio: '0015420',
  serviceDescription: 'Arriendo bodega noviembre',
  issueDate: '2026-11-10',
  dueDate: '2026-12-10',
  netAmount: 100000,
  taxAmount: 19000,
  totalAmount: 119000,
  serviceDeliveryStatus: 'PENDING',
  attachment: { size: 120000, type: 'application/pdf', name: 'factura.pdf' },
}

test('normalizes RUT and folio and validates complete service invoice draft', () => {
  assert.equal(normalizeChileanRut('76.123.456-k'), '76123456K')
  assert.equal(normalizeNumericFolio('0015420'), '15420')
  assert.equal(normalizeNumericFolio('FA-15420'), null)
  assert.deepEqual(validateServiceInvoiceDraft(validDraft), [])
})

test('rejects service draft without mandatory PDF/image attachment', () => {
  const errors = validateServiceInvoiceDraft({
    ...validDraft,
    attachment: null,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /adjuntar el PDF o imagen de respaldo/)
})

test('rejects invalid service draft (missing RUT, bad dates, mismatched tax, invalid file)', () => {
  const errors = validateServiceInvoiceDraft({
    ...validDraft,
    supplierRut: null,
    folio: 'ABC',
    serviceDescription: 'ab',
    dueDate: '2026-11-01',
    taxAmount: 18000,
    attachment: { size: 25 * 1024 * 1024, type: 'application/zip', name: 'bad.zip' },
  })
  assert.ok(errors.length >= 6)
})

test('merges service invoices with product inbox rows showing Servicio and Prestado/Pendiente', () => {
  const productRow = {
    candidate_id: 'prod-1',
    issuer_rut: '761112223',
    supplier_name: 'Proveedor Productos',
    folio: '100',
    issue_date: '2026-11-09',
    purchase_orders: ['OC-2026-000010'],
    receipt_ids: ['r-1'],
    reference_amount: 500000,
    has_document: true,
    invoice_id: null,
    invoice_status: null,
    blocked_reason: null,
    purchase_type: 'PRODUCTS',
    reception_status: 'RECEIVED',
  }

  const servicePending = {
    id: 'svc-1',
    issuer_rut: '769998887',
    supplier_id: 'sup-1',
    supplier_name: 'Servicios Logísticos SpA',
    folio: '9001',
    issue_date: '2026-11-11',
    due_date: '2026-12-11',
    net_amount: 100000,
    tax_amount: 19000,
    total_amount: 119000,
    service_description: 'Flete especial',
    service_delivery_status: 'PENDING',
    has_document: true,
    validation_status: 'PENDING',
    prior_payment_status: 'UNREVIEWED',
    historical_initial_balance: null,
    discrepancy_status: 'NONE',
    validated_at: null,
  }

  const serviceDelivered = {
    ...servicePending,
    id: 'svc-2',
    folio: '9002',
    service_delivery_status: 'DELIVERED',
  }

  const pendingCandidate = serviceInvoiceToInboxCandidate(servicePending)
  assert.equal(purchaseTypeLabel(pendingCandidate.purchase_type), 'Servicio')
  assert.equal(receptionStatusLabel(pendingCandidate.reception_status, pendingCandidate.purchase_type), 'Pendiente')

  const deliveredCandidate = serviceInvoiceToInboxCandidate(serviceDelivered)
  assert.equal(receptionStatusLabel(deliveredCandidate.reception_status, deliveredCandidate.purchase_type), 'Prestado')

  const merged = mergeInboxCandidates([productRow], [servicePending, serviceDelivered])
  assert.equal(merged.length, 3)
  assert.equal(merged[0].purchase_type, 'SERVICES')
})

test('migration, navigation, server actions, and form enforce security, office duplicate prevention, and sidebar routes', () => {
  assert.match(migration, /ADD COLUMN purchase_type text NOT NULL DEFAULT 'PRODUCTS'/)
  assert.match(migration, /ADD COLUMN service_delivery_status text/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_create_service_invoice\(/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_service_invoices\(\)/)
  assert.match(migration, /v_existing_receipt_type = 'OFFICE'/)
  assert.match(migration, /registrada anteriormente como recepción de oficina/)
  assert.match(migration, /El archivo de respaldo no existe en el almacenamiento privado/)
  assert.match(migration, /FROM storage\.objects o WHERE o\.bucket_id = ''cuentas-por-pagar''/)
  assert.match(migration, /NOTIFY pgrst, 'reload schema';/)
  assert.match(nav, /ingreso-servicios/)
  assert.match(nav, /Ingreso de Servicios/)
  assert.match(actions, /export async function createServiceInvoice/)
  assert.match(actions, /if \(!attachmentFile\)/)
  assert.match(actions, /export async function getServiceInvoices/)
  assert.match(actions, /storageAdminClient\(\)\.storage\.from\(SERVICE_DOCUMENT_BUCKET\)\.remove\(\[uploadedPath\]\)/)
  assert.match(form, /LocalCombobox/)
  assert.match(form, /Registrar factura de servicio/)
  assert.match(form, /obligatorio para registrar/)
  assert.doesNotMatch(form, /opcional al registrar/i)
  assert.match(form, /Nuevo proveedor/)
  assert.match(form, /upsertSupplierOption\(prev, created\)/)
  assert.match(form, /setSupplierId\(created\.id\)/)
  assert.match(quickModal, /createQuickServiceSupplier/)
  assert.match(quickModal, /No crea ni sincroniza registros en Bsale/)
  assert.match(actions, /export async function createQuickServiceSupplier/)
  assert.doesNotMatch(actions, /bsale/i)
  assert.match(migration, /s\.supplier_kind = 'REAL'/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_create_service_supplier\(/)
  assert.match(migration, /'REAL',\s*'MANUAL'/)
  assert.match(page, /mergeInboxCandidates/)
})

test('quick supplier validates Chilean RUT (Mod 11), optional fields, and sorts/auto-selects new supplier', () => {
  assert.equal(isValidChileanRut('76.123.456-7'), false)
  assert.equal(isValidChileanRut('76.123.456-K'), false)
  assert.equal(isValidChileanRut('11.111.111-1'), true)
  assert.equal(isValidChileanRut('76086428-5'), true)
  assert.equal(formatChileanRut('760864285'), '76.086.428-5')

  assert.deepEqual(
    validateQuickSupplierDraft({
      rut: '76.086.428-5',
      businessName: 'Servicios Alfa SpA',
      contactEmail: 'facturacion@alfa.cl',
      contactPhone: '+56 9 1111 2222',
    }),
    [],
  )

  const invalid = validateQuickSupplierDraft({
    rut: '76.086.428-9',
    businessName: 'A',
    contactEmail: 'correo-malo',
  })
  assert.equal(invalid.length, 3)

  const existing = [
    { id: 'sup-z', business_name: 'Zeta Servicios', fantasy_name: null, rut: '11.111.111-1', payment_terms: null, credit_days: 0 },
  ]
  const created = {
    id: 'sup-a',
    business_name: 'Alfa Servicios',
    fantasy_name: null,
    rut: '76.086.428-5',
    payment_terms: null,
    credit_days: 0,
  }
  const updated = upsertSupplierOption(existing, created)
  assert.deepEqual(updated.map(s => s.id), ['sup-a', 'sup-z'])
})
