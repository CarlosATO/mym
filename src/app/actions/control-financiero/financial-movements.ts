'use server'
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

const PATH = '/dashboard/analisis-comercial/control-financiero/movimientos'
const CASH_PERMISSION = 'analisis_comercial.control_financiero.manage_cash'
const LOAN_PERMISSION = 'analisis_comercial.control_financiero.manage_loans'
const VIEW_PERMISSION = 'analisis_comercial.control_financiero.view'
type Db = any
const db = () => createAdminClient().schema('comercial') as Db

export type CashAccount = { id: string; name: string; currency: string; status: string }
export type CashMovement = {
  id: string; cash_account_id: string; movement_date: string; movement_type: string; amount: number | string
  description: string; counterparty_name: string | null; category_id: string | null; expense_entry_id: string | null
  source_reference: string | null; status: string; created_at: string; bank_movement_id: string | null; void_reason: string | null
}
export type Loan = {
  id: string; lender_name: string; loan_name: string; original_principal: number | string; currency: string
  disbursement_date: string; status: string; contract_reference: string | null; notes: string | null
  payments: LoanPayment[]; principal_paid: number; interest_paid: number; balance_principal: number
}
export type LoanPayment = { id: string; loan_id: string; payment_date: string; total_amount: number | string; principal_amount: number | string; interest_amount: number | string; fee_amount: number | string; bank_movement_id: string | null; status: string; notes: string | null; void_reason: string | null }

async function requirePermission(supabase: any, permission: string) {
  const { data: allowed, error } = await supabase.rpc('has_permission', { p_permission_code: permission })
  if (!error && allowed === true) return
  const { data: admin, error: adminError } = await supabase.rpc('has_permission', { p_permission_code: 'system.admin' })
  if (adminError || admin !== true) throw new Error('No tienes permiso para consultar este módulo financiero.')
}

async function context(permission?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  await requirePermission(supabase, VIEW_PERMISSION)
  if (permission) {
    await requirePermission(supabase, permission)
  }
  return { companyId, user }
}

export async function getFinancialMovementsDashboard(year: number, month: number) {
  const { companyId } = await context()
  const [accountsResult, movementsResult, loansResult, paymentsResult] = await Promise.all([
    db().from('financial_cash_accounts').select('id,name,currency,status').eq('company_id', companyId).order('name'),
    db().from('financial_cash_movements').select('*').eq('company_id', companyId).eq('status', 'POSTED').order('movement_date', { ascending: false }).order('created_at', { ascending: false }).limit(200),
    db().from('financial_loans').select('*').eq('company_id', companyId).order('created_at', { ascending: false }),
    db().from('financial_loan_payments').select('*').eq('company_id', companyId).eq('status', 'POSTED').order('payment_date', { ascending: false }),
  ])
  for (const result of [accountsResult, movementsResult, loansResult, paymentsResult]) if (result.error) throw new Error(result.error.message)
  const accounts = (accountsResult.data ?? []) as CashAccount[]
  const movements = (movementsResult.data ?? []) as CashMovement[]
  const payments = (paymentsResult.data ?? []) as LoanPayment[]
  const loans = (loansResult.data ?? []).map((loan: Loan) => {
    const loanPayments = payments.filter((payment: LoanPayment) => payment.loan_id === loan.id)
    const principalPaid = loanPayments.reduce((sum: number, payment: LoanPayment) => sum + Number(payment.principal_amount), 0)
    const interestPaid = loanPayments.reduce((sum: number, payment: LoanPayment) => sum + Number(payment.interest_amount) + Number(payment.fee_amount), 0)
    return { ...loan, payments: loanPayments, principal_paid: principalPaid, interest_paid: interestPaid, balance_principal: Math.max(0, Number(loan.original_principal) - principalPaid) } as Loan
  })
  const cashBalances = Object.fromEntries(accounts.map(account => [account.id, movements.filter(movement => movement.cash_account_id === account.id).reduce((sum, movement) => sum + (['FUNDING', 'ADJUSTMENT_IN'].includes(movement.movement_type) ? Number(movement.amount) : -Number(movement.amount)), 0)]))
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`
  const monthMovements = movements.filter(movement => movement.movement_date.startsWith(monthPrefix))
  const cashIncoming = monthMovements.filter(movement => ['FUNDING', 'ADJUSTMENT_IN'].includes(movement.movement_type)).reduce((sum, movement) => sum + Number(movement.amount), 0)
  const cashOutgoing = monthMovements.filter(movement => ['EXPENSE', 'ADJUSTMENT_OUT'].includes(movement.movement_type)).reduce((sum, movement) => sum + Number(movement.amount), 0)
  const monthLoans = loans.flatMap((loan: Loan) => loan.payments).filter((payment: LoanPayment) => payment.payment_date.startsWith(monthPrefix))
  return { accounts, movements, loans, cashBalances, monthCashIncoming: cashIncoming, monthCashOutgoing: cashOutgoing, monthFinancialExpenses: monthLoans.reduce((sum: number, payment: LoanPayment) => sum + Number(payment.interest_amount) + Number(payment.fee_amount), 0), financialDebt: loans.filter((loan: Loan) => loan.status !== 'VOIDED').reduce((sum: number, loan: Loan) => sum + loan.balance_principal, 0) }
}

export async function createPettyCashFunding(input: { cashAccountId: string; movementDate: string; amount: number; description: string; sourceReference?: string; notes?: string; idempotencyKey: string; bankMovementId?: string }) {
  const { companyId, user } = await context(CASH_PERMISSION)
  const { data, error } = await db().rpc('create_financial_cash_funding', { p_company_id: companyId, p_cash_account_id: input.cashAccountId, p_movement_date: input.movementDate, p_amount: input.amount, p_description: input.description, p_source_reference: input.sourceReference ?? null, p_notes: input.notes ?? null, p_metadata: {}, p_idempotency_key: input.idempotencyKey, p_actor: user.id, p_bank_movement_id: input.bankMovementId ?? null })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function createPettyCashExpense(input: { cashAccountId: string; movementDate: string; amount: number; categoryId: string; counterpartyName?: string; description: string; documentNumber?: string; notes?: string; idempotencyKey: string }) {
  const { companyId, user } = await context(CASH_PERMISSION)
  const { data, error } = await db().rpc('create_financial_cash_expense', { p_company_id: companyId, p_cash_account_id: input.cashAccountId, p_movement_date: input.movementDate, p_amount: input.amount, p_category_id: input.categoryId, p_counterparty_name: input.counterpartyName ?? null, p_description: input.description, p_document_number: input.documentNumber ?? null, p_notes: input.notes ?? null, p_metadata: {}, p_idempotency_key: input.idempotencyKey, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function createFinancialLoan(input: { lenderName: string; loanName: string; originalPrincipal: number; disbursementDate: string; contractReference?: string; notes?: string; idempotencyKey: string }) {
  const { companyId, user } = await context(LOAN_PERMISSION)
  const { data, error } = await db().rpc('create_financial_loan', { p_company_id: companyId, p_lender_name: input.lenderName, p_loan_name: input.loanName, p_original_principal: input.originalPrincipal, p_disbursement_date: input.disbursementDate, p_contract_reference: input.contractReference ?? null, p_notes: input.notes ?? null, p_metadata: {}, p_idempotency_key: input.idempotencyKey, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function createFinancialLoanPayment(input: { loanId: string; paymentDate: string; totalAmount: number; principalAmount: number; interestAmount: number; feeAmount: number; notes?: string; idempotencyKey: string; bankMovementId?: string }) {
  const { companyId, user } = await context(LOAN_PERMISSION)
  const { data, error } = await db().rpc('create_financial_loan_payment', { p_company_id: companyId, p_loan_id: input.loanId, p_payment_date: input.paymentDate, p_total_amount: input.totalAmount, p_principal_amount: input.principalAmount, p_interest_amount: input.interestAmount, p_fee_amount: input.feeAmount, p_notes: input.notes ?? null, p_metadata: {}, p_idempotency_key: input.idempotencyKey, p_actor: user.id, p_bank_movement_id: input.bankMovementId ?? null })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function voidPettyCashExpense(movementId: string, reason: string) {
  const { companyId, user } = await context(CASH_PERMISSION)
  const { data, error } = await db().rpc('void_financial_cash_movement', { p_company_id: companyId, p_movement_id: movementId, p_reason: reason, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function voidFinancialLoanPayment(paymentId: string, reason: string) {
  const { companyId, user } = await context(LOAN_PERMISSION)
  const { data, error } = await db().rpc('void_financial_loan_payment', { p_company_id: companyId, p_payment_id: paymentId, p_reason: reason, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function voidFinancialLoan(loanId: string, reason: string) {
  const { companyId, user } = await context(LOAN_PERMISSION)
  const { data, error } = await db().rpc('void_financial_loan', { p_company_id: companyId, p_loan_id: loanId, p_reason: reason, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}
