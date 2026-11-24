import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  classifyThrownPaymentError,
  executeRegisterInvoicePayment,
  executeReopenInvoiceValidation,
  executeReverseInvoicePayment,
  fetchInvoicePayments,
} from '../src/modules/cuentas-por-pagar/payment-service.ts'

const CAYLO = 'd1000000-0000-0000-0000-000000000001'
const INVOICE_ID = 'a1000000-0000-0000-0000-000000000001'
const USER_ID = '11111111-1111-1111-1111-111111111111'

test('Consulta correcta de historial y saldos via cxp_invoice_payments', async () => {
  const calls = []
  const db = {
    async rpc(fn, args) {
      calls.push({ fn, args })
      return {
        data: {
          invoice_id: INVOICE_ID,
          company_id: CAYLO,
          validation_status: 'VALIDATED',
          total_amount: 500000,
          prior_payment_status: 'PARTIAL_PRIOR_PAYMENTS',
          historical_initial_balance: 300000,
          historical_balance_cutoff_date: '2026-11-10',
          initial_balance: 300000,
          prior_paid_amount: 200000,
          module_paid_amount: 100000,
          total_paid_amount: 300000,
          current_balance: 200000,
          payment_count: 1,
          is_fully_paid: false,
          can_register_payment: true,
          payments: [
            {
              id: randomUUID(),
              company_id: CAYLO,
              invoice_id: INVOICE_ID,
              payment_date: '2026-11-15',
              amount: 100000,
              reference: 'TEF 001',
              operation_id: randomUUID(),
              created_at: '2026-11-15T14:00:00.000Z',
              created_by: USER_ID,
              created_by_name: 'María González',
            },
          ],
        },
        error: null,
      }
    },
  }

  const res = await fetchInvoicePayments(db, INVOICE_ID)
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].fn, 'cxp_invoice_payments')
  assert.deepEqual(calls[0].args, { p_invoice_id: INVOICE_ID })
  assert.equal(res.data.prior_paid_amount, 200000)
  assert.equal(res.data.module_paid_amount, 100000)
  assert.equal(res.data.current_balance, 200000)
  assert.equal(res.data.payments.length, 1)
  assert.equal(res.data.payments[0].created_by_name, 'María González')
})

test('Registro satisfactorio de pago y conservación de operationId', async () => {
  const operationId = randomUUID()
  const calls = []
  const db = {
    async rpc(fn, args) {
      calls.push({ fn, args })
      return {
        data: {
          idempotent_replay: false,
          payment: {
            id: randomUUID(),
            company_id: CAYLO,
            invoice_id: INVOICE_ID,
            payment_date: '2026-11-22',
            amount: 150000,
            reference: 'Transferencia #99',
            operation_id: args.p_operation_id,
            created_at: '2026-11-22T18:00:00.000Z',
            created_by: USER_ID,
          },
          balance: {
            invoice_id: INVOICE_ID,
            company_id: CAYLO,
            validation_status: 'VALIDATED',
            total_amount: 500000,
            prior_payment_status: 'NO_PRIOR_PAYMENTS',
            historical_initial_balance: null,
            historical_balance_cutoff_date: null,
            initial_balance: 500000,
            prior_paid_amount: 0,
            module_paid_amount: 150000,
            total_paid_amount: 150000,
            current_balance: 350000,
            payment_count: 1,
            is_fully_paid: false,
            can_register_payment: true,
          },
        },
        error: null,
      }
    },
  }

  const res = await executeRegisterInvoicePayment(db, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 150000,
    reference: '  Transferencia #99  ',
    operationId,
  })

  assert.equal(res.ok, true)
  assert.equal(res.code, 'PAYMENT_REGISTERED')
  assert.equal(res.idempotentReplay, false)
  assert.equal(res.operationId, operationId)
  assert.equal(res.balance.current_balance, 350000)
  assert.equal(calls[0].fn, 'cxp_register_invoice_payment')
  assert.equal(calls[0].args.p_operation_id, operationId)
  assert.equal(calls[0].args.p_reference, 'Transferencia #99')
})

test('Fallo de red incierto seguido de reintento idempotente conserva el mismo operationId', async () => {
  const operationId = randomUUID()
  const sentOperationIds = []
  let attempt = 0

  const db = {
    async rpc(_fn, args) {
      sentOperationIds.push(args.p_operation_id)
      attempt += 1
      if (attempt === 1) {
        throw new Error('fetch failed: ECONNRESET')
      }
      return {
        data: {
          idempotent_replay: true,
          payment: {
            id: randomUUID(),
            company_id: CAYLO,
            invoice_id: INVOICE_ID,
            payment_date: '2026-11-22',
            amount: 100000,
            reference: null,
            operation_id: args.p_operation_id,
            created_at: '2026-11-22T18:01:00.000Z',
            created_by: USER_ID,
          },
          balance: {
            invoice_id: INVOICE_ID,
            company_id: CAYLO,
            validation_status: 'VALIDATED',
            total_amount: 500000,
            prior_payment_status: 'NO_PRIOR_PAYMENTS',
            historical_initial_balance: null,
            historical_balance_cutoff_date: null,
            initial_balance: 500000,
            prior_paid_amount: 0,
            module_paid_amount: 100000,
            total_paid_amount: 100000,
            current_balance: 400000,
            payment_count: 1,
            is_fully_paid: false,
            can_register_payment: true,
          },
        },
        error: null,
      }
    },
  }

  const first = await executeRegisterInvoicePayment(db, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 100000,
    operationId,
  })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'CONNECTION_OR_UNKNOWN_ERROR')
  assert.equal(first.uncertainOutcome, true)
  assert.equal(first.operationId, operationId)

  const retry = await executeRegisterInvoicePayment(db, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 100000,
    operationId: first.operationId,
  })
  assert.equal(retry.ok, true)
  assert.equal(retry.code, 'IDEMPOTENT_REPLAY')
  assert.equal(retry.idempotentReplay, true)
  assert.equal(retry.operationId, operationId)
  assert.deepEqual(sentOperationIds, [operationId, operationId])
})

test('Errores de autorización (42501 y sesión/empresa inválida)', async () => {
  const dbDenied = {
    async rpc() {
      return {
        data: null,
        error: { code: '42501', message: 'Acceso a Cuentas por Pagar denegado' },
      }
    },
  }

  const regDenied = await executeRegisterInvoicePayment(dbDenied, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 50000,
    operationId: randomUUID(),
  })
  assert.equal(regDenied.ok, false)
  assert.equal(regDenied.code, 'ACCESS_DENIED')
  assert.equal(regDenied.uncertainOutcome, false)

  const readDenied = await fetchInvoicePayments(dbDenied, INVOICE_ID)
  assert.equal(readDenied.ok, false)
  assert.equal(readDenied.code, 'ACCESS_DENIED')

  const authThrown = classifyThrownPaymentError(
    new Error('Seleccione Caylo y acceda con un usuario autorizado.'),
    'Fallback',
  )
  assert.equal(authThrown.code, 'ACCESS_DENIED')
  assert.equal(authThrown.uncertainOutcome, false)
})

test('Errores de negocio: sobrepago, factura no validada, fecha inválida y validaciones locales', async () => {
  const operationId = randomUUID()

  const overpayDb = {
    async rpc() {
      return {
        data: null,
        error: {
          code: 'P0001',
          message: 'El monto del pago (300000.00) supera el saldo pendiente (200000.00)',
        },
      }
    },
  }
  const overpay = await executeRegisterInvoicePayment(overpayDb, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 300000,
    operationId,
  })
  assert.equal(overpay.ok, false)
  assert.equal(overpay.code, 'OVERPAYMENT')
  assert.equal(overpay.uncertainOutcome, false)

  const unvalidatedDb = {
    async rpc() {
      return {
        data: null,
        error: {
          code: 'P0001',
          message: 'Solo se pueden registrar pagos sobre facturas validadas',
        },
      }
    },
  }
  const unvalidated = await executeRegisterInvoicePayment(unvalidatedDb, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 10000,
    operationId,
  })
  assert.equal(unvalidated.ok, false)
  assert.equal(unvalidated.code, 'INVOICE_NOT_VALIDATED')

  const futureDateDb = {
    async rpc() {
      return {
        data: null,
        error: {
          code: 'P0001',
          message: 'La fecha efectiva del pago no puede ser futura respecto de Chile (America/Santiago)',
        },
      }
    },
  }
  const futureDate = await executeRegisterInvoicePayment(futureDateDb, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-12-01',
    amount: 10000,
    operationId,
  })
  assert.equal(futureDate.ok, false)
  assert.equal(futureDate.code, 'INVALID_DATE')

  // Local calendar date validation does not call RPC
  let rpcCalled = false
  const neverCalledDb = {
    async rpc() {
      rpcCalled = true
      return { data: null, error: null }
    },
  }
  const badCal = await executeRegisterInvoicePayment(neverCalledDb, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-02-30',
    amount: 10000,
    operationId,
  })
  assert.equal(badCal.ok, false)
  assert.equal(badCal.code, 'INVALID_DATE')
  assert.equal(rpcCalled, false)

  const missingOp = await executeRegisterInvoicePayment(neverCalledDb, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 10000,
    operationId: '',
  })
  assert.equal(missingOp.ok, false)
  assert.equal(missingOp.code, 'VALIDATION_ERROR')
  assert.equal(rpcCalled, false)
})

test('Respuesta nula o incompleta de DB nunca confirma el pago', async () => {
  const operationId = randomUUID()
  const dbNull = {
    async rpc() {
      return { data: null, error: null }
    },
  }

  const res = await executeRegisterInvoicePayment(dbNull, {
    invoiceId: INVOICE_ID,
    paymentDate: '2026-11-22',
    amount: 10000,
    operationId,
  })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'CONNECTION_OR_UNKNOWN_ERROR')
  assert.equal(res.uncertainOutcome, true)
  assert.equal(res.operationId, operationId)
})

test('Reversa exitosa via cxp_reverse_invoice_payment e historial con estado ACTIVE y REVERSED', async () => {
  const paymentId = randomUUID()
  const operationId = randomUUID()
  const reversalId = randomUUID()
  const calls = []

  const db = {
    async rpc(fn, args) {
      calls.push({ fn, args })
      if (fn === 'cxp_reverse_invoice_payment') {
        return {
          data: {
            idempotent_replay: false,
            reversal: {
              id: reversalId,
              company_id: CAYLO,
              invoice_id: INVOICE_ID,
              payment_id: paymentId,
              reason: 'Error de digitación',
              operation_id: args.p_operation_id,
              created_at: '2026-11-22T20:00:00.000Z',
              created_by: USER_ID,
            },
            payment: {
              id: paymentId,
              company_id: CAYLO,
              invoice_id: INVOICE_ID,
              payment_date: '2026-11-20',
              amount: 150000,
              reference: 'TEF 100',
              operation_id: randomUUID(),
              created_at: '2026-11-20T15:00:00.000Z',
              created_by: USER_ID,
              is_reversed: true,
              status: 'REVERSED',
            },
            balance: {
              invoice_id: INVOICE_ID,
              company_id: CAYLO,
              validation_status: 'VALIDATED',
              total_amount: 500000,
              prior_payment_status: 'NO_PRIOR_PAYMENTS',
              historical_initial_balance: null,
              historical_balance_cutoff_date: null,
              initial_balance: 500000,
              prior_paid_amount: 0,
              module_paid_amount: 0,
              total_paid_amount: 0,
              current_balance: 500000,
              payment_count: 0,
              reversed_payment_count: 1,
              reversed_amount: 150000,
              is_fully_paid: false,
              can_register_payment: true,
            },
          },
          error: null,
        }
      }

      return {
        data: {
          invoice_id: INVOICE_ID,
          company_id: CAYLO,
          validation_status: 'VALIDATED',
          total_amount: 500000,
          prior_payment_status: 'NO_PRIOR_PAYMENTS',
          historical_initial_balance: null,
          historical_balance_cutoff_date: null,
          initial_balance: 500000,
          prior_paid_amount: 0,
          module_paid_amount: 100000,
          total_paid_amount: 100000,
          current_balance: 400000,
          payment_count: 1,
          reversed_payment_count: 1,
          reversed_amount: 150000,
          is_fully_paid: false,
          can_register_payment: true,
          payments: [
            {
              id: paymentId,
              company_id: CAYLO,
              invoice_id: INVOICE_ID,
              payment_date: '2026-11-20',
              amount: 150000,
              reference: 'TEF 100',
              operation_id: randomUUID(),
              created_at: '2026-11-20T15:00:00.000Z',
              created_by: USER_ID,
              created_by_name: 'María González',
              is_reversed: true,
              status: 'REVERSED',
              reversal: {
                id: reversalId,
                reason: 'Error de digitación',
                operation_id: operationId,
                created_at: '2026-11-22T20:00:00.000Z',
                created_by: USER_ID,
                created_by_name: 'Carlos Gerente',
              },
            },
            {
              id: randomUUID(),
              company_id: CAYLO,
              invoice_id: INVOICE_ID,
              payment_date: '2026-11-22',
              amount: 100000,
              reference: 'TEF 101',
              operation_id: randomUUID(),
              created_at: '2026-11-22T20:05:00.000Z',
              created_by: USER_ID,
              created_by_name: 'María González',
              is_reversed: false,
              status: 'ACTIVE',
              reversal: null,
            },
          ],
        },
        error: null,
      }
    },
  }

  const rev = await executeReverseInvoicePayment(db, {
    paymentId,
    operationId,
    reason: '  Error de digitación  ',
  })
  assert.equal(rev.ok, true)
  assert.equal(rev.code, 'REVERSAL_REGISTERED')
  assert.equal(rev.idempotentReplay, false)
  assert.equal(rev.operationId, operationId)
  assert.equal(rev.payment.status, 'REVERSED')
  assert.equal(rev.payment.is_reversed, true)
  assert.equal(rev.balance.current_balance, 500000)
  assert.equal(rev.balance.reversed_payment_count, 1)
  assert.equal(rev.balance.reversed_amount, 150000)
  assert.deepEqual(calls[0], {
    fn: 'cxp_reverse_invoice_payment',
    args: {
      p_payment_id: paymentId,
      p_operation_id: operationId,
      p_reason: 'Error de digitación',
    },
  })

  const hist = await fetchInvoicePayments(db, INVOICE_ID)
  assert.equal(hist.ok, true)
  assert.equal(hist.data.reversed_payment_count, 1)
  assert.equal(hist.data.reversed_amount, 150000)
  assert.equal(hist.data.payments[0].status, 'REVERSED')
  assert.equal(hist.data.payments[0].reversal?.reason, 'Error de digitación')
  assert.equal(hist.data.payments[0].reversal?.created_by_name, 'Carlos Gerente')
  assert.equal(hist.data.payments[1].status, 'ACTIVE')
  assert.equal(hist.data.payments[1].reversal, null)
})

test('Reversa: fallo de red incierto conserva operationId y reintento idempotente retorna IDEMPOTENT_REPLAY', async () => {
  const paymentId = randomUUID()
  const operationId = randomUUID()
  const sentOperationIds = []
  let attempt = 0

  const db = {
    async rpc(_fn, args) {
      sentOperationIds.push(args.p_operation_id)
      attempt += 1
      if (attempt === 1) {
        throw new Error('network timeout')
      }
      return {
        data: {
          idempotent_replay: true,
          reversal: {
            id: randomUUID(),
            reason: 'Duplicado',
            operation_id: args.p_operation_id,
            created_at: '2026-11-22T20:01:00.000Z',
            created_by: USER_ID,
          },
          payment: {
            id: paymentId,
            company_id: CAYLO,
            invoice_id: INVOICE_ID,
            payment_date: '2026-11-20',
            amount: 100000,
            reference: null,
            operation_id: randomUUID(),
            created_at: '2026-11-20T15:00:00.000Z',
            created_by: USER_ID,
            is_reversed: true,
            status: 'REVERSED',
          },
          balance: {
            invoice_id: INVOICE_ID,
            company_id: CAYLO,
            validation_status: 'VALIDATED',
            total_amount: 500000,
            prior_payment_status: 'NO_PRIOR_PAYMENTS',
            historical_initial_balance: null,
            historical_balance_cutoff_date: null,
            initial_balance: 500000,
            prior_paid_amount: 0,
            module_paid_amount: 0,
            total_paid_amount: 0,
            current_balance: 500000,
            payment_count: 0,
            reversed_payment_count: 1,
            reversed_amount: 100000,
            is_fully_paid: false,
            can_register_payment: true,
          },
        },
        error: null,
      }
    },
  }

  const first = await executeReverseInvoicePayment(db, {
    paymentId,
    operationId,
    reason: 'Duplicado',
  })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'CONNECTION_OR_UNKNOWN_ERROR')
  assert.equal(first.uncertainOutcome, true)
  assert.equal(first.operationId, operationId)

  const retry = await executeReverseInvoicePayment(db, {
    paymentId,
    operationId: first.operationId,
    reason: 'Duplicado',
  })
  assert.equal(retry.ok, true)
  assert.equal(retry.code, 'IDEMPOTENT_REPLAY')
  assert.equal(retry.idempotentReplay, true)
  assert.equal(retry.operationId, operationId)
  assert.deepEqual(sentOperationIds, [operationId, operationId])
})

test('Reversa: ALREADY_REVERSED, errores de negocio, autorización y respuesta incompleta', async () => {
  const paymentId = randomUUID()
  const operationId = randomUUID()

  const alreadyReversedDb = {
    async rpc() {
      return {
        data: null,
        error: { code: 'P0001', message: 'El pago ya fue reversado previamente' },
      }
    },
  }
  const already = await executeReverseInvoicePayment(alreadyReversedDb, {
    paymentId,
    operationId,
    reason: 'Segundo intento',
  })
  assert.equal(already.ok, false)
  assert.equal(already.code, 'ALREADY_REVERSED')
  assert.equal(already.uncertainOutcome, false)
  assert.equal(already.operationId, operationId)

  const deniedDb = {
    async rpc() {
      return {
        data: null,
        error: { code: '42501', message: 'Acceso a Cuentas por Pagar denegado' },
      }
    },
  }
  const denied = await executeReverseInvoicePayment(deniedDb, {
    paymentId,
    operationId,
    reason: 'Motivo válido',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'ACCESS_DENIED')
  assert.equal(denied.uncertainOutcome, false)

  let rpcCalled = false
  const localDb = {
    async rpc() {
      rpcCalled = true
      return { data: null, error: null }
    },
  }
  const shortReason = await executeReverseInvoicePayment(localDb, {
    paymentId,
    operationId,
    reason: 'ab',
  })
  assert.equal(shortReason.ok, false)
  assert.equal(shortReason.code, 'VALIDATION_ERROR')
  assert.equal(rpcCalled, false)

  const incompleteDb = {
    async rpc() {
      return { data: { idempotent_replay: false }, error: null }
    },
  }
  const incomplete = await executeReverseInvoicePayment(incompleteDb, {
    paymentId,
    operationId,
    reason: 'Motivo válido',
  })
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.code, 'CONNECTION_OR_UNKNOWN_ERROR')
  assert.equal(incomplete.uncertainOutcome, true)
  assert.equal(incomplete.operationId, operationId)
})

test('Reapertura administrativa (cxp_reopen_invoice_validation): exige 0 pagos activos, permite pagos reversados, exige motivo y devuelve PENDING / UNREVIEWED', async () => {
  const operationId = randomUUID()
  const reopeningId = randomUUID()
  const calls = []

  // 1) Factura con pagos reversados y 0 pagos activos -> reapertura exitosa a PENDING / UNREVIEWED
  const dbSuccess = {
    async rpc(fn, args) {
      calls.push({ fn, args })
      return {
        data: {
          idempotent_replay: false,
          reopening: {
            id: reopeningId,
            company_id: CAYLO,
            invoice_id: INVOICE_ID,
            reason: 'Regularización de validación de prueba FA 163496',
            operation_id: args.p_operation_id,
            previous_validation_status: 'VALIDATED',
            previous_prior_payment_status: 'NO_PRIOR_PAYMENTS',
            previous_total_amount: 373184,
            previous_validated_at: '2026-11-22T20:29:00.000Z',
            previous_validated_by: USER_ID,
            created_at: '2026-11-23T19:10:00.000Z',
            created_by: USER_ID,
          },
          invoice: {
            id: INVOICE_ID,
            company_id: CAYLO,
            validation_status: 'PENDING',
            prior_payment_status: 'UNREVIEWED',
            total_amount: 373184,
            historical_initial_balance: null,
            historical_balance_cutoff_date: null,
            validated_at: null,
            validated_by: null,
          },
          balance: {
            invoice_id: INVOICE_ID,
            company_id: CAYLO,
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
            payment_count: 0,
            reversed_payment_count: 1,
            reversed_amount: 373184,
            is_fully_paid: false,
            can_register_payment: false,
          },
        },
        error: null,
      }
    },
  }

  const reopened = await executeReopenInvoiceValidation(dbSuccess, {
    invoiceId: INVOICE_ID,
    operationId,
    reason: '  Regularización de validación de prueba FA 163496  ',
  })
  assert.equal(reopened.ok, true)
  assert.equal(reopened.code, 'VALIDATION_REOPENED')
  assert.equal(reopened.idempotentReplay, false)
  assert.equal(reopened.operationId, operationId)
  assert.equal(reopened.reopening.previous_validation_status, 'VALIDATED')
  assert.equal(reopened.balance.validation_status, 'PENDING')
  assert.equal(reopened.balance.prior_payment_status, 'UNREVIEWED')
  assert.equal(reopened.balance.current_balance, null)
  assert.equal(reopened.balance.total_paid_amount, null)
  assert.equal(reopened.balance.payment_count, 0)
  assert.equal(reopened.balance.reversed_payment_count, 1)
  assert.equal(reopened.balance.reversed_amount, 373184)
  assert.deepEqual(calls[0], {
    fn: 'cxp_reopen_invoice_validation',
    args: {
      p_invoice_id: INVOICE_ID,
      p_operation_id: operationId,
      p_reason: 'Regularización de validación de prueba FA 163496',
    },
  })

  // 2) Bloqueo cuando existen pagos activos vigentes (HAS_ACTIVE_PAYMENTS)
  const dbActivePayments = {
    async rpc() {
      return {
        data: null,
        error: {
          code: 'P0001',
          message:
            'No se puede reabrir la validación mientras existan pagos activos vigentes (1). Anule primero los pagos activos.',
        },
      }
    },
  }
  const blockedActive = await executeReopenInvoiceValidation(dbActivePayments, {
    invoiceId: INVOICE_ID,
    operationId: randomUUID(),
    reason: 'Intento con pago activo',
  })
  assert.equal(blockedActive.ok, false)
  assert.equal(blockedActive.code, 'HAS_ACTIVE_PAYMENTS')
  assert.equal(blockedActive.uncertainOutcome, false)

  // 3) Bloqueo de autorización (42501 -> ACCESS_DENIED) y motivo obligatorio (< 3 caracteres)
  const dbDenied = {
    async rpc() {
      return {
        data: null,
        error: { code: '42501', message: 'Acceso a Cuentas por Pagar denegado' },
      }
    },
  }
  const denied = await executeReopenInvoiceValidation(dbDenied, {
    invoiceId: INVOICE_ID,
    operationId: randomUUID(),
    reason: 'Intento sin permisos',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'ACCESS_DENIED')

  let rpcCalledOnShortReason = false
  const dbNeverCalled = {
    async rpc() {
      rpcCalledOnShortReason = true
      return { data: null, error: null }
    },
  }
  const shortReason = await executeReopenInvoiceValidation(dbNeverCalled, {
    invoiceId: INVOICE_ID,
    operationId: randomUUID(),
    reason: 'ok',
  })
  assert.equal(shortReason.ok, false)
  assert.equal(shortReason.code, 'VALIDATION_ERROR')
  assert.equal(rpcCalledOnShortReason, false)
})
