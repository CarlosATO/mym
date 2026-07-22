'use server'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'

const sellerTypes = ['FIELD', 'ADMIN', 'MANAGEMENT', 'DISPATCH', 'OTHER'] as const

export type CommissionSellerType = typeof sellerTypes[number]

export type CommissionSeller = {
  company_id: string
  seller_bsale_id: number
  seller_name: string | null
  docs_count: number
  invoices_count: number
  paid_invoices_count: number
  seller_profile_id: string | null
  is_commissionable: boolean
  seller_type: CommissionSellerType
  profile_active: boolean | null
  last_seen_at: string | null
  notes: string | null
}

type CommissionSellerRow = Omit<CommissionSeller, 'seller_bsale_id' | 'docs_count' | 'invoices_count' | 'paid_invoices_count' | 'notes'> & {
  seller_bsale_id: number | string
  docs_count: number | string | null
  invoices_count: number | string | null
  paid_invoices_count: number | string | null
}

export type CommissionSellerProfileInput = {
  seller_bsale_id: number
  seller_name: string
  is_commissionable: boolean
  seller_type: CommissionSellerType
  active: boolean
  notes: string
}

export type CommissionEligibleSummary = {
  lines_count: number
  total_net_amount: number
  period_from: string
  period_to: string
}

export type CommissionSettings = {
  default_commission_percent: number
  base_amount: 'NET'
  require_full_payment: boolean
  historical_cutoff_date: string
  first_eligible_date: string
}

export type CommissionGroup = {
  id: string
  code: string
  name: string
  description: string | null
  supplier_id: string | null
  parent_supplier_id: string | null
  is_active: boolean
}

export type CommissionRuleScope = 'GENERAL' | 'SUPPLIER' | 'GROUP' | 'PRODUCT'
export type CommissionRuleType = 'FIXED_PERCENT' | 'RANGE_BY_AMOUNT' | 'RANGE_BY_QUANTITY'

export type CommissionRule = {
  id: string
  rule_scope: CommissionRuleScope
  seller_profile_id: string | null
  supplier_id: string | null
  commission_group_id: string | null
  product_id: string | null
  rule_type: CommissionRuleType
  range_basis: 'NONE' | 'AMOUNT' | 'QUANTITY'
  min_amount: number | null
  max_amount: number | null
  min_quantity: number | null
  max_quantity: number | null
  commission_percent: number
  valid_from: string
  valid_to: string | null
  priority: number
  is_active: boolean
  notes: string | null
}

export type CommissionPreviewLine = {
  seller_bsale_id: number
  seller_name: string | null
  period_from: string
  period_to: string
  invoice_bsale_id: number
  invoice_number: number | null
  customer_name: string | null
  payment_completed_at: string | null
  invoice_line_id: string
  sku: string | null
  product_name: string | null
  supplier_id: string | null
  supplier_name: string | null
  commission_group_id: string | null
  commission_group_name: string | null
  quantity: number
  net_amount: number
  commission_base_amount: number
  accumulated_amount: number
  accumulated_quantity: number
  rule_id: string | null
  rule_scope: CommissionRuleScope
  rule_type: CommissionRuleType
  range_basis: string
  commission_percent: number
  commission_amount: number
  warning_code: string | null
  warning_message: string | null
}

export type CommissionPreview = {
  summary: {
    invoices_count: number
    lines_count: number
    total_net_amount: number
    total_commission_amount: number
    average_commission_percent: number
    general_rule_lines: number
    warnings_count: number
    period_from: string
    period_to: string
  }
  lines: CommissionPreviewLine[]
  warnings: Array<{ code: string; message: string; count: number }>
}

function commissionDb() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'comercial' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function getAuthenticatedCompany() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) throw new Error('No autorizado')

  const companyId = await getActiveCompanyId(user)
  if (!companyId) throw new Error('No hay una empresa activa')

  return { companyId, userId: user.id }
}

function mapSeller(row: CommissionSellerRow): CommissionSeller {
  return {
    ...row,
    seller_bsale_id: Number(row.seller_bsale_id),
    docs_count: Number(row.docs_count || 0),
    invoices_count: Number(row.invoices_count || 0),
    paid_invoices_count: Number(row.paid_invoices_count || 0),
    seller_type: sellerTypes.includes(row.seller_type) ? row.seller_type : 'OTHER',
    notes: null,
  }
}

export async function getCommissionSellers(): Promise<CommissionSeller[]> {
  const { companyId } = await getAuthenticatedCompany()
  const db = commissionDb()
  const [{ data, error }, { data: profiles, error: profilesError }] = await Promise.all([
    db
    .from('vw_commission_sellers')
    .select('company_id,seller_bsale_id,seller_name,docs_count,invoices_count,paid_invoices_count,seller_profile_id,is_commissionable,seller_type,profile_active,last_seen_at')
    .eq('company_id', companyId)
    .order('paid_invoices_count', { ascending: false, nullsFirst: false })
    .order('seller_name', { ascending: true }),
    db
      .from('commission_seller_profiles')
      .select('seller_bsale_id,notes')
      .eq('company_id', companyId),
  ])

  if (error) throw error
  if (profilesError) throw profilesError

  const notesBySeller = new Map((profiles || []).map(profile => [Number(profile.seller_bsale_id), profile.notes as string | null]))
  return ((data || []) as CommissionSellerRow[]).map(row => ({
    ...mapSeller(row),
    notes: notesBySeller.get(Number(row.seller_bsale_id)) || null,
  }))
}

export async function upsertCommissionSellerProfile(input: CommissionSellerProfileInput) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const sellerId = Number(input.seller_bsale_id)
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0) throw new Error('Vendedor inválido')
  if (!sellerTypes.includes(input.seller_type)) throw new Error('Tipo de vendedor inválido')

  const db = commissionDb()
  const { data: seller, error: sellerError } = await db
    .from('vw_commission_sellers')
    .select('seller_name')
    .eq('company_id', companyId)
    .eq('seller_bsale_id', sellerId)
    .maybeSingle()

  if (sellerError) throw sellerError
  if (!seller) throw new Error('El vendedor no pertenece a la empresa activa')

  const sellerName = String(seller.seller_name || input.seller_name).trim()
  if (!sellerName) throw new Error('El vendedor no tiene nombre disponible')

  const { data, error } = await db
    .from('commission_seller_profiles')
    .upsert({
      company_id: companyId,
      seller_bsale_id: sellerId,
      seller_name: sellerName,
      is_commissionable: Boolean(input.is_commissionable),
      seller_type: input.seller_type,
      active: Boolean(input.active),
      notes: input.notes.trim() || null,
      updated_by: userId,
    }, { onConflict: 'company_id,seller_bsale_id' })
    .select('id,company_id,seller_bsale_id,seller_name,is_commissionable,seller_type,active,notes,created_at,updated_at')
    .single()

  if (error) throw error
  revalidatePath('/dashboard/comercial')
  return data
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export async function getCommissionEligibleSummary(params: {
  seller_bsale_id: number
  period_to: string
  period_from?: string
}): Promise<CommissionEligibleSummary> {
  const { companyId } = await getAuthenticatedCompany()
  const sellerId = Number(params.seller_bsale_id)
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0) throw new Error('Vendedor inválido')
  if (!isIsoDate(params.period_to)) throw new Error('Fecha hasta inválida')
  if (params.period_from && !isIsoDate(params.period_from)) throw new Error('Fecha desde inválida')
  if (params.period_from && params.period_from > params.period_to) throw new Error('El período desde no puede ser posterior al hasta')

  const db = commissionDb()
  const [{ data: settings, error: settingsError }, { data: lastSettlement, error: settlementError }] = await Promise.all([
    db
      .from('commission_settings')
      .select('first_eligible_date')
      .eq('company_id', companyId)
      .eq('active', true)
      .maybeSingle(),
    db
      .from('commission_settlements')
      .select('period_to')
      .eq('company_id', companyId)
      .eq('seller_bsale_id', sellerId)
      .eq('status', 'ISSUED')
      .in('source', ['NORMAL', 'ADJUSTMENT'])
      .order('period_to', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (settingsError) throw settingsError
  if (settlementError) throw settlementError
  if (!settings) throw new Error('Falta la configuración de comisiones de la empresa')

  const nextSettlementDate = lastSettlement?.period_to
    ? new Date(`${lastSettlement.period_to}T00:00:00Z`)
    : null
  if (nextSettlementDate) nextSettlementDate.setUTCDate(nextSettlementDate.getUTCDate() + 1)
  const periodFrom = params.period_from || nextSettlementDate?.toISOString().slice(0, 10) || settings.first_eligible_date

  const { data, error } = await db.rpc('get_commission_eligible_invoice_lines', {
    p_company_id: companyId,
    p_seller_bsale_id: sellerId,
    p_period_to: params.period_to,
    p_period_from: periodFrom,
  }).select('net_amount')

  if (error) throw error
  const lines = Array.isArray(data) ? data : data ? [data] : []
  const totalNetAmount = lines.reduce((total, line) => total + Number(line.net_amount || 0), 0)

  return {
    lines_count: lines.length,
    total_net_amount: totalNetAmount,
    period_from: periodFrom,
    period_to: params.period_to,
  }
}

export async function getCommissionSettings(): Promise<CommissionSettings> {
  const { companyId } = await getAuthenticatedCompany()
  const { data, error } = await commissionDb()
    .from('commission_settings')
    .select('default_commission_percent,base_amount,require_full_payment,historical_cutoff_date,first_eligible_date')
    .eq('company_id', companyId)
    .eq('active', true)
    .single()
  if (error) throw error
  return { ...data, default_commission_percent: Number(data.default_commission_percent) } as CommissionSettings
}

export async function updateCommissionSettings(input: { default_commission_percent: number }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const percent = Number(input.default_commission_percent)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('El porcentaje debe estar entre 0 y 100')

  const { data, error } = await commissionDb()
    .from('commission_settings')
    .update({ default_commission_percent: percent, updated_by: userId })
    .eq('company_id', companyId)
    .select('default_commission_percent,base_amount,require_full_payment,historical_cutoff_date,first_eligible_date')
    .single()
  if (error) throw error
  return { ...data, default_commission_percent: Number(data.default_commission_percent) } as CommissionSettings
}

export async function getCommissionGroups(): Promise<CommissionGroup[]> {
  const { companyId } = await getAuthenticatedCompany()
  const { data, error } = await commissionDb()
    .from('commission_groups')
    .select('id,code,name,description,supplier_id,parent_supplier_id,is_active')
    .eq('company_id', companyId)
    .order('is_active', { ascending: false })
    .order('name')
  if (error) throw error
  return (data || []) as CommissionGroup[]
}

export async function upsertCommissionGroup(input: Omit<CommissionGroup, 'id'> & { id?: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const code = input.code.trim().toUpperCase()
  const name = input.name.trim()
  if (!code || !name) throw new Error('Código y nombre son obligatorios')

  const payload = {
    company_id: companyId,
    code,
    name,
    description: input.description?.trim() || null,
    supplier_id: input.supplier_id || null,
    parent_supplier_id: input.parent_supplier_id || null,
    is_active: Boolean(input.is_active),
    updated_by: userId,
  }
  const query = input.id
    ? commissionDb().from('commission_groups').update(payload).eq('id', input.id).eq('company_id', companyId)
    : commissionDb().from('commission_groups').insert({ ...payload, created_by: userId })
  const { data, error } = await query.select('id,code,name,description,supplier_id,parent_supplier_id,is_active').single()
  if (error) throw error
  return data as CommissionGroup
}

export async function searchCommissionSuppliers(query: string) {
  const { companyId } = await getAuthenticatedCompany()
  const term = query.trim()
  let request = commissionDb()
    .schema('adquisiciones')
    .from('suppliers')
    .select('id,business_name,fantasy_name,parent_supplier_id,supplier_kind')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('business_name')
    .limit(30)
  if (term) request = request.or(`business_name.ilike.%${term}%,fantasy_name.ilike.%${term}%`)
  const { data, error } = await request
  if (error) throw error
  return (data || []).map(row => ({
    id: row.id as string,
    name: String(row.business_name || row.fantasy_name || 'Proveedor sin nombre'),
    parent_supplier_id: row.parent_supplier_id as string | null,
    supplier_kind: row.supplier_kind as string | null,
  }))
}

export async function searchCommissionProducts(query: string) {
  const { companyId } = await getAuthenticatedCompany()
  const term = query.trim()
  if (term.length < 2) return []
  const { data, error } = await commissionDb()
    .schema('adquisiciones')
    .from('products')
    .select('id,sku,description')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .or(`sku.ilike.%${term}%,description.ilike.%${term}%`)
    .order('description')
    .limit(30)
  if (error) throw error
  return (data || []).map(row => ({ id: row.id as string, sku: row.sku as string, description: row.description as string }))
}

export async function getCommissionRules(): Promise<CommissionRule[]> {
  const { companyId } = await getAuthenticatedCompany()
  const { data, error } = await commissionDb()
    .from('commission_rules')
    .select('id,rule_scope,seller_profile_id,supplier_id,commission_group_id,product_id,rule_type,range_basis,min_amount,max_amount,min_quantity,max_quantity,commission_percent,valid_from,valid_to,priority,is_active,notes')
    .eq('company_id', companyId)
    .order('is_active', { ascending: false })
    .order('rule_scope')
    .order('priority', { ascending: false })
  if (error) throw error
  return (data || []).map(row => ({
    ...row,
    min_amount: numberOrNull(row.min_amount), max_amount: numberOrNull(row.max_amount),
    min_quantity: numberOrNull(row.min_quantity), max_quantity: numberOrNull(row.max_quantity),
    commission_percent: Number(row.commission_percent),
  })) as CommissionRule[]
}

export async function upsertCommissionRule(input: Omit<CommissionRule, 'id' | 'range_basis'> & { id?: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const scope = input.rule_scope
  const type = input.rule_type
  const validFrom = input.valid_from
  if (!isIsoDate(validFrom) || (input.valid_to && !isIsoDate(input.valid_to)) || (input.valid_to && input.valid_to < validFrom)) throw new Error('Vigencia inválida')
  const percent = Number(input.commission_percent)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('El porcentaje debe estar entre 0 y 100')
  const targets = { supplier_id: input.supplier_id || null, commission_group_id: input.commission_group_id || null, product_id: input.product_id || null }
  const validTarget = (scope === 'GENERAL' && !targets.supplier_id && !targets.commission_group_id && !targets.product_id)
    || (scope === 'SUPPLIER' && targets.supplier_id && !targets.commission_group_id && !targets.product_id)
    || (scope === 'GROUP' && !targets.supplier_id && targets.commission_group_id && !targets.product_id)
    || (scope === 'PRODUCT' && !targets.supplier_id && !targets.commission_group_id && targets.product_id)
  if (!validTarget) throw new Error('El destino de la regla no corresponde al ámbito seleccionado')

  const minAmount = type === 'RANGE_BY_AMOUNT' ? Number(input.min_amount) : null
  const maxAmount = type === 'RANGE_BY_AMOUNT' && input.max_amount !== null ? Number(input.max_amount) : null
  const minQuantity = type === 'RANGE_BY_QUANTITY' ? Number(input.min_quantity) : null
  const maxQuantity = type === 'RANGE_BY_QUANTITY' && input.max_quantity !== null ? Number(input.max_quantity) : null
  if (type === 'RANGE_BY_AMOUNT' && (!Number.isFinite(minAmount ?? NaN) || (minAmount ?? -1) < 0 || (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount < (minAmount ?? 0))))) throw new Error('Rango de monto inválido')
  if (type === 'RANGE_BY_QUANTITY' && (!Number.isFinite(minQuantity ?? NaN) || (minQuantity ?? -1) < 0 || (maxQuantity !== null && (!Number.isFinite(maxQuantity) || maxQuantity < (minQuantity ?? 0))))) throw new Error('Rango de cantidad inválido')

  const { data: existingRules, error: existingRulesError } = await commissionDb()
    .from('commission_rules')
    .select('id,seller_profile_id,supplier_id,commission_group_id,product_id,rule_type,valid_from,valid_to,min_amount,max_amount,min_quantity,max_quantity')
    .eq('company_id', companyId)
    .eq('rule_scope', scope)
    .eq('is_active', true)
  if (existingRulesError) throw existingRulesError
  const sameTarget = (rule: typeof existingRules extends Array<infer Row> ? Row : never) =>
    rule.seller_profile_id === (input.seller_profile_id || null)
    && rule.supplier_id === targets.supplier_id
    && rule.commission_group_id === targets.commission_group_id
    && rule.product_id === targets.product_id
  const periodOverlaps = (rule: typeof existingRules extends Array<infer Row> ? Row : never) =>
    rule.valid_from <= (input.valid_to || '9999-12-31') && validFrom <= (rule.valid_to || '9999-12-31')
  const rangeOverlaps = (rule: typeof existingRules extends Array<infer Row> ? Row : never) => {
    if (rule.rule_type !== type) return false
    if (type === 'FIXED_PERCENT') return true
    const nextMin = type === 'RANGE_BY_AMOUNT' ? minAmount ?? 0 : minQuantity ?? 0
    const nextMax = type === 'RANGE_BY_AMOUNT' ? maxAmount : maxQuantity
    const currentMin = Number(type === 'RANGE_BY_AMOUNT' ? rule.min_amount : rule.min_quantity)
    const currentMaxValue = type === 'RANGE_BY_AMOUNT' ? rule.max_amount : rule.max_quantity
    const currentMax = currentMaxValue === null ? null : Number(currentMaxValue)
    return currentMin <= (nextMax ?? Infinity) && nextMin <= (currentMax ?? Infinity)
  }
  if ((existingRules || []).some(rule => rule.id !== input.id && sameTarget(rule) && periodOverlaps(rule) && rangeOverlaps(rule))) {
    throw new Error('Existe una regla activa con rango y vigencia solapados para este ámbito')
  }

  const payload = {
    company_id: companyId,
    rule_scope: scope,
    seller_profile_id: input.seller_profile_id || null,
    ...targets,
    rule_type: type,
    range_basis: type === 'FIXED_PERCENT' ? 'NONE' : type === 'RANGE_BY_AMOUNT' ? 'AMOUNT' : 'QUANTITY',
    min_amount: minAmount ?? null,
    max_amount: maxAmount,
    min_quantity: minQuantity ?? null,
    max_quantity: maxQuantity,
    commission_percent: percent,
    valid_from: validFrom,
    valid_to: input.valid_to || null,
    priority: Math.max(0, Number(input.priority) || 0),
    is_active: Boolean(input.is_active),
    notes: input.notes?.trim() || null,
    updated_by: userId,
  }
  const query = input.id
    ? commissionDb().from('commission_rules').update(payload).eq('id', input.id).eq('company_id', companyId)
    : commissionDb().from('commission_rules').insert({ ...payload, created_by: userId })
  const { data, error } = await query.select('id').single()
  if (error) throw error
  return data as { id: string }
}

export async function deactivateCommissionRule(ruleId: string) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const { error } = await commissionDb().from('commission_rules').update({ is_active: false, updated_by: userId }).eq('id', ruleId).eq('company_id', companyId)
  if (error) throw error
}

export async function previewCommissionSettlement(input: { seller_bsale_id: number; period_to: string; period_from?: string }): Promise<CommissionPreview> {
  const { companyId } = await getAuthenticatedCompany()
  const sellerId = Number(input.seller_bsale_id)
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0 || !isIsoDate(input.period_to) || (input.period_from && !isIsoDate(input.period_from))) throw new Error('Parámetros de simulación inválidos')

  const { data: seller, error: sellerError } = await commissionDb().from('vw_commission_sellers').select('is_commissionable,profile_active').eq('company_id', companyId).eq('seller_bsale_id', sellerId).maybeSingle()
  if (sellerError) throw sellerError
  if (!seller?.is_commissionable || seller.profile_active !== true) throw new Error('El vendedor no está habilitado para comisiones')

  const { count: activeRulesCount, error: rulesError } = await commissionDb()
    .from('commission_rules')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
  if (rulesError) throw rulesError
  const previewFunction = activeRulesCount ? 'preview_commission_settlement' : 'preview_default_commission_settlement'

  const pageSize = 1000
  const rawLines: Record<string, unknown>[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await commissionDb().rpc(previewFunction, {
      p_company_id: companyId, p_seller_bsale_id: sellerId, p_period_to: input.period_to, p_period_from: input.period_from || null,
    }).range(from, from + pageSize - 1)
    if (error) throw error
    const page = Array.isArray(data) ? data : data ? [data] : []
    rawLines.push(...page)
    if (page.length < pageSize) break
  }
  const lines = rawLines.map(row => ({
    ...row,
    seller_bsale_id: Number(row.seller_bsale_id), invoice_bsale_id: Number(row.invoice_bsale_id), invoice_number: numberOrNull(row.invoice_number),
    quantity: Number(row.quantity), net_amount: Number(row.net_amount), commission_base_amount: Number(row.commission_base_amount),
    accumulated_amount: Number(row.accumulated_amount), accumulated_quantity: Number(row.accumulated_quantity),
    commission_percent: Number(row.commission_percent), commission_amount: Number(row.commission_amount),
  })) as CommissionPreviewLine[]
  const warnings = new Map<string, { code: string; message: string; count: number }>()
  for (const line of lines) if (line.warning_code) {
    const current = warnings.get(line.warning_code) || { code: line.warning_code, message: line.warning_message || line.warning_code, count: 0 }
    current.count++
    warnings.set(line.warning_code, current)
  }
  const totalNetAmount = lines.reduce((sum, line) => sum + line.net_amount, 0)
  const totalCommissionAmount = lines.reduce((sum, line) => sum + line.commission_amount, 0)
  return {
    summary: {
      invoices_count: new Set(lines.map(line => line.invoice_bsale_id)).size,
      lines_count: lines.length,
      total_net_amount: totalNetAmount,
      total_commission_amount: totalCommissionAmount,
      average_commission_percent: totalNetAmount ? totalCommissionAmount / totalNetAmount * 100 : 0,
      general_rule_lines: lines.filter(line => line.warning_code === 'DEFAULT_RULE_USED').length,
      warnings_count: Array.from(warnings.values()).reduce((sum, warning) => sum + warning.count, 0),
      period_from: lines[0]?.period_from || input.period_from || '',
      period_to: input.period_to,
    },
    lines,
    warnings: Array.from(warnings.values()),
  }
}
