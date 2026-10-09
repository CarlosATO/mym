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
  bankName: string
  maskedAccountNumber: string
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
  const accountIds = [...new Set((result.groups ?? []).map((group) => group.bankAccountId))]
  const { data: accounts, error: accountsError } = await db()
    .from('financial_bank_accounts')
    .select('id,bank_name,account_number')
    .eq('company_id', companyId)
    .in('id', accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000'])
  if (accountsError) throw new Error(accountsError.message)
  const accountMap = new Map<string, any>((accounts ?? []).map((account: any) => [account.id, account]))
  const groups = (result.groups ?? []).map((group) => {
    const account = accountMap.get(group.bankAccountId)
    return {
      ...group,
      bankName: account?.bank_name ?? 'Banco desconocido',
      maskedAccountNumber: account?.account_number ? `•••• ${account.account_number.slice(-4)}` : '—',
    }
  })
  return {
    groups,
    totalGroups: result.totalGroups ?? 0,
    page: result.page ?? input.page ?? 1,
    pageSize: result.pageSize ?? input.pageSize ?? 50,
  }
}

async function getDebitCategory(companyId: string, categoryId: string) {
  const { data, error } = await db()
    .from('financial_categories')
    .select('id,parent_id,direction,cash_direction,is_active')
    .eq('company_id', companyId)
    .eq('id', categoryId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || !data.parent_id || !['EXPENSE', 'BOTH'].includes(data.direction) || !['DEBIT', 'BOTH'].includes(data.cash_direction ?? '')) {
    throw new Error('La categoría debe ser una hoja activa de gasto con dirección DEBE.')
  }
  const { count, error: childError } = await db()
    .from('financial_categories')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('parent_id', categoryId)
    .eq('is_active', true)
  if (childError) throw new Error(childError.message)
  if ((count ?? 0) > 0) throw new Error('La categoría debe ser una hoja activa.')
  return data
}

export async function classifyPendingDebitAudit(input: {
  year: number
  bankAccountId?: string
  groupKeys: string[]
  categoryId: string
  createRule?: boolean
}) {
  const { companyId, user } = await writeContext()
  const groupKeys = [...new Set(input.groupKeys.filter(Boolean))]
  if (!groupKeys.length) return { ok: true as const, result: { requestedCount: 0, classifiedCount: 0, omittedCount: 0, errorCount: 0, rulesCreated: 0 } }
  try {
    await getDebitCategory(companyId, input.categoryId)
    const { data: movements, error: movementError } = await db()
      .from('financial_bank_movements')
      .select('id,bank_account_id,direction,debit_amount,normalized_description,operation_description,category_id')
      .eq('company_id', companyId)
      .gte('transaction_date', `${input.year}-01-01`)
      .lt('transaction_date', `${input.year + 1}-01-01`)
      .eq('direction', 'DEBE')
      .gt('debit_amount', 0)
      .is('category_id', null)
      .in('classification_signature', groupKeys)
    if (movementError) throw new Error(movementError.message)
    const scopedMovements = (movements ?? []).filter((movement: any) => !input.bankAccountId || movement.bank_account_id === input.bankAccountId)
    const accountIds = [...new Set(scopedMovements.map((movement: any) => movement.bank_account_id))]
    const normalizedValues = [...new Set(scopedMovements.map((movement: any) => movement.normalized_description || normalizeBankOperation(movement.operation_description)))]
    const { data: existingRules, error: rulesError } = await db()
      .from('financial_bank_classification_rules')
      .select('id,bank_account_id,match_value,category_id,mode')
      .eq('company_id', companyId)
      .eq('active', true)
      .eq('direction', 'DEBE')
      .eq('match_type', 'EXACT')
      .in('bank_account_id', accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000'])
      .in('match_value', normalizedValues.length ? normalizedValues : [''])
    if (rulesError) throw new Error(rulesError.message)
    const rulesByScope = new Map<string, any[]>()
    for (const rule of existingRules ?? []) {
      const scope = `${rule.bank_account_id}|${rule.match_value}`
      rulesByScope.set(scope, [...(rulesByScope.get(scope) ?? []), rule])
    }
    const ruleIdsByMovement = new Map<string, string | null>()
    let rulesCreated = 0
    for (const movement of scopedMovements as any[]) {
      const matchValue = movement.normalized_description || normalizeBankOperation(movement.operation_description)
      const scope = `${movement.bank_account_id}|${matchValue}`
      const existing = rulesByScope.get(scope) ?? []
      const existingCategories = [...new Set(existing.map((candidate: any) => candidate.category_id))]
      let rule = existingCategories.length === 1 ? existing[0] : existing.length ? { id: null, category_id: '__CONFLICT__' } : undefined
      if (!existing.length && input.createRule) {
        const { data: created, error: createError } = await db().rpc('create_financial_bank_classification_rule', {
          p_company_id: companyId,
          p_name: `Auditoría exacta: ${movement.operation_description}`,
          p_direction: 'DEBE',
          p_bank_account_id: movement.bank_account_id,
          p_match_type: 'EXACT',
          p_match_value: matchValue,
          p_category_id: input.categoryId,
          p_counterparty: null,
          p_mode: 'AUTO',
          p_created_by: user.id,
          p_apply_movement_ids: [],
        })
        if (createError) throw new Error(createError.message)
        rule = { id: (created as any)?.rule_id ?? (created as any)?.id, category_id: input.categoryId, mode: 'AUTO' }
        rulesByScope.set(scope, [rule])
        rulesCreated += 1
      }
      ruleIdsByMovement.set(movement.id, rule?.category_id === input.categoryId ? rule.id : null)
    }
    let classifiedCount = 0
    for (const [ruleId, ids] of new Map<string | null, string[]>(
      scopedMovements.reduce((groups: Map<string | null, string[]>, movement: any) => {
        const ruleId = ruleIdsByMovement.get(movement.id) ?? null
        groups.set(ruleId, [...(groups.get(ruleId) ?? []), movement.id])
        return groups
      }, new Map()),
    )) {
      const { data, error } = await db().rpc('classify_financial_bank_movements', {
        p_company_id: companyId, p_movement_ids: ids, p_category_id: input.categoryId,
        p_counterparty: null, p_note: null, p_source: 'BULK_EXACT', p_rule_id: ruleId,
        p_only_pending: true, p_classified_by: user.id,
      })
      if (error) throw new Error(error.message)
      classifiedCount += Number((data as any)?.updated_count ?? 0)
    }
    revalidatePath('/dashboard/analisis-comercial/control-financiero/flujo-caja')
    return { ok: true as const, result: { requestedCount: scopedMovements.length, classifiedCount, omittedCount: scopedMovements.length - classifiedCount, errorCount: 0, rulesCreated } }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo completar la clasificación.' }
  }
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
  createRule?: boolean
}) {
  const { companyId, user } = await writeContext()
  const movementIds = [...new Set(input.movementIds.filter(Boolean))]
  try {
    await getDebitCategory(companyId, input.categoryId)
    const { data: movements, error: movementError } = await db()
      .from('financial_bank_movements')
      .select('id,bank_account_id,normalized_description,operation_description')
      .eq('company_id', companyId)
      .gte('transaction_date', `${input.year}-01-01`)
      .lt('transaction_date', `${input.year + 1}-01-01`)
      .eq('direction', 'DEBE')
      .gt('debit_amount', 0)
      .is('category_id', null)
      .in('id', movementIds.length ? movementIds : ['00000000-0000-0000-0000-000000000000'])
    if (movementError) throw new Error(movementError.message)
    const scopedMovements = (movements ?? []).filter((movement: any) => !input.bankAccountId || movement.bank_account_id === input.bankAccountId) as any[]
    const ruleIds = new Map<string, string | null>()
    let rulesCreated = 0
    if (input.createRule) {
      for (const movement of scopedMovements) {
        const matchValue = movement.normalized_description || normalizeBankOperation(movement.operation_description)
        const { data: existing, error: existingError } = await db()
          .from('financial_bank_classification_rules')
          .select('id,category_id')
          .eq('company_id', companyId)
          .eq('active', true)
          .eq('bank_account_id', movement.bank_account_id)
          .eq('direction', 'DEBE')
          .eq('match_type', 'EXACT')
          .eq('match_value', matchValue)
        if (existingError) throw new Error(existingError.message)
        const matchingCategories = [...new Set((existing ?? []).map((rule: any) => rule.category_id))]
        let rule = matchingCategories.length === 1 ? existing?.[0] : null
        if (!(existing ?? []).length) {
          const { data: created, error: createError } = await db().rpc('create_financial_bank_classification_rule', {
            p_company_id: companyId, p_name: `Auditoría exacta: ${movement.operation_description}`,
            p_direction: 'DEBE', p_bank_account_id: movement.bank_account_id, p_match_type: 'EXACT',
            p_match_value: matchValue, p_category_id: input.categoryId, p_counterparty: null,
            p_mode: 'AUTO', p_created_by: user.id, p_apply_movement_ids: [],
          })
          if (createError) throw new Error(createError.message)
          rule = { id: (created as any)?.rule_id ?? (created as any)?.id, category_id: input.categoryId }
          rulesCreated += 1
        }
        ruleIds.set(movement.id, rule?.category_id === input.categoryId ? rule.id : null)
      }
    }
    const groups = new Map<string | null, string[]>()
    for (const movement of scopedMovements) {
      const ruleId = ruleIds.get(movement.id) ?? null
      groups.set(ruleId, [...(groups.get(ruleId) ?? []), movement.id])
    }
    let classifiedCount = 0
    for (const [ruleId, ids] of groups) {
      const { data, error } = await db().rpc('classify_financial_bank_movements', {
        p_company_id: companyId, p_movement_ids: ids, p_category_id: input.categoryId,
        p_counterparty: null, p_note: null, p_source: input.createRule ? 'BULK_EXACT' : 'MANUAL', p_rule_id: ruleId,
        p_only_pending: true, p_classified_by: user.id,
      })
      if (error) throw new Error(error.message)
      classifiedCount += Number((data as any)?.updated_count ?? 0)
    }
    revalidatePath('/dashboard/analisis-comercial/control-financiero/flujo-caja')
    return { ok: true as const, result: { requestedCount: scopedMovements.length, classifiedCount, omittedCount: scopedMovements.length - classifiedCount, errorCount: 0, rulesCreated } }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo completar la clasificación.' }
  }
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
