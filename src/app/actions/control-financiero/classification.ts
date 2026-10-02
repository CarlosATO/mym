'use server'
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getActiveCompanyId } from '@/app/actions/companies'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeBankOperation } from '@/lib/control-financiero/classification'

type Db = any
const db = () => createAdminClient().schema('comercial') as Db
const CASH_FLOW_PATH = '/dashboard/analisis-comercial/control-financiero/flujo-caja'

export type FinancialCategory = { id: string; parent_id: string | null; code: string; name: string; direction: 'INCOME' | 'EXPENSE' | 'BOTH'; sort_order: number; is_active: boolean; affects_cash_flow: boolean; affects_pnl_directly: boolean; classification_group: 'OPERATING' | 'NON_OPERATING'; semantic_type: string | null; cash_direction: 'CREDIT' | 'DEBIT' | 'BOTH' | null }
export type PersonnelBeneficiary = { id: string; display_name: string; normalized_name: string; rut: string | null; active: boolean; note: string | null }
export type ClassificationMovement = { id: string; bank_account_id: string; transaction_date: string; operation_description: string; credit_amount: number | string; debit_amount: number | string; balance_after: number | string; source_row_number: number; direction: string | null; normalized_description: string | null; classification_signature: string | null; category_id: string | null; counterparty: string | null; classification_note: string | null; classification_source: string | null; classification_rule_id: string | null; classified_at: string | null; review_status: 'HISTORICAL' | 'PENDING' | 'REVIEWED' | null; reviewed_by: string | null; reviewed_at: string | null; category_name?: string | null }

async function context() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  return { companyId, user, supabase }
}

async function writeContext() {
  const result = await context()
  const { data: allowed, error } = await result.supabase.rpc('has_permission', {
    p_permission_code: 'analisis_comercial.control_financiero.classify',
  })
  if (error || allowed !== true) throw new Error('No tienes permiso para corregir categorías financieras.')
  return result
}

export async function getFinancialClassificationCategories(): Promise<FinancialCategory[]> {
  const { companyId } = await context()
  const { data, error } = await db().from('financial_categories').select('id,parent_id,code,name,direction,sort_order,is_active,affects_cash_flow,affects_pnl_directly,classification_group,semantic_type,cash_direction').eq('company_id', companyId).eq('is_active', true).order('sort_order').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as FinancialCategory[]
}

export async function canClassifyFinancialMovements() {
  const { supabase } = await context()
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission_code: 'analisis_comercial.control_financiero.classify',
  })
  return !error && data === true
}

export async function getFinancialPersonnelBeneficiaries(): Promise<PersonnelBeneficiary[]> {
  const { companyId } = await context()
  const { data, error } = await db().from('financial_personnel_beneficiaries')
    .select('id,display_name,normalized_name,rut,active,note')
    .eq('company_id', companyId).eq('active', true).order('display_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as PersonnelBeneficiary[]
}

export async function createFinancialPersonnelBeneficiary(input: { displayName: string; rut?: string; note?: string }) {
  const { companyId, user } = await context()
  const { data, error } = await db().rpc('create_financial_personnel_beneficiary', {
    p_company_id: companyId, p_display_name: input.displayName, p_rut: input.rut ?? null,
    p_note: input.note ?? null, p_created_by: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  const result = data as { id: string; created: boolean; duplicate: boolean }
  const { data: beneficiary, error: beneficiaryError } = await db().from('financial_personnel_beneficiaries')
    .select('id,display_name,normalized_name,rut,active,note').eq('company_id', companyId).eq('id', result.id).single()
  if (beneficiaryError) return { ok: false as const, message: beneficiaryError.message }
  return { ok: true as const, beneficiary: beneficiary as PersonnelBeneficiary, duplicate: result.duplicate }
}

async function getMovement(companyId: string, movementId: string) {
  const { data, error } = await db().from('financial_bank_movements').select('id,bank_account_id,transaction_date,operation_description,credit_amount,debit_amount,balance_after,source_row_number,direction,normalized_description,classification_signature,category_id,counterparty,classification_note,classification_source,classification_rule_id,classified_at,review_status,reviewed_by,reviewed_at').eq('company_id', companyId).eq('id', movementId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('El movimiento no pertenece a la empresa activa.')
  return data as ClassificationMovement
}

function attachCategoryNames(movements: ClassificationMovement[], categories: FinancialCategory[]) {
  const names = new Map(categories.map(category => [category.id, category.name]))
  return movements.map(movement => ({ ...movement, category_name: movement.category_id ? names.get(movement.category_id) ?? null : null }))
}

export async function getFinancialMovementClassificationContext(movementId: string) {
  const { companyId } = await context()
  const selected = await getMovement(companyId, movementId)
  const query = db().from('financial_bank_movements').select('id,bank_account_id,transaction_date,operation_description,credit_amount,debit_amount,balance_after,source_row_number,direction,normalized_description,classification_signature,category_id,counterparty,classification_note,classification_source,classification_rule_id,classified_at,review_status,reviewed_by,reviewed_at').eq('company_id', companyId).eq('classification_signature', selected.classification_signature)
  const { data, error } = await query.order('transaction_date').order('source_row_number')
  if (error) throw new Error(error.message)
  const categories = await getFinancialClassificationCategories()
  const matches = attachCategoryNames((data ?? []) as ClassificationMovement[], categories)
  const { data: matchingRules, error: rulesError } = await db()
    .from('financial_bank_classification_rules')
    .select('id,name,direction,bank_account_id,match_type,match_value,category_id,mode')
    .eq('company_id', companyId)
    .eq('active', true)
    .eq('bank_account_id', selected.bank_account_id)
    .eq('direction', selected.direction)
    .eq('match_type', 'EXACT')
    .eq('match_value', selected.normalized_description)
  if (rulesError) throw new Error(rulesError.message)
  const categoryNames = new Map(categories.map(category => [category.id, category.name]))
  const rules = (matchingRules ?? []).map((rule: any) => ({ ...rule, category_name: categoryNames.get(rule.category_id) ?? null }))
  const pending = matches.filter(movement => movement.direction === 'DEBE' && movement.review_status === 'PENDING')
  const classified = matches.filter(movement => movement.category_id)
  const categoryCounts = new Map<string, number>()
  classified.forEach(movement => categoryCounts.set(movement.category_id!, (categoryCounts.get(movement.category_id!) ?? 0) + 1))
  const classifiedCategories = [...categoryCounts.entries()].map(([categoryId, count]) => ({ categoryId, name: categories.find(category => category.id === categoryId)?.name ?? 'Categoría desconocida', count }))
  return {
    selected: attachCategoryNames([selected], categories)[0], matches, pendingMovementIds: pending.map(movement => movement.id),
    total: matches.length, pendingCount: pending.length, classifiedCount: classified.length,
    classifiedCategories, uniqueClassifiedCategories: classifiedCategories.length,
    suggestion: classifiedCategories.length === 1 ? classifiedCategories[0] : null,
    hasClassificationConflict: classifiedCategories.length > 1,
    matchingRules: rules,
    ruleSuggestion: rules.length === 1 && rules[0].mode === 'SUGGEST' ? rules[0] : null,
  }
}

export async function classifyFinancialMovement(input: { movementId: string; categoryId: string; counterparty?: string; note?: string; applyToPending?: boolean; pendingMovementIds?: string[] }) {
  const { companyId, user } = await writeContext()
  const selected = await getMovement(companyId, input.movementId)
  const ids = input.applyToPending ? [...new Set(input.pendingMovementIds ?? [])] : [selected.id]
  if (!ids.includes(selected.id) && !input.applyToPending) throw new Error('Movimiento seleccionado inválido.')
  const { data, error } = await db().rpc('classify_financial_bank_movements', {
    p_company_id: companyId, p_movement_ids: ids, p_category_id: input.categoryId, p_counterparty: input.counterparty ?? null,
    p_note: input.note ?? null, p_source: input.applyToPending ? 'BULK_EXACT' : 'MANUAL', p_rule_id: null,
    p_only_pending: Boolean(input.applyToPending), p_classified_by: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(CASH_FLOW_PATH)
  return { ok: true as const, result: data }
}

export async function updateFinancialMovementCategoryAction(input: {
  movementId: string
  categoryId: string
  currentCategoryId: string | null
  reason?: string
}) {
  const { companyId, user } = await writeContext()
  if (!input.movementId || !input.categoryId) {
    return { ok: false as const, message: 'Indica el movimiento y la categoría destino.' }
  }
  try {
    const { data, error } = await db().rpc('update_financial_bank_movement_category_manual', {
      p_company_id: companyId,
      p_movement_id: input.movementId,
      p_category_id: input.categoryId,
      p_current_category_id: input.currentCategoryId,
      p_reason: input.reason?.trim() || null,
      p_actor_user_id: user.id,
    })
    if (error) return { ok: false as const, message: error.message }
    revalidatePath(CASH_FLOW_PATH)
    return { ok: true as const, result: data as {
      updated: boolean
      movement_id: string
      category_id: string | null
      category_name?: string
      classification_source: string | null
      classification_rule_id: string | null
      classified_at: string | null
    } }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo cambiar la categoría.' }
  }
}

export async function confirmFinancialMovementClassification(movementId: string) {
  const { companyId, user } = await writeContext()
  const { data, error } = await db().rpc('confirm_financial_bank_movement_classification', {
    p_company_id: companyId,
    p_movement_id: movementId,
    p_actor_user_id: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(CASH_FLOW_PATH)
  return { ok: true as const, result: data }
}

export async function updateFinancialMovementObservationAction(input: { movementId: string; observation: string }) {
  const { companyId, user } = await writeContext()
  const { data, error } = await db().rpc('update_financial_bank_movement_observation', {
    p_company_id: companyId,
    p_movement_id: input.movementId,
    p_observation: input.observation,
    p_actor_user_id: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(CASH_FLOW_PATH)
  return { ok: true as const, result: data }
}

type RuleMatchType = 'EXACT' | 'CONTAINS' | 'STARTS_WITH'

async function queryRuleMatches(companyId: string, movementId: string, matchType: RuleMatchType, matchValue: string) {
  const selected = await getMovement(companyId, movementId)
  const normalizedValue = normalizeBankOperation(matchValue)
  let query = db().from('financial_bank_movements').select('id,category_id').eq('company_id', companyId).eq('bank_account_id', selected.bank_account_id).eq('direction', selected.direction)
  if (matchType === 'EXACT') query = query.eq('normalized_description', normalizedValue)
  if (matchType === 'CONTAINS') query = query.ilike('normalized_description', `%${normalizedValue}%`)
  if (matchType === 'STARTS_WITH') query = query.ilike('normalized_description', `${normalizedValue}%`)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const matches = (data ?? []) as { id: string; category_id: string | null }[]
  const classified = matches.filter(row => row.category_id)
  const categories = await getFinancialClassificationCategories()
  const categoryCounts = new Map<string, number>()
  classified.forEach(row => categoryCounts.set(row.category_id!, (categoryCounts.get(row.category_id!) ?? 0) + 1))
  return {
    selected, normalizedValue, matches, pendingIds: matches.filter(row => !row.category_id).map(row => row.id),
    existingCount: classified.length, pendingCount: matches.length - classified.length,
    classifications: [...categoryCounts.entries()].map(([categoryId, count]) => ({ categoryId, name: categories.find(category => category.id === categoryId)?.name ?? 'Categoría desconocida', count })),
  }
}

export async function previewFinancialClassificationRule(input: { movementId: string; matchType: RuleMatchType; matchValue?: string }) {
  const { companyId } = await context()
  const selected = await getMovement(companyId, input.movementId)
  const matchValue = input.matchValue?.trim() || selected.normalized_description || normalizeBankOperation(selected.operation_description)
  const result = await queryRuleMatches(companyId, input.movementId, input.matchType, matchValue)
  return { ...result, matchType: input.matchType, matchValue, conflict: result.classifications.length > 1 }
}

export async function createFinancialClassificationRule(input: { movementId: string; name: string; matchType: RuleMatchType; matchValue?: string; categoryId: string; counterparty?: string; applyToPending: boolean }) {
  const { companyId, user } = await writeContext()
  const preview = await previewFinancialClassificationRule({ movementId: input.movementId, matchType: input.matchType, matchValue: input.matchValue })
  const category = await db().from('financial_categories').select('id').eq('company_id', companyId).eq('id', input.categoryId).eq('is_active', true).maybeSingle()
  if (category.error || !category.data) return { ok: false as const, message: 'La categoría no pertenece a la empresa activa.' }
  const { data: duplicateRule, error: duplicateError } = await db()
    .from('financial_bank_classification_rules')
    .select('id')
    .eq('company_id', companyId)
    .eq('active', true)
    .eq('bank_account_id', preview.selected.bank_account_id)
    .eq('direction', preview.selected.direction)
    .eq('match_type', input.matchType)
    .eq('match_value', preview.matchValue)
    .limit(1)
  if (duplicateError) return { ok: false as const, message: duplicateError.message }
  if (duplicateRule?.length) return { ok: false as const, message: 'Ya existe una regla activa para esta coincidencia.' }
  const { data, error } = await db().rpc('create_financial_bank_classification_rule', {
    p_company_id: companyId, p_name: input.name, p_direction: preview.selected.direction, p_bank_account_id: preview.selected.bank_account_id,
    p_match_type: input.matchType, p_match_value: preview.matchValue, p_category_id: input.categoryId, p_counterparty: input.counterparty ?? null,
    p_mode: 'SUGGEST', p_created_by: user.id, p_apply_movement_ids: input.applyToPending ? preview.pendingIds : [],
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath(CASH_FLOW_PATH)
  return { ok: true as const, result: data, preview }
}

export type PendingDebitAuditGroup = {
  groupKey: string
  bankAccountId: string
  operationDescription: string
  counterparty: string
  movementCount: number
  totalDebit: number | string
  firstDate: string
  lastDate: string
  months: number[]
  sampleAmounts: Array<number | string>
}

export async function getPendingDebitAudit(input: {
  year: number
  bankAccountId?: string
  search?: string
  page?: number
  pageSize?: number
}) {
  const { companyId } = await context()
  const { data, error } = await db().rpc('audit_pending_debit_groups', {
    p_company_id: companyId,
    p_year: input.year,
    p_bank_account_id: input.bankAccountId ?? null,
    p_search: input.search ?? '',
    p_page: input.page ?? 1,
    p_page_size: input.pageSize ?? 50,
  })
  if (error) throw new Error(error.message)
  const result = (data ?? {}) as {
    groups?: PendingDebitAuditGroup[]
    totalGroups?: number
    page?: number
    pageSize?: number
  }
  const category = await db()
    .from('financial_categories')
    .select('id,name,affects_cash_flow,affects_pnl_directly')
    .eq('company_id', companyId)
    .eq('code', 'EXPENSE_PERSONNEL_CASH')
    .eq('is_active', true)
    .maybeSingle()
  if (category.error) throw new Error(category.error.message)
  if (!category.data) throw new Error('La categoría de pagos a trabajadores no está disponible.')
  return {
    groups: result.groups ?? [],
    totalGroups: result.totalGroups ?? 0,
    page: result.page ?? input.page ?? 1,
    pageSize: result.pageSize ?? input.pageSize ?? 50,
    category: category.data as { id: string; name: string; affects_cash_flow: boolean; affects_pnl_directly: boolean },
  }
}

export async function classifyPendingDebitAudit(input: {
  year: number
  bankAccountId?: string
  groupKeys: string[]
  categoryId: string
}) {
  const { companyId, user } = await writeContext()
  const groupKeys = [...new Set(input.groupKeys.filter(Boolean))]
  const { data, error } = await db().rpc('classify_pending_debit_groups', {
    p_company_id: companyId,
    p_year: input.year,
    p_bank_account_id: input.bankAccountId ?? null,
    p_group_keys: groupKeys,
    p_category_id: input.categoryId,
    p_classified_by: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath('/dashboard/analisis-comercial/control-financiero/flujo-caja')
  return { ok: true as const, result: data as {
    requestedCount: number
    classifiedCount: number
    omittedCount: number
    errorCount: number
  } }
}

export type PendingDebitAuditMovement = {
  id: string
  bankAccountId: string
  transactionDate: string
  operationDescription: string
  creditAmount: number | string
  debitAmount: number | string
  balanceAfter: number | string
  sourceRowNumber: number
  categoryId: string | null
  categoryName: string | null
  classificationStatus: 'PENDING'
}

export async function getPendingDebitGroupMovements(input: {
  year: number
  bankAccountId?: string
  groupKey: string
  page?: number
  pageSize?: number
}) {
  const { companyId } = await context()
  const { data, error } = await db().rpc('audit_pending_debit_group_movements', {
    p_company_id: companyId,
    p_year: input.year,
    p_bank_account_id: input.bankAccountId ?? null,
    p_group_key: input.groupKey,
    p_page: input.page ?? 1,
    p_page_size: input.pageSize ?? 100,
  })
  if (error) throw new Error(error.message)
  const result = (data ?? {}) as {
    movements?: PendingDebitAuditMovement[]
    totalMovements?: number
    page?: number
    pageSize?: number
  }
  return {
    movements: result.movements ?? [],
    totalMovements: result.totalMovements ?? 0,
    page: result.page ?? input.page ?? 1,
    pageSize: result.pageSize ?? input.pageSize ?? 100,
  }
}

export async function classifyPendingDebitMovements(input: {
  year: number
  bankAccountId?: string
  movementIds: string[]
  categoryId: string
}) {
  const { companyId, user } = await writeContext()
  const movementIds = [...new Set(input.movementIds.filter(Boolean))]
  const { data, error } = await db().rpc('classify_pending_debit_movements', {
    p_company_id: companyId,
    p_year: input.year,
    p_bank_account_id: input.bankAccountId ?? null,
    p_movement_ids: movementIds,
    p_category_id: input.categoryId,
    p_classified_by: user.id,
  })
  if (error) return { ok: false as const, message: error.message }
  revalidatePath('/dashboard/analisis-comercial/control-financiero/flujo-caja')
  return { ok: true as const, result: data as {
    requestedCount: number
    classifiedCount: number
    omittedCount: number
    errorCount: number
  } }
}

export type OffBookPersonnelDetail = { movementId: string; beneficiaryId: string; paymentConcept: 'SUELDO' | 'QUINCENA' | 'BONO' | 'ANTICIPO' | 'OTRO' }

export async function classifyOffBookPersonnelMovements(input: {
  year: number
  bankAccountId?: string
  categoryId: string
  details: OffBookPersonnelDetail[]
}) {
  const { companyId, user } = await writeContext()
  const details = input.details.filter((detail) => detail.movementId && detail.beneficiaryId)
  try {
    const { data, error } = await db().rpc('classify_off_book_personnel_movements', {
      p_company_id: companyId, p_year: input.year, p_bank_account_id: input.bankAccountId ?? null,
      p_category_id: input.categoryId, p_classified_by: user.id,
      p_details: details.map((detail) => ({ movement_id: detail.movementId, beneficiary_id: detail.beneficiaryId, payment_concept: detail.paymentConcept })),
    })
    if (error) return { ok: false as const, message: `No se pudo completar la clasificación. No se realizaron cambios. ${error.message}` }
    revalidatePath(CASH_FLOW_PATH)
    return { ok: true as const, result: data as { requestedCount: number; classifiedCount: number; omittedCount: number; errorCount: number } }
  } catch (error) {
    return { ok: false as const, message: `No se pudo completar la clasificación. No se realizaron cambios. ${error instanceof Error ? error.message : 'Error inesperado.'}` }
  }
}
