import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  addDaysToCivilDate,
  calculateChileanTaxBreakdown,
  evaluateInvoiceValidation,
  formatClp,
  formatRut,
  parseNumericAmount,
} from '../src/modules/cuentas-por-pagar/validation-rules.ts'

const root = new URL('..', import.meta.url)
const migration = await readFile(
  new URL('supabase/migrations/20261120120000_cuentas_por_pagar_invoice_validation.sql', root),
  'utf8',
)
const actions = await readFile(new URL('src/app/actions/cuentas-por-pagar.ts', root), 'utf8')
const drawer = await readFile(new URL('src/modules/cuentas-por-pagar/invoice-validation-drawer.tsx', root), 'utf8')
const inbox = await readFile(new URL('src/modules/cuentas-por-pagar/invoice-inbox.tsx', root), 'utf8')
const viewer = await readFile(
  new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal.tsx', root),
  'utf8',
)

const baseReference = {
  linked_receipts_count: 1,
  cancelled_linked_receipts_count: 0,
  unlinked_completed_receipts_count: 0,
  reference_net_amount: 100000,
  reference_tax_amount: 19000,
  reference_gross_amount: 119000,
  reference_gross_rounded: 119000,
  receipt_document_dates: ['2026-11-10'],
  missing_receipt_dates_count: 0,
}

const baseConsistentInput = {
  issueDate: '2026-11-10',
  dueDate: '2026-12-10',
  netAmount: 100000,
  taxAmount: 19000,
  totalAmount: 119000,
  priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
  historicalInitialBalance: null,
  historicalBalanceCutoffDate: null,
  resolveDiscrepancy: false,
  discrepancyResolutionNote: null,
}

test('helper formatting, parsing, tax breakdown and civil date math work cleanly', () => {
  assert.equal(formatRut('12345678k'), '12.345.678-K')
  assert.equal(formatClp(119000), '$119.000')
  assert.equal(parseNumericAmount('$119.000'), 119000)
  assert.equal(parseNumericAmount('119000,50'), 119000.5)
  assert.equal(parseNumericAmount(''), null)
  assert.ok(Number.isNaN(parseNumericAmount('abc')))
  assert.deepEqual(calculateChileanTaxBreakdown(119000), { netAmount: 100000, taxAmount: 19000 })
  assert.equal(addDaysToCivilDate('2026-11-10', 30), '2026-12-10')
  assert.equal(addDaysToCivilDate('2026-02-30', 10), null)
})

test('consistent invoice with reviewed prior payment status enables validation', () => {
  const result = evaluateInvoiceValidation(baseConsistentInput, baseReference, 'RECEIPT')
  assert.equal(result.hasAnyDiscrepancy, false)
  assert.equal(result.effectiveDiscrepancyStatus, 'NONE')
  assert.equal(result.openingPendingBalance, 119000)
  assert.equal(result.priorPaidAmount, 0)
  assert.equal(result.canSavePending, true)
  assert.equal(result.canConfirmValidation, true)
  assert.deepEqual(result.validationBlockers, [])
})

test('sub-peso receipt rounding difference (< $1) does not trigger discrepancy', () => {
  const result = evaluateInvoiceValidation(
    baseConsistentInput,
    {
      ...baseReference,
      reference_gross_amount: 118999.81,
      reference_gross_rounded: 119000,
    },
    'RECEIPT',
  )
  assert.equal(result.hasAmountDiscrepancy, false)
  assert.equal(result.hasAnyDiscrepancy, false)
  assert.equal(result.amountDifference, 0)
  assert.equal(result.canConfirmValidation, true)
})

test('amount discrepancy blocks validation by default and requires >= 10 char note to resolve', () => {
  const unresolved = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      netAmount: null,
      taxAmount: null,
      totalAmount: 125000,
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(unresolved.hasAmountDiscrepancy, true)
  assert.equal(unresolved.amountDifference, 6000)
  assert.equal(unresolved.effectiveDiscrepancyStatus, 'UNRESOLVED')
  assert.equal(unresolved.canSavePending, true)
  assert.equal(unresolved.canConfirmValidation, false)

  const shortNote = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      netAmount: null,
      taxAmount: null,
      totalAmount: 125000,
      resolveDiscrepancy: true,
      discrepancyResolutionNote: 'flete',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(shortNote.effectiveDiscrepancyStatus, 'UNRESOLVED')
  assert.equal(shortNote.canConfirmValidation, false)
  assert.equal(shortNote.canSavePending, false)

  const resolved = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      netAmount: null,
      taxAmount: null,
      totalAmount: 125000,
      resolveDiscrepancy: true,
      discrepancyResolutionNote: 'Flete adicional facturado y aprobado por Gerencia.',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(resolved.effectiveDiscrepancyStatus, 'RESOLVED')
  assert.equal(resolved.canConfirmValidation, true)
})

test('date discrepancy blocks validation until explicitly resolved', () => {
  const unresolved = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      issueDate: '2026-11-12',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(unresolved.hasDateDiscrepancy, true)
  assert.equal(unresolved.canSavePending, true)
  assert.equal(unresolved.canConfirmValidation, false)

  const resolved = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      issueDate: '2026-11-12',
      resolveDiscrepancy: true,
      discrepancyResolutionNote: 'Fecha de emisión corregida según PDF timbrado del SII.',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(resolved.canConfirmValidation, true)
})

test('inconsistent tax breakdown or due date blocks save and validation', () => {
  const badTax = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      netAmount: 100000,
      taxAmount: 18000,
      totalAmount: 119000,
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(badTax.canSavePending, false)
  assert.equal(badTax.canConfirmValidation, false)

  const missingDue = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      dueDate: null,
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(missingDue.canSavePending, true)
  assert.equal(missingDue.canConfirmValidation, false)

  const earlierDue = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      dueDate: '2026-11-05',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(earlierDue.canSavePending, false)
  assert.equal(earlierDue.canConfirmValidation, false)
})

test('prior payment status and opening balance bounds are enforced', () => {
  const unreviewed = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      priorPaymentStatus: 'UNREVIEWED',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(unreviewed.canSavePending, true)
  assert.equal(unreviewed.canConfirmValidation, false)

  const badPartial = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      priorPaymentStatus: 'PARTIAL_PRIOR_PAYMENTS',
      historicalInitialBalance: 119000,
      historicalBalanceCutoffDate: '2026-11-15',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(badPartial.canSavePending, false)
  assert.equal(badPartial.canConfirmValidation, false)

  const validPartial = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      priorPaymentStatus: 'PARTIAL_PRIOR_PAYMENTS',
      historicalInitialBalance: 40000,
      historicalBalanceCutoffDate: '2026-11-15',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(validPartial.openingPendingBalance, 40000)
  assert.equal(validPartial.priorPaidAmount, 79000)
  assert.equal(validPartial.canConfirmValidation, true)

  const validPaid = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      priorPaymentStatus: 'FULLY_PAID_PRIOR',
      historicalInitialBalance: 0,
      historicalBalanceCutoffDate: '2026-11-15',
    },
    baseReference,
    'RECEIPT',
  )
  assert.equal(validPaid.openingPendingBalance, 0)
  assert.equal(validPaid.priorPaidAmount, 119000)
  assert.equal(validPaid.canConfirmValidation, true)
})

test('structural receipt issues block validation even when discrepancy is marked resolved', () => {
  const unlinked = evaluateInvoiceValidation(
    {
      ...baseConsistentInput,
      resolveDiscrepancy: true,
      discrepancyResolutionNote: 'Justificación suficientemente larga para prueba.',
    },
    {
      ...baseReference,
      unlinked_completed_receipts_count: 1,
    },
    'RECEIPT',
  )
  assert.equal(unlinked.canConfirmValidation, false)

  const cancelled = evaluateInvoiceValidation(
    baseConsistentInput,
    {
      ...baseReference,
      cancelled_linked_receipts_count: 1,
    },
    'RECEIPT',
  )
  assert.equal(cancelled.canConfirmValidation, false)

  const none = evaluateInvoiceValidation(
    baseConsistentInput,
    {
      ...baseReference,
      linked_receipts_count: 0,
    },
    'RECEIPT',
  )
  assert.equal(none.canConfirmValidation, false)
})

test('migration defines secure RPCs, constraints, triggers, and schema reload', () => {
  assert.match(migration, /ADD COLUMN prior_payment_status text NOT NULL DEFAULT 'UNREVIEWED'/)
  assert.match(migration, /ADD COLUMN discrepancy_status text NOT NULL DEFAULT 'NONE'/)
  assert.match(migration, /invoices_validated_complete_chk/)
  assert.match(migration, /invoices_prior_payment_balance_chk/)
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog/)
  assert.match(migration, /cuentas_por_pagar\.can_access\(v_company_id\)/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_invoice_summaries\(\)/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_invoice_detail\(p_invoice_id uuid\)/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_receipt_document_for_invoice\(p_invoice_id uuid, p_document_id uuid\)/)
  assert.match(migration, /CREATE FUNCTION public\.cxp_save_invoice_validation\(/)
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO authenticated/)
  assert.match(migration, /NOTIFY pgrst, 'reload schema';/)
})

test('server actions and UI enforce authorization, viewer reuse, and inbox updates', () => {
  assert.match(actions, /authorizedClient\(\)/)
  assert.match(actions, /doc\.storage_path\.startsWith\(expectedPrefix\)/)
  assert.match(actions, /doc\.storage_path\.includes\('\.\.'\)/)
  assert.match(actions, /revalidatePath\('\/dashboard\/cuentas-por-pagar'\)/)
  assert.match(drawer, /PurchaseOrderInvoiceViewerModal/)
  assert.match(drawer, /getCxpReceiptDocumentSignedUrl/)
  assert.match(drawer, /Confirmar validación/)
  assert.match(drawer, /Guardar pendiente/)
  assert.match(inbox, /InvoiceValidationDrawer/)
  assert.match(inbox, /value="VALIDATED"/)
  assert.match(viewer, /getPurchaseOrderInvoiceSignedUrl\(selected\.id\)/)
  assert.match(viewer, /loadSignedUrl \? loadSignedUrl\(selected\.id\) : getPurchaseOrderInvoiceSignedUrl\(selected\.id\)/)
})
