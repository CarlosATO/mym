'use server'

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { FINANCIAL_DAILY_REVIEW_CUTOFF } from '@/lib/control-financiero/config'
import type { StatementDrilldownKey } from '@/lib/control-financiero/statement'

type Db = any
const db = () => createAdminClient().schema('comercial') as Db

const EXPENSE_CODES = [
  'EXPENSE_SOFTWARE_SUBSCRIPTIONS',
  'EXPENSE_OFFICE_CONSUMPTION',
  'EXPENSE_VEHICLE_OPERATING',
  'EXPENSE_NOTARY',
  'EXPENSE_BANK_FEES',
  'EXPENSE_FINANCIAL_INTEREST',
  'EXPENSE_INSURANCE',
  'EXPENSE_TELECOM',
  'EXPENSE_EXTERNAL_SERVICES',
] as const

const OPERATING_CODES = new Set(EXPENSE_CODES.filter(code => code !== 'EXPENSE_FINANCIAL_INTEREST'))
const PERSONNEL_CODES = new Set(['EXPENSE_PERSONNEL_OFF_BOOK', 'EXPENSE_SALARIES_OTHER'])

const EXPENSE_KEY_CODES: Partial<Record<StatementDrilldownKey, string>> = {
  EXPENSE_SOFTWARE_SUBSCRIPTIONS: 'EXPENSE_SOFTWARE_SUBSCRIPTIONS',
  EXPENSE_OFFICE_CONSUMPTION: 'EXPENSE_OFFICE_CONSUMPTION',
  EXPENSE_VEHICLE_OPERATING: 'EXPENSE_VEHICLE_OPERATING',
  EXPENSE_NOTARY: 'EXPENSE_NOTARY',
  EXPENSE_BANK_FEES: 'EXPENSE_BANK_FEES',
  EXPENSE_INSURANCE: 'EXPENSE_INSURANCE',
  EXPENSE_TELECOM: 'EXPENSE_TELECOM',
  EXPENSE_EXTERNAL_SERVICES: 'EXPENSE_EXTERNAL_SERVICES',
  EXPENSE_FINANCIAL_INTEREST: 'EXPENSE_FINANCIAL_INTEREST',
}

export type StatementDrilldownItem = {
  id: string
  date: string
  amount: string
  description: string
  category: string | null
  counterparty: string | null
  classificationSource: string | null
  reviewStatus: string | null
  note: string | null
  source: 'BANK' | 'PAYROLL'
  workerRut: string | null
  workerName: string | null
  earnings: string | null
  employerContributions: string | null
  beneficiary: string | null
  paymentConcept: string | null
  payrollStatus: string | null
  importFilename: string | null
}

export type StatementDrilldownResponse = {
  ok: true
  key: StatementDrilldownKey
  scope: 'MONTH' | 'YTD'
  coveredMonths: number[]
  total: string
  expectedTotal: string
  reconciled: true
  items: StatementDrilldownItem[]
} | {
  ok: false
  message: string
}

function dateFor(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function money(value: unknown) {
  return Number(value ?? 0).toFixed(0)
}

function sum(items: StatementDrilldownItem[]) {
  return items.reduce((total, item) => total + Number(item.amount), 0).toFixed(0)
}

function activeLeafCodes(categories: Array<{ id: string; code: string; parent_id: string | null; is_active: boolean }>) {
  const activeParents = new Set(categories.filter(category => category.is_active).map(category => category.parent_id).filter(Boolean))
  return new Map(
    categories
      .filter(category => category.is_active && category.parent_id && !activeParents.has(category.id) && EXPENSE_CODES.includes(category.code as typeof EXPENSE_CODES[number]))
      .map(category => [category.code, category.id]),
  )
}

async function authenticatedCompany() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  return companyId
}

function bankItem(row: any, categoryName: string | null, personnel: any | null): StatementDrilldownItem {
  return {
    id: row.id,
    date: row.transaction_date,
    amount: money(row.debit_amount),
    description: row.operation_description,
    category: categoryName,
    counterparty: row.counterparty ?? null,
    classificationSource: row.classification_source ?? null,
    reviewStatus: row.review_status ?? null,
    note: row.classification_note ?? null,
    source: 'BANK',
    workerRut: null,
    workerName: null,
    earnings: null,
    employerContributions: null,
    beneficiary: personnel?.beneficiary_name_snapshot ?? null,
    paymentConcept: personnel?.payment_concept ?? null,
    payrollStatus: personnel?.payroll_status ?? null,
    importFilename: null,
  }
}

function payrollItem(row: any, importRow: any, amount: number): StatementDrilldownItem {
  return {
    id: row.id,
    date: dateFor(importRow.period_year, importRow.period_month),
    amount: String(amount),
    description: `RUT ${row.worker_rut_original}`,
    category: null,
    counterparty: null,
    classificationSource: null,
    reviewStatus: null,
    note: null,
    source: 'PAYROLL',
    workerRut: row.worker_rut_original ?? null,
    workerName: row.worker_name_snapshot ?? null,
    earnings: money(row.total_earnings),
    employerContributions: money(row.total_employer_contributions),
    beneficiary: null,
    paymentConcept: null,
    payrollStatus: null,
    importFilename: importRow.source_filename ?? null,
  }
}

export async function loadStatementDrilldown(input: {
  year: number
  month: number | null
  scope: 'MONTH' | 'YTD'
  key: StatementDrilldownKey
  expectedTotal: string
  throughMonth: number
}): Promise<StatementDrilldownResponse> {
  try {
    const companyId = await authenticatedCompany()
    if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) return { ok: false, message: 'El año solicitado no es válido.' }
    if (input.scope === 'MONTH' && (!input.month || input.month < 1 || input.month > 12)) return { ok: false, message: 'El mes solicitado no es válido.' }

    const isExpense = input.key.startsWith('EXPENSE_') || input.key === 'OPERATING_GROUP' || input.key === 'NON_OPERATING_GROUP'
    const isPersonnel = input.key.startsWith('PERSONNEL_')
    if (!isExpense && !isPersonnel) return { ok: false, message: 'La fila seleccionada no tiene detalle financiero.' }

    const categoriesResult = await db()
      .from('financial_categories')
      .select('id,code,name,parent_id,is_active')
      .eq('company_id', companyId)
      .eq('is_active', true)
    if (categoriesResult.error) throw new Error(categoriesResult.error.message)
    const categories = categoriesResult.data ?? []
    const categoryById = new Map<string, any>(categories.map((category: any) => [category.id, category] as [string, any]))
    const expenseIds = activeLeafCodes(categories)
    const requestedCodes = isExpense
      ? input.key === 'OPERATING_GROUP'
        ? [...OPERATING_CODES]
        : input.key === 'NON_OPERATING_GROUP'
          ? ['EXPENSE_FINANCIAL_INTEREST']
          : [EXPENSE_KEY_CODES[input.key]].filter(Boolean) as string[]
      : input.key === 'PERSONNEL_OFF_BOOK'
        ? ['EXPENSE_PERSONNEL_OFF_BOOK']
        : input.key === 'PERSONNEL_OTHER'
          ? ['EXPENSE_SALARIES_OTHER']
          : [...PERSONNEL_CODES]
    const requestedCategoryIds = requestedCodes.map(code => expenseIds.get(code) ?? (categories as any[]).find((category: any) => category.code === code)?.id).filter(Boolean)

    let payrollImports: any[] | null = null
    if (input.key === 'PERSONNEL_FORMAL' || input.key === 'PERSONNEL_EMPLOYER' || input.key === 'PERSONNEL_GROUP') {
      const importsResult = await db()
        .from('financial_payroll_imports')
        .select('id,period_year,period_month,source_filename')
        .eq('company_id', companyId)
        .eq('period_year', input.year)
        .eq('status', 'IMPORTED')
        .order('period_month')
      if (importsResult.error) throw new Error(importsResult.error.message)
      payrollImports = (importsResult.data ?? []).filter((row: any) => input.scope === 'MONTH' ? row.period_month === input.month : row.period_month <= input.throughMonth)
    }

    const periodResult = await db()
      .from('financial_statement_periods')
      .select('month')
      .eq('company_id', companyId)
      .eq('year', input.year)
    if (periodResult.error) throw new Error(periodResult.error.message)
    const statementMonths: number[] = [...new Set<number>((periodResult.data ?? []).map((period: any) => Number(period.month)))].sort((a, b) => a - b)
    const monthSet = input.scope === 'MONTH'
      ? new Set([input.month as number])
      : new Set(
        isExpense
          ? statementMonths
          : input.key === 'PERSONNEL_GROUP'
            ? (payrollImports ?? []).map((row: any) => Number(row.period_month))
            : Array.from({ length: Math.min(input.throughMonth, 12) }, (_, index) => index + 1),
      )
    if (isExpense && monthSet.size === 0) return { ok: false, message: 'No hay cobertura bancaria para el período solicitado.' }

    const items: StatementDrilldownItem[] = []

    if (isExpense || input.key === 'PERSONNEL_OFF_BOOK' || input.key === 'PERSONNEL_OTHER') {
      const fromMonth = input.scope === 'MONTH' ? input.month as number : 1
      const toMonth = input.scope === 'MONTH' ? (input.month as number) + 1 : isExpense ? 13 : Math.min(input.throughMonth + 1, 13)
      const movementResult = requestedCategoryIds.length === 0
        ? { data: [], error: null }
        : await db()
          .from('financial_bank_movements')
          .select('id,transaction_date,operation_description,debit_amount,category_id,counterparty,classification_source,classification_note,review_status')
          .eq('company_id', companyId)
          .eq('direction', 'DEBE')
          .in('category_id', requestedCategoryIds)
          .gte('transaction_date', dateFor(input.year, fromMonth))
          .lt('transaction_date', toMonth === 13 ? `${input.year + 1}-01-01` : dateFor(input.year, toMonth))
          .order('transaction_date', { ascending: true })
      if (movementResult.error) throw new Error(movementResult.error.message)
      const movementIds = (movementResult.data ?? []).map((row: any) => row.id)
      const personnelResult = movementIds.length === 0
        ? { data: [], error: null }
        : await db().from('financial_bank_movement_personnel_details').select('movement_id,beneficiary_name_snapshot,payment_concept,payroll_status').eq('company_id', companyId).in('movement_id', movementIds)
      if (personnelResult.error) throw new Error(personnelResult.error.message)
      const personnelByMovement = new Map((personnelResult.data ?? []).map((row: any) => [row.movement_id, row]))
      for (const row of movementResult.data ?? []) {
        const category = categoryById.get(row.category_id)
        const movementMonth = Number(row.transaction_date.slice(5, 7))
        if (isExpense && !monthSet.has(movementMonth)) continue
        if (isExpense && row.transaction_date >= FINANCIAL_DAILY_REVIEW_CUTOFF && row.review_status !== 'REVIEWED') continue
        if (isPersonnel && !monthSet.has(movementMonth)) continue
        items.push(bankItem(row, category?.name ?? null, personnelByMovement.get(row.id) ?? null))
      }
    }

    if (input.key === 'PERSONNEL_FORMAL' || input.key === 'PERSONNEL_EMPLOYER' || input.key === 'PERSONNEL_GROUP') {
      const imports = payrollImports ?? []
      const importIds = imports.map((row: any) => row.id)
      const entriesResult = importIds.length === 0
        ? { data: [], error: null }
        : await db().from('financial_payroll_entries').select('id,import_id,worker_rut_original,worker_name_snapshot,total_earnings,total_employer_contributions').eq('company_id', companyId).in('import_id', importIds).order('source_row_number')
      if (entriesResult.error) throw new Error(entriesResult.error.message)
      const importById = new Map(imports.map((row: any) => [row.id, row]))
      for (const row of entriesResult.data ?? []) {
        const importRow = importById.get(row.import_id)
        if (!importRow) continue
        const amount = input.key === 'PERSONNEL_FORMAL'
          ? Number(row.total_earnings ?? 0)
          : input.key === 'PERSONNEL_EMPLOYER'
            ? Number(row.total_employer_contributions ?? 0)
            : Number(row.total_earnings ?? 0) + Number(row.total_employer_contributions ?? 0)
        items.push(payrollItem(row, importRow, amount))
      }
    }

    items.sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
    const total = sum(items)
    if (Number(total) !== Number(input.expectedTotal)) return { ok: false, message: `El detalle no reconcilia con la celda origen. Celda: ${input.expectedTotal}; detalle: ${total}.` }
    return { ok: true, key: input.key, scope: input.scope, coveredMonths: [...monthSet].sort((a, b) => a - b), total, expectedTotal: input.expectedTotal, reconciled: true, items }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No se pudo cargar el detalle del Estado de Resultados.' }
  }
}
