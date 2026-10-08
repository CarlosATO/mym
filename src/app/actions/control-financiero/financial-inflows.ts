'use server'
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'

const PATH = '/dashboard/analisis-comercial/control-financiero/movimientos'
const VIEW_PERMISSION = 'analisis_comercial.control_financiero.view'
const MANAGE_PERMISSION = 'analisis_comercial.control_financiero.manage_inflows'
type Db = any
const db = () => createAdminClient().schema('comercial') as Db

export type FinancialInflowType = 'OWNER_CONTRIBUTION' | 'OTHER_INCOME'
export type FinancialInflowCategory = {
  id: string
  code: string
  name: string
}
export type FinancialInflow = {
  id: string
  company_id: string
  entry_type: FinancialInflowType
  status: 'DRAFT' | 'POSTED' | 'VOIDED'
  period_year: number
  period_month: number
  amount: number | string
  category_id: string | null
  description: string
  counterparty_name: string | null
  document_date: string | null
  document_number: string | null
  notes: string | null
  created_at: string
  posted_at: string | null
  void_reason: string | null
  category?: FinancialInflowCategory | null
}

async function requirePermission(supabase: any, permission: string) {
  const { data: allowed, error } = await supabase.rpc('has_permission', { p_permission_code: permission })
  if (!error && allowed === true) return
  const { data: admin, error: adminError } = await supabase.rpc('has_permission', { p_permission_code: 'system.admin' })
  if (adminError || admin !== true) throw new Error('No tienes permiso para gestionar entradas financieras.')
}

async function context(write = false) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  await requirePermission(supabase, VIEW_PERMISSION)
  if (write) await requirePermission(supabase, MANAGE_PERMISSION)
  return { companyId, user }
}

export async function getFinancialInflowCategories() {
  const { companyId } = await context()
  const { data, error } = await db()
    .from('financial_categories')
    .select('id,code,name')
    .eq('company_id', companyId)
    .eq('code', 'INCOME_OTHER_CASH')
    .eq('is_active', true)
  if (error) throw new Error(error.message)
  return (data ?? []) as FinancialInflowCategory[]
}

export async function listFinancialInflows(filters: { year?: number; month?: number }) {
  const { companyId } = await context()
  let query = db()
    .from('financial_inflow_entries')
    .select('*')
    .eq('company_id', companyId)
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .order('created_at', { ascending: false })
  if (filters.year) query = query.eq('period_year', filters.year)
  if (filters.month) query = query.eq('period_month', filters.month)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as FinancialInflow[]
  const categoryIds = [...new Set(rows.map(row => row.category_id).filter(Boolean))]
  const categories = categoryIds.length
    ? await db().from('financial_categories').select('id,code,name').eq('company_id', companyId).in('id', categoryIds)
    : { data: [], error: null }
  if (categories.error) throw new Error(categories.error.message)
  const categoryById = new Map((categories.data ?? []).map((category: FinancialInflowCategory) => [category.id, category]))
  return rows.map(row => ({ ...row, category: row.category_id ? categoryById.get(row.category_id) ?? null : null })) as FinancialInflow[]
}

type InflowInput = {
  entryType: FinancialInflowType
  periodYear: number
  periodMonth: number
  amount: number
  categoryId?: string
  description: string
  counterpartyName?: string
  documentDate?: string
  documentNumber?: string
  notes?: string
  idempotencyKey: string
}

export async function createFinancialInflowDraft(input: InflowInput) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('create_financial_inflow_draft', {
    p_company_id: companyId,
    p_entry_type: input.entryType,
    p_period_year: input.periodYear,
    p_period_month: input.periodMonth,
    p_amount: input.amount,
    p_category_id: input.entryType === 'OTHER_INCOME' ? input.categoryId ?? null : null,
    p_description: input.description,
    p_counterparty_name: input.counterpartyName ?? null,
    p_document_date: input.documentDate || null,
    p_document_number: input.documentNumber ?? null,
    p_notes: input.notes ?? null,
    p_metadata: {},
    p_idempotency_key: input.idempotencyKey,
    p_created_by: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, id: data as string }
}

export async function postFinancialInflow(id: string) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('post_financial_inflow', {
    p_company_id: companyId,
    p_entry_id: id,
    p_actor: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, inflow: data }
}

export async function createAndPostFinancialInflow(input: InflowInput) {
  const draft = await createFinancialInflowDraft(input)
  if (!draft.ok) return draft
  return postFinancialInflow(draft.id)
}

export async function voidFinancialInflow(id: string, reason: string) {
  const { companyId, user } = await context(true)
  const { data, error } = await db().rpc('void_financial_inflow', {
    p_company_id: companyId,
    p_entry_id: id,
    p_reason: reason,
    p_actor: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(PATH)
  return { ok: true as const, inflow: data }
}
