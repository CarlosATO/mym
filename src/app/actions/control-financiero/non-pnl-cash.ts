'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { classifyNonPnlMovement, consolidatedNonPnlImpact, type NonPnlMovementSubtype } from '@/lib/control-financiero/non-pnl-classification'

type Db = any
const db = () => createAdminClient().schema('comercial') as Db

const NON_PNL_CODES = [
  'EXPENSE_OWNER_WITHDRAWAL',
  'EXPENSE_FINANCING',
  'INCOME_FINANCING',
  'INCOME_CONTRIBUTIONS',
  'EXPENSE_ASSETS',
  'INCOME_INTERNAL_TRANSFER',
  'EXPENSE_INTERNAL_TRANSFER',
  'INCOME_INTERCOMPANY',
  'EXPENSE_INTERCOMPANY',
] as const

type NonPnlCode = typeof NON_PNL_CODES[number]

const ROWS = [
  { code: 'EXPENSE_OWNER_WITHDRAWAL', label: 'Retiro de socio / propietario', informational: false },
  { code: 'LOAN_RECEIPT', label: 'Préstamos recibidos', informational: false },
  { code: 'LOAN_PAYMENT', label: 'Pago de préstamos bancarios', informational: false },
  { code: 'CREDIT_LINE_DRAW', label: 'Uso de línea de crédito', informational: false },
  { code: 'CREDIT_LINE_NET', label: 'Saldo neto línea de crédito', informational: true },
  { code: 'CREDIT_LINE_PAYMENT', label: 'Pago / restitución línea de crédito', informational: false },
  { code: 'INCOME_CONTRIBUTIONS', label: 'Aportes de socios', informational: false },
  { code: 'EXPENSE_ASSETS', label: 'Inversiones / activos', informational: false },
  { code: 'INTERCOMPANY', label: 'Intercompany / transferencias internas', informational: true },
] as const

export type NonPnlCashMovement = {
  id: string
  date: string
  bankName: string
  maskedAccountNumber: string
  description: string
  amount: number
  direction: 'HABER' | 'DEBE' | string | null
  categoryCode: NonPnlCode
  categoryName: string
  classificationSource: string | null
  reviewStatus: string | null
  subtype: NonPnlMovementSubtype
}

export type NonPnlCashRow = {
  code: string
  label: string
  informational: boolean
  monthly: number[]
  ytd: number
  movementCount: number
}

export type NonPnlCashData = {
  rows: NonPnlCashRow[]
  movements: NonPnlCashMovement[]
  ownerWithdrawalsYtd: number
  loanPaymentsYtd: number
  creditLinePaymentsYtd: number
  loanReceiptsYtd: number
  creditLineDrawsYtd: number
}

async function companyContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  return companyId
}

export async function getNonPnlCashData(year: number): Promise<NonPnlCashData> {
  const companyId = await companyContext()
  const start = `${year}-01-01`
  const end = `${year + 1}-01-01`
  const [categoriesResult, accountsResult] = await Promise.all([
    db().from('financial_categories').select('id,code,name').eq('company_id', companyId).eq('is_active', true).in('code', NON_PNL_CODES),
    db().from('financial_bank_accounts').select('id,bank_name,account_number').eq('company_id', companyId).eq('is_active', true),
  ])
  if (categoriesResult.error) throw new Error(categoriesResult.error.message)
  if (accountsResult.error) throw new Error(accountsResult.error.message)
  const categoryById = new Map<string, any>((categoriesResult.data ?? []).map((category: any) => [category.id, category]))
  const categoryIds = [...categoryById.keys()]
  if (!categoryIds.length) return { rows: ROWS.map(row => ({ ...row, monthly: Array(12).fill(0), ytd: 0, movementCount: 0 })), movements: [], ownerWithdrawalsYtd: 0, loanPaymentsYtd: 0, creditLinePaymentsYtd: 0, loanReceiptsYtd: 0, creditLineDrawsYtd: 0 }

  const movementsResult = await db()
    .from('financial_bank_movements')
    .select('id,bank_account_id,transaction_date,operation_description,credit_amount,debit_amount,direction,category_id,classification_source,review_status')
    .eq('company_id', companyId)
    .gte('transaction_date', start)
    .lt('transaction_date', end)
    .in('category_id', categoryIds)
    .order('transaction_date')
  if (movementsResult.error) throw new Error(movementsResult.error.message)

  const accountById = new Map<string, any>((accountsResult.data ?? []).map((account: any) => [account.id, account]))
  const movements: NonPnlCashMovement[] = (movementsResult.data ?? []).map((movement: any) => {
    const category = categoryById.get(movement.category_id)
    const account = accountById.get(movement.bank_account_id)
    const debit = Number(movement.debit_amount ?? 0)
    const credit = Number(movement.credit_amount ?? 0)
    return {
      id: movement.id,
      date: movement.transaction_date,
      bankName: account?.bank_name ?? 'Banco desconocido',
      maskedAccountNumber: account?.account_number ? `•••• ${account.account_number.slice(-4)}` : '—',
      description: movement.operation_description,
      amount: movement.direction === 'HABER' ? credit : debit,
      direction: movement.direction,
      categoryCode: category.code,
      categoryName: category.name,
      classificationSource: movement.classification_source ?? null,
      reviewStatus: movement.review_status ?? null,
       subtype: (() => {
         const subtype = classifyNonPnlMovement(movement.operation_description)
         if (category.code === 'EXPENSE_FINANCING' && (subtype === 'LOAN_PAYMENT' || subtype === 'CREDIT_LINE_PAYMENT')) return subtype
         if (category.code === 'INCOME_FINANCING' && (subtype === 'LOAN_RECEIPT' || subtype === 'CREDIT_LINE_DRAW')) return subtype
         return null
       })(),
    } as NonPnlCashMovement
  })

  const rowForCode = (code: string) => movements.filter((movement: NonPnlCashMovement) => code === 'INTERCOMPANY'
    ? movement.categoryCode === 'INCOME_INTERNAL_TRANSFER' || movement.categoryCode === 'EXPENSE_INTERNAL_TRANSFER' || movement.categoryCode === 'INCOME_INTERCOMPANY' || movement.categoryCode === 'EXPENSE_INTERCOMPANY'
    : code === 'CREDIT_LINE_NET'
      ? movement.subtype === 'CREDIT_LINE_DRAW' || movement.subtype === 'CREDIT_LINE_PAYMENT'
      : movement.subtype === code || movement.categoryCode === code)
  const rows = ROWS.map(row => {
    const rowMovements = rowForCode(row.code)
    const monthly = Array.from({ length: 12 }, (_, index) => rowMovements.filter((movement: NonPnlCashMovement) => Number(movement.date.slice(5, 7)) === index + 1).reduce((total: number, movement: NonPnlCashMovement) => total + consolidatedNonPnlImpact(movement), 0))
    return { ...row, monthly, ytd: monthly.reduce((total, value) => total + value, 0), movementCount: rowMovements.length }
  })
  return {
    rows,
    movements,
    ownerWithdrawalsYtd: Math.abs(rows.find(row => row.code === 'EXPENSE_OWNER_WITHDRAWAL')?.ytd ?? 0),
    loanPaymentsYtd: movements.filter(movement => movement.subtype === 'LOAN_PAYMENT').reduce((total, movement) => total + movement.amount, 0),
    creditLinePaymentsYtd: movements.filter(movement => movement.subtype === 'CREDIT_LINE_PAYMENT').reduce((total, movement) => total + movement.amount, 0),
    loanReceiptsYtd: movements.filter(movement => movement.subtype === 'LOAN_RECEIPT').reduce((total, movement) => total + movement.amount, 0),
    creditLineDrawsYtd: movements.filter(movement => movement.subtype === 'CREDIT_LINE_DRAW').reduce((total, movement) => total + movement.amount, 0),
  }
}
