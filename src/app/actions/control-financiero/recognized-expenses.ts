'use server'
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

const PATH = '/dashboard/analisis-comercial/control-financiero/gastos-reconocidos'
const PERMISSION = 'analisis_comercial.control_financiero.manage_expenses'
type Db = any

const db = () => createAdminClient().schema('comercial') as Db

export type ExpenseCategory = { id: string; code: string; name: string; parent_id: string | null; direction: string; is_active: boolean }
export type RecognizedExpense = {
  id: string; company_id: string; period_year: number; period_month: number; category_id: string; recognized_amount: number | string; currency: string; description: string; counterparty_name: string | null; document_date: string | null; document_number: string | null; source_type: string; status: string; source_reference: string | null; notes: string | null; created_by: string; created_at: string; updated_at: string; posted_at: string | null; voided_at: string | null; void_reason: string | null; category?: ExpenseCategory; links?: BankLink[]
}
export type BankLink = { id: string; bank_movement_id: string; allocated_amount: number | string; created_at: string; movement?: BankMovement }
export type BankMovement = { id: string; transaction_date: string; operation_description: string; debit_amount: number | string; direction: string | null; counterparty: string | null; category_id: string | null; category_name?: string | null; affects_pnl_directly?: boolean }

async function context(write = false) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  if (write) {
    const { data, error } = await supabase.rpc('has_permission', { p_permission_code: PERMISSION })
    if (error || data !== true) throw new Error('No tienes permiso para gestionar gastos reconocidos.')
  }
  return { companyId, user }
}

export async function getRecognizedExpenseCategories() {
  const { companyId } = await context()
  const { data, error } = await db().rpc('get_financial_expense_recognition_categories', { p_company_id: companyId })
  if (error) throw new Error(error.message)
  return (data ?? []) as ExpenseCategory[]
}

async function getExpense(companyId: string, id: string) {
  const { data, error } = await db().from('financial_expense_entries').select('*').eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('La partida no pertenece a la empresa activa.')
  const { data: links, error: linkError } = await db().from('financial_expense_bank_links').select('*').eq('company_id', companyId).eq('expense_entry_id', id).order('created_at')
  if (linkError) throw new Error(linkError.message)
  return { ...data, links: links ?? [] } as RecognizedExpense
}

export async function listRecognizedExpenses(filters: { year?: number; month?: number; categoryId?: string; status?: string; sourceType?: string; search?: string; page?: number }) {
  const { companyId } = await context()
  const page = Math.max(1, filters.page ?? 1)
  let query = db().from('financial_expense_entries').select('*', { count: 'exact' }).eq('company_id', companyId).order('period_year', { ascending: false }).order('period_month', { ascending: false }).order('created_at', { ascending: false })
  if (filters.year) query = query.eq('period_year', filters.year)
  if (filters.month) query = query.eq('period_month', filters.month)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.sourceType) query = query.eq('source_type', filters.sourceType)
  if (filters.search?.trim()) query = query.or(`description.ilike.%${filters.search.trim()}%,counterparty_name.ilike.%${filters.search.trim()}%`)
  const { data, error, count } = await query.range((page - 1) * 25, page * 25 - 1)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as RecognizedExpense[]
  const categoryIds = [...new Set(rows.map(row => row.category_id))]
  const { data: categories, error: categoryError } = await db().from('financial_categories').select('id,code,name,parent_id,direction,is_active').eq('company_id', companyId).in('id', categoryIds.length ? categoryIds : ['00000000-0000-0000-0000-000000000000'])
  if (categoryError) throw new Error(categoryError.message)
  const names = new Map((categories ?? []).map((category: ExpenseCategory) => [category.id, category] as [string, ExpenseCategory]))
  return { rows: rows.map(row => ({ ...row, category: names.get(row.category_id) })) as RecognizedExpense[], count: count ?? 0, page }
}

export async function getRecognizedExpenseDetail(id: string) {
  const { companyId } = await context()
  return getExpense(companyId, id)
}

export async function createRecognizedExpense(input: { periodYear: number; periodMonth: number; categoryId: string; recognizedAmount: number; currency?: string; description: string; counterpartyName?: string; documentDate?: string; documentNumber?: string; sourceType?: string; sourceReference?: string; notes?: string; idempotencyKey: string }) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('create_financial_expense_draft', { p_company_id: companyId, p_period_year: input.periodYear, p_period_month: input.periodMonth, p_category_id: input.categoryId, p_recognized_amount: input.recognizedAmount, p_currency: input.currency ?? 'CLP', p_description: input.description, p_counterparty_name: input.counterpartyName ?? null, p_document_date: input.documentDate || null, p_document_number: input.documentNumber ?? null, p_source_type: input.sourceType ?? 'MANUAL', p_source_reference: input.sourceReference ?? null, p_notes: input.notes ?? null, p_metadata: {}, p_idempotency_key: input.idempotencyKey, p_created_by: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function updateRecognizedExpense(id: string, input: Omit<Parameters<typeof createRecognizedExpense>[0], 'idempotencyKey'>) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('update_financial_expense_draft', { p_company_id: companyId, p_expense_entry_id: id, p_period_year: input.periodYear, p_period_month: input.periodMonth, p_category_id: input.categoryId, p_recognized_amount: input.recognizedAmount, p_currency: input.currency ?? 'CLP', p_description: input.description, p_counterparty_name: input.counterpartyName ?? null, p_document_date: input.documentDate || null, p_document_number: input.documentNumber ?? null, p_source_type: input.sourceType ?? 'MANUAL', p_source_reference: input.sourceReference ?? null, p_notes: input.notes ?? null, p_metadata: {} as object, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, expense: data }
}

export async function postRecognizedExpense(id: string) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('post_financial_expense', { p_company_id: companyId, p_expense_entry_id: id, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, expense: data }
}

export async function voidRecognizedExpense(id: string, reason: string) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('void_financial_expense', { p_company_id: companyId, p_expense_entry_id: id, p_reason: reason, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, expense: data }
}

export async function searchRecognizedExpenseBankMovements(search: string, page = 1) {
  const { companyId } = await context()
  let query = db().from('financial_bank_movements').select('id,transaction_date,operation_description,debit_amount,direction,counterparty,category_id').eq('company_id', companyId).eq('direction', 'DEBE').gt('debit_amount', 0).order('transaction_date', { ascending: false })
  if (search.trim()) query = query.or(`operation_description.ilike.%${search.trim()}%,counterparty.ilike.%${search.trim()}%`)
  const { data, error } = await query.range((page - 1) * 20, page * 20 - 1)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as BankMovement[]
  const categoryIds = [...new Set(rows.map(row => row.category_id).filter(Boolean))] as string[]
  const { data: categories } = await db().from('financial_categories').select('id,name,affects_pnl_directly').eq('company_id', companyId).in('id', categoryIds.length ? categoryIds : ['00000000-0000-0000-0000-000000000000'])
  const categoryMap = new Map<string, { id: string; name: string; affects_pnl_directly: boolean }>((categories ?? []).map((category: { id: string; name: string; affects_pnl_directly: boolean }) => [category.id, category]))
  return rows.map(row => ({ ...row, category_name: row.category_id ? categoryMap.get(row.category_id)?.name ?? null : null, affects_pnl_directly: row.category_id ? categoryMap.get(row.category_id)?.affects_pnl_directly ?? false : false }))
}

export async function linkRecognizedExpenseBankMovement(expenseId: string, movementId: string, allocatedAmount: number) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('link_financial_expense_bank_movement', { p_company_id: companyId, p_expense_entry_id: expenseId, p_bank_movement_id: movementId, p_allocated_amount: allocatedAmount, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function unlinkRecognizedExpenseBankMovement(linkId: string) {
  const { companyId, user } = await context(true)
  const { error } = await db().rpc('unlink_financial_expense_bank_movement', { p_company_id: companyId, p_link_id: linkId, p_actor: user.id })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const }
}
