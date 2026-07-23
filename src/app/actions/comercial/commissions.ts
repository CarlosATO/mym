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
  is_archived?: boolean
  archived_at?: string | null
  archive_reason?: string | null
  notes: string | null
  rule_name?: string | null
  rule_description?: string | null
  rule_batch_id?: string | null
  selection_summary?: Record<string, unknown> | null
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
  product_id?: string | null
  commission_group_id: string | null
  commission_group_name: string | null
  quantity: number
  net_amount: number
  commission_base_amount: number
  accumulated_amount: number
  accumulated_quantity: number
  rule_id: string | null
  rule_scope: CommissionRuleScope
  applied_rule_label: string
  applied_rule_scope: CommissionRuleScope
  applied_rule_batch_id: string | null
  rule_type: CommissionRuleType
  range_basis: string
  commission_percent: number
  commission_amount: number
  warning_code: string | null
  warning_message: string | null
  commission_line_type?: string | null
  source_document_type?: string | null
  source_document_id?: number | null
  source_document_number?: number | null
  source_detail_id?: string | null
  original_invoice_id?: number | null
  original_invoice_number?: number | null
  adjustment_reason?: string | null
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

export type CommissionSettlementHeader = {
  id: string
  company_id: string
  settlement_number: number | null
  settlement_code: string
  seller_bsale_id: number | null
  seller_name: string | null
  period_from: string
  period_to: string
  period_label: string
  status: string
  source: string
  total_net_amount: number
  total_commission_amount: number
  lines_count?: number
  issued_at?: string | null
  created_at?: string
  cancelled_at?: string | null
  cancellation_reason?: string | null
}

export type CommissionSettlementLine = {
  id: string
  settlement_id: string
  line_type: string
  invoice_bsale_id?: number | null
  invoice_number?: number | null
  invoice_line_id?: string | null
  sku?: string | null
  product_name?: string | null
  customer_name?: string | null
  supplier_name?: string | null
  commission_group_name?: string | null
  quantity: number
  net_amount: number
  commission_percent?: number | null
  commission_amount?: number | null
  rule_id?: string | null
  payment_completed_at?: string | null
  source_document_bsale_id?: number | null
  source_document_number?: number | null
  source_document_type_id?: number | null
  source_document_line_id?: string | null
  original_invoice_bsale_id?: number | null
  original_invoice_number?: number | null
  eligibility_locked_at?: string | null
  metadata: Record<string, unknown>
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
    .select('id,business_name,fantasy_name,rut,parent_supplier_id,supplier_kind')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .or('supplier_kind.eq.REAL,supplier_kind.is.null')
    .order('business_name')
    .limit(30)
  if (term) request = request.or(`business_name.ilike.%${term}%,fantasy_name.ilike.%${term}%`)
  const { data, error } = await request
  if (error) throw error
  return (data || []).map(row => ({
    id: row.id as string,
    name: String(row.business_name || row.fantasy_name || 'Proveedor sin nombre'),
    rut: row.rut as string | null,
    parent_supplier_id: row.parent_supplier_id as string | null,
    supplier_kind: row.supplier_kind as string | null,
    type_label: 'Proveedor real',
  }))
}

export async function searchCommissionProducts(query: string, supplierIds?: string[]) {
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
  const products = (data || []).map(row => ({ id: row.id as string, sku: row.sku as string, description: row.description as string }))
  if (!products.length) return []

  const mappingsRequest = commissionDb().schema('adquisiciones').from('product_supplier_mappings').select('product_id,supplier_id,is_preferred,updated_at').eq('company_id', companyId).eq('is_active', true).in('product_id', products.map(product => product.id)).order('is_preferred', { ascending: false }).order('updated_at', { ascending: false, nullsFirst: false })
  const selectedSupplierIds = Array.from(new Set((supplierIds || []).filter(Boolean)))
  const { data: mappings, error: mappingsError } = await mappingsRequest
  if (mappingsError) throw mappingsError

  const mappingSupplierIds = Array.from(new Set((mappings || []).map(mapping => mapping.supplier_id as string).filter(Boolean)))
  const { data: mappedSuppliers, error: mappedSuppliersError } = mappingSupplierIds.length
    ? await commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name,supplier_kind,parent_supplier_id').eq('company_id', companyId).eq('is_active', true).in('id', mappingSupplierIds)
    : { data: [], error: null }
  if (mappedSuppliersError) throw mappedSuppliersError
  const parentIds = Array.from(new Set((mappedSuppliers || []).map(supplier => supplier.parent_supplier_id as string | null).filter((id): id is string => Boolean(id))))
  const { data: parentSuppliers, error: parentSuppliersError } = parentIds.length
    ? await commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name,supplier_kind').eq('company_id', companyId).eq('is_active', true).or('supplier_kind.eq.REAL,supplier_kind.is.null').in('id', parentIds)
    : { data: [], error: null }
  if (parentSuppliersError) throw parentSuppliersError

  const parentsById = new Map((parentSuppliers || []).map(supplier => [supplier.id as string, supplier]))
  const suppliersById = new Map((mappedSuppliers || []).map(supplier => {
    const parent = supplier.parent_supplier_id ? parentsById.get(supplier.parent_supplier_id as string) : null
    const effective = parent || supplier
    return [supplier.id as string, { id: effective.id as string, name: String(effective.business_name || effective.fantasy_name || 'Proveedor sin nombre') }]
  }))
  const mappingByProduct = new Map<string, { supplier_id: string; supplier_name: string }>()
  for (const mapping of mappings || []) {
    const supplier = suppliersById.get(mapping.supplier_id as string)
    if (supplier && !mappingByProduct.has(mapping.product_id as string)) mappingByProduct.set(mapping.product_id as string, { supplier_id: supplier.id, supplier_name: supplier.name })
  }
  return products.filter(product => !selectedSupplierIds.length || mappingByProduct.get(product.id)?.supplier_id && selectedSupplierIds.includes(mappingByProduct.get(product.id)!.supplier_id)).map(product => ({ ...product, supplier_id: mappingByProduct.get(product.id)?.supplier_id || null, supplier_name: mappingByProduct.get(product.id)?.supplier_name || null }))
}

export async function getCommissionRules(): Promise<CommissionRule[]> {
  const { companyId } = await getAuthenticatedCompany()
  const { data, error } = await commissionDb()
    .from('commission_rules')
    .select('id,rule_scope,seller_profile_id,supplier_id,commission_group_id,product_id,rule_type,range_basis,min_amount,max_amount,min_quantity,max_quantity,commission_percent,valid_from,valid_to,priority,is_active,is_archived,archived_at,archive_reason,notes,rule_name,rule_description,rule_batch_id,selection_summary')
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

export async function getCommissionRuleBatchDetail(ruleBatchId: string) {
  const { companyId } = await getAuthenticatedCompany()
  if (!ruleBatchId.trim()) throw new Error('Condición inválida')
  const { data: rules, error } = await commissionDb().from('commission_rules').select('id,rule_name,rule_description,rule_batch_id,rule_scope,rule_type,seller_profile_id,supplier_id,commission_group_id,product_id,min_amount,max_amount,min_quantity,max_quantity,commission_percent,valid_from,valid_to,is_active').eq('company_id', companyId).eq('rule_batch_id', ruleBatchId)
  if (error) throw error
  if (!rules?.length) throw new Error('La condición no pertenece a la empresa activa')

  const sellerIds = Array.from(new Set(rules.map(rule => rule.seller_profile_id as string | null).filter((id): id is string => Boolean(id))))
  const productIds = Array.from(new Set(rules.map(rule => rule.product_id as string | null).filter((id): id is string => Boolean(id))))
  const supplierIds = Array.from(new Set(rules.map(rule => rule.supplier_id as string | null).filter((id): id is string => Boolean(id))))
  const groupIds = Array.from(new Set(rules.map(rule => rule.commission_group_id as string | null).filter((id): id is string => Boolean(id))))
  const [{ data: sellers, error: sellersError }, { data: products, error: productsError }, { data: suppliers, error: suppliersError }, { data: groups, error: groupsError }] = await Promise.all([
    sellerIds.length ? commissionDb().from('commission_seller_profiles').select('id,seller_name,seller_bsale_id').eq('company_id', companyId).in('id', sellerIds) : Promise.resolve({ data: [], error: null }),
    productIds.length ? commissionDb().schema('adquisiciones').from('products').select('id,sku,description').eq('company_id', companyId).in('id', productIds) : Promise.resolve({ data: [], error: null }),
    supplierIds.length ? commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name').eq('company_id', companyId).in('id', supplierIds) : Promise.resolve({ data: [], error: null }),
    groupIds.length ? commissionDb().from('commission_groups').select('id,name').eq('company_id', companyId).in('id', groupIds) : Promise.resolve({ data: [], error: null }),
  ])
  if (sellersError || productsError || suppliersError || groupsError) throw sellersError || productsError || suppliersError || groupsError
  const { data: productMappings, error: productMappingsError } = productIds.length
    ? await commissionDb().schema('adquisiciones').from('product_supplier_mappings').select('product_id,supplier_id,is_preferred').eq('company_id', companyId).eq('is_active', true).in('product_id', productIds).order('is_preferred', { ascending: false })
    : { data: [], error: null }
  if (productMappingsError) throw productMappingsError
  const mappedSupplierIds = Array.from(new Set((productMappings || []).map(mapping => mapping.supplier_id as string).filter(Boolean)))
  const { data: mappedSuppliers, error: mappedSuppliersError } = mappedSupplierIds.length
    ? await commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name').eq('company_id', companyId).in('id', mappedSupplierIds)
    : { data: [], error: null }
  if (mappedSuppliersError) throw mappedSuppliersError
  const mappedSupplierNames = new Map((mappedSuppliers || []).map(supplier => [supplier.id as string, String(supplier.business_name || supplier.fantasy_name || 'Sin proveedor asociado')]))
  const productSupplierNames = new Map<string, string>()
  for (const mapping of productMappings || []) if (!productSupplierNames.has(mapping.product_id as string)) productSupplierNames.set(mapping.product_id as string, mappedSupplierNames.get(mapping.supplier_id as string) || 'Sin proveedor asociado')
  const first = rules[0]
  return {
    name: String(first.rule_name || 'Condición de comisión'), description: first.rule_description as string | null,
    validFrom: first.valid_from as string, validTo: first.valid_to as string | null, isActive: Boolean(first.is_active),
    scope: first.rule_scope as CommissionRuleScope, type: first.rule_type as CommissionRuleType, commissionPercent: Number(first.commission_percent),
    minAmount: numberOrNull(first.min_amount), maxAmount: numberOrNull(first.max_amount), minQuantity: numberOrNull(first.min_quantity), maxQuantity: numberOrNull(first.max_quantity),
    sellers: (sellers || []).map(seller => ({ name: seller.seller_name as string, bsaleId: Number(seller.seller_bsale_id) })),
    products: (products || []).map(product => ({ sku: product.sku as string, name: product.description as string, supplierName: productSupplierNames.get(product.id as string) || 'Sin proveedor asociado' })),
    suppliers: (suppliers || []).map(supplier => ({ name: String(supplier.business_name || supplier.fantasy_name || 'Proveedor sin nombre') })),
    groups: (groups || []).map(group => ({ name: group.name as string })),
  }
}

export async function deactivateCommissionRuleBatch(ruleBatchId: string) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const { error } = await commissionDb().from('commission_rules').update({ is_active: false, updated_by: userId }).eq('company_id', companyId).eq('rule_batch_id', ruleBatchId)
  if (error) throw error
}

export async function setCommissionRuleBatchActive(ruleBatchId: string, isActive: boolean) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!ruleBatchId.trim()) throw new Error('Condición inválida')
  let request = commissionDb().from('commission_rules').update({ is_active: isActive, updated_by: userId }).eq('company_id', companyId).eq('rule_batch_id', ruleBatchId)
  if (isActive) request = request.eq('is_archived', false)
  const { error } = await request
  if (error) throw error
  revalidatePath('/dashboard/comercial')
}

export async function archiveCommissionRuleBatch(input: { ruleBatchId: string; archiveReason?: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!input.ruleBatchId.trim()) throw new Error('Condición inválida')
  const { error } = await commissionDb().from('commission_rules').update({ is_archived: true, archived_at: new Date().toISOString(), archived_by: userId, archive_reason: input.archiveReason?.trim() || null, is_active: false, updated_by: userId }).eq('company_id', companyId).eq('rule_batch_id', input.ruleBatchId)
  if (error) throw error
  revalidatePath('/dashboard/comercial')
}

export async function restoreCommissionRuleBatch(ruleBatchId: string) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!ruleBatchId.trim()) throw new Error('Condición inválida')
  const { error } = await commissionDb().from('commission_rules').update({ is_archived: false, archived_at: null, archived_by: null, archive_reason: null, is_active: false, updated_by: userId }).eq('company_id', companyId).eq('rule_batch_id', ruleBatchId)
  if (error) throw error
  revalidatePath('/dashboard/comercial')
}

export async function getCommissionGroupProducts(groupId: string) {
  const { companyId } = await getAuthenticatedCompany()
  const { data, error } = await commissionDb()
    .from('commission_group_products')
    .select('product_id,valid_from,valid_to,is_active')
    .eq('company_id', companyId).eq('commission_group_id', groupId).eq('is_active', true)
  if (error) throw error
  const ids = (data || []).map(row => row.product_id as string)
  if (!ids.length) return []
  const { data: products, error: productsError } = await commissionDb().schema('adquisiciones').from('products').select('id,sku,description').in('id', ids)
  if (productsError) throw productsError
  return products || []
}

export async function updateCommissionGroupProducts(groupId: string, productIds: string[]) {
  const { companyId, userId } = await getAuthenticatedCompany()
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)))
  const { error: deactivateError } = await commissionDb().from('commission_group_products').update({ is_active: false, updated_by: userId }).eq('company_id', companyId).eq('commission_group_id', groupId).eq('is_active', true)
  if (deactivateError) throw deactivateError
  if (!uniqueIds.length) return
  const { error } = await commissionDb().from('commission_group_products').insert(uniqueIds.map(product_id => ({ company_id: companyId, commission_group_id: groupId, product_id, valid_from: new Date().toISOString().slice(0, 10), is_active: true, created_by: userId, updated_by: userId })))
  if (error) throw error
}

export async function createGuidedCommissionRule(input: {
  ruleName: string; description?: string; effectiveFrom: string; effectiveTo?: string
  appliesToAllSellers: boolean; sellerProfileIds?: string[]
  targetMode: 'GENERAL' | 'SUPPLIER_ALL_PRODUCTS' | 'SUPPLIER_SELECTED_PRODUCTS' | 'EXISTING_GROUP' | 'SELECTED_PRODUCTS'
  supplierIds?: string[]; groupIds?: string[]; productIds?: string[]
  commissionType: CommissionRuleType; minQuantity?: number | null; maxQuantity?: number | null; minAmount?: number | null; maxAmount?: number | null; commissionPercent: number
}) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!input.ruleName.trim() || !isIsoDate(input.effectiveFrom) || (input.effectiveTo && (!isIsoDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom))) throw new Error('Nombre o vigencia inválidos')
  if (!Number.isFinite(input.commissionPercent) || input.commissionPercent < 0 || input.commissionPercent > 100) throw new Error('Porcentaje inválido')
  const sellerIds = input.appliesToAllSellers ? [null] : Array.from(new Set(input.sellerProfileIds || []))
  if (!sellerIds.length) throw new Error('Selecciona al menos un vendedor')
  const batchId = crypto.randomUUID()
  let targets: Array<{ scope: CommissionRuleScope; id: string | null }> = []
  if (input.targetMode === 'GENERAL') targets = [{ scope: 'GENERAL', id: null }]
  if (input.targetMode === 'SUPPLIER_ALL_PRODUCTS') {
    const supplierIds = Array.from(new Set(input.supplierIds || []))
    if (!supplierIds.length) throw new Error('Selecciona al menos un proveedor')
    if (input.commissionType === 'FIXED_PERCENT') {
      targets = supplierIds.map(id => ({ scope: 'SUPPLIER' as const, id }))
    } else {
      const { data: mappings, error } = await commissionDb().schema('adquisiciones').from('product_supplier_mappings').select('product_id,supplier_id').eq('company_id', companyId).eq('is_active', true).in('supplier_id', supplierIds)
      if (error) throw error
      const productIds = Array.from(new Set((mappings || []).map(row => row.product_id as string).filter(Boolean)))
      if (!productIds.length) throw new Error('Los proveedores seleccionados no tienen productos activos para crear una regla variable por SKU')
      targets = productIds.map(id => ({ scope: 'PRODUCT' as const, id }))
    }
  }
  if (input.targetMode === 'EXISTING_GROUP') targets = (input.groupIds || []).map(id => ({ scope: input.commissionType === 'FIXED_PERCENT' ? 'GROUP' as const : 'PRODUCT' as const, id }))
  if (input.targetMode === 'SUPPLIER_SELECTED_PRODUCTS' || input.targetMode === 'SELECTED_PRODUCTS') targets = (input.productIds || []).map(id => ({ scope: 'PRODUCT' as const, id }))
  if (!targets.length) throw new Error('Selecciona al menos un destino')
  if (input.commissionType !== 'FIXED_PERCENT' && ((input.commissionType === 'RANGE_BY_AMOUNT' && !(Number(input.minAmount) > 0)) || (input.commissionType === 'RANGE_BY_QUANTITY' && !(Number(input.minQuantity) > 0)))) throw new Error('Debes indicar un mínimo mayor a cero')
  if (input.commissionType === 'RANGE_BY_AMOUNT' && input.maxAmount !== null && input.maxAmount !== undefined && Number(input.maxAmount) < Number(input.minAmount)) throw new Error('El monto máximo no puede ser menor al mínimo')
  if (input.commissionType === 'RANGE_BY_QUANTITY' && input.maxQuantity !== null && input.maxQuantity !== undefined && Number(input.maxQuantity) < Number(input.minQuantity)) throw new Error('La cantidad máxima no puede ser menor a la mínima')

  // Variable group rules require explicitly selected products so each SKU is evaluated independently.
  if (input.commissionType !== 'FIXED_PERCENT' && input.targetMode === 'EXISTING_GROUP') throw new Error('Para una regla variable de grupo, selecciona los productos incluidos para evaluar cada SKU individualmente')
  const { data: activeRules, error: activeRulesError } = await commissionDb().from('commission_rules').select('rule_name,rule_scope,seller_profile_id,supplier_id,commission_group_id,product_id,valid_from,valid_to').eq('company_id', companyId).eq('is_active', true).eq('is_archived', false)
  if (activeRulesError) throw activeRulesError
  const newPeriodEnd = input.effectiveTo || '9999-12-31'
  const conflict = (activeRules || []).find(rule => targets.some(target => {
    const sameTarget = target.scope === 'GENERAL' || target.scope === 'SUPPLIER' && rule.supplier_id === target.id || target.scope === 'GROUP' && rule.commission_group_id === target.id || target.scope === 'PRODUCT' && rule.product_id === target.id
    const sellersOverlap = sellerIds.some(sellerId => sellerId === null || rule.seller_profile_id === null || rule.seller_profile_id === sellerId)
    return rule.rule_scope === target.scope && sameTarget && sellersOverlap && rule.valid_from <= newPeriodEnd && (rule.valid_to === null || rule.valid_to >= input.effectiveFrom)
  }))
  if (conflict) {
    const targetLabel = conflict.rule_scope === 'SUPPLIER' ? 'proveedor' : conflict.rule_scope === 'PRODUCT' ? 'producto' : conflict.rule_scope === 'GROUP' ? 'grupo/campaña' : 'general'
    throw new Error(`Ya existe una condición activa para este ${targetLabel}, vendedor y período: ${conflict.rule_name || 'Condición sin nombre'}. Desactívala o archívala antes de crear otra.`)
  }
  const rows = targets.flatMap(target => sellerIds.map(seller_profile_id => ({
    company_id: companyId, seller_profile_id, rule_scope: target.scope,
    supplier_id: target.scope === 'SUPPLIER' ? target.id : null,
    commission_group_id: target.scope === 'GROUP' ? target.id : null,
    product_id: target.scope === 'PRODUCT' ? target.id : null,
    rule_type: input.commissionType, range_basis: input.commissionType === 'FIXED_PERCENT' ? 'NONE' : input.commissionType === 'RANGE_BY_AMOUNT' ? 'AMOUNT' : 'QUANTITY',
    min_amount: input.commissionType === 'RANGE_BY_AMOUNT' ? input.minAmount : null, max_amount: input.commissionType === 'RANGE_BY_AMOUNT' ? input.maxAmount || null : null,
    min_quantity: input.commissionType === 'RANGE_BY_QUANTITY' ? input.minQuantity : null, max_quantity: input.commissionType === 'RANGE_BY_QUANTITY' ? input.maxQuantity || null : null,
    commission_percent: input.commissionPercent, valid_from: input.effectiveFrom, valid_to: input.effectiveTo || null,
    priority: target.scope === 'PRODUCT' ? 400 : target.scope === 'GROUP' ? 300 : target.scope === 'SUPPLIER' ? 200 : 100,
    is_active: true, rule_name: input.ruleName.trim(), rule_description: input.description?.trim() || null, rule_batch_id: batchId,
    source_workflow: 'GUIDED_WIZARD', selection_summary: { targetMode: input.targetMode, suppliers: input.supplierIds || [], groups: input.groupIds || [], products: input.productIds || [], sellers: sellerIds }, created_by: userId, updated_by: userId,
  })))
  const { error } = await commissionDb().from('commission_rules').insert(rows)
  if (error) throw error
  return { ruleBatchId: batchId, technicalRulesCreated: rows.length }
}

export async function previewCommissionSettlement(input: { seller_bsale_id: number; period_to: string; period_from?: string }): Promise<CommissionPreview> {
  const { companyId } = await getAuthenticatedCompany()
  const sellerId = Number(input.seller_bsale_id)
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0 || !isIsoDate(input.period_to) || (input.period_from && !isIsoDate(input.period_from))) throw new Error('Parámetros de simulación inválidos')

  const { data: seller, error: sellerError } = await commissionDb().from('vw_commission_sellers').select('seller_profile_id,is_commissionable,profile_active').eq('company_id', companyId).eq('seller_bsale_id', sellerId).maybeSingle()
  if (sellerError) throw sellerError
  if (!seller?.is_commissionable || seller.profile_active !== true) throw new Error('El vendedor no está habilitado para comisiones')

  const { count: activeRulesCount, error: rulesError } = await commissionDb()
    .from('commission_rules')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
    .eq('is_archived', false)
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
  const previewSupplierIds = Array.from(new Set(rawLines.map(row => String(row.supplier_id || '')).filter(Boolean)))
  const { data: previewSuppliers, error: previewSuppliersError } = previewSupplierIds.length
    ? await commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name,parent_supplier_id').eq('company_id', companyId).in('id', previewSupplierIds)
    : { data: [], error: null }
  if (previewSuppliersError) throw previewSuppliersError
  const previewParentIds = Array.from(new Set((previewSuppliers || []).map(supplier => supplier.parent_supplier_id as string | null).filter((id): id is string => Boolean(id))))
  const { data: previewParents, error: previewParentsError } = previewParentIds.length
    ? await commissionDb().schema('adquisiciones').from('suppliers').select('id,business_name,fantasy_name').eq('company_id', companyId).in('id', previewParentIds)
    : { data: [], error: null }
  if (previewParentsError) throw previewParentsError
  const previewParentsById = new Map((previewParents || []).map(supplier => [supplier.id as string, supplier]))
  const previewSuppliersById = new Map((previewSuppliers || []).map(supplier => {
    const effective = supplier.parent_supplier_id ? previewParentsById.get(supplier.parent_supplier_id as string) || supplier : supplier
    return [supplier.id as string, { id: effective.id as string, name: String(effective.business_name || effective.fantasy_name || 'Proveedor sin nombre') }]
  }))
  const baseLines = rawLines.map(row => ({
    ...row,
    supplier_id: previewSuppliersById.get(String(row.supplier_id || ''))?.id || row.supplier_id,
    supplier_name: previewSuppliersById.get(String(row.supplier_id || ''))?.name || row.supplier_name,
    seller_bsale_id: Number(row.seller_bsale_id), invoice_bsale_id: Number(row.invoice_bsale_id), invoice_number: numberOrNull(row.invoice_number),
    quantity: Number(row.quantity), net_amount: Number(row.net_amount), commission_base_amount: Number(row.commission_base_amount),
    accumulated_amount: Number(row.accumulated_amount), accumulated_quantity: Number(row.accumulated_quantity),
    commission_percent: Number(row.commission_percent), commission_amount: Number(row.commission_amount),
  })) as Omit<CommissionPreviewLine, 'applied_rule_label' | 'applied_rule_scope' | 'applied_rule_batch_id'>[]
  const { data: supplierRules, error: supplierRulesError } = await commissionDb().from('commission_rules').select('id,rule_scope,rule_type,seller_profile_id,supplier_id,commission_percent,valid_from,valid_to,rule_name,rule_batch_id').eq('company_id', companyId).eq('is_active', true).eq('is_archived', false).eq('rule_scope', 'SUPPLIER').eq('rule_type', 'FIXED_PERCENT')
  if (supplierRulesError) throw supplierRulesError
  const linesWithEffectiveSupplierRules = baseLines.map(line => {
    if (line.rule_id) return line
    const applicable = (supplierRules || []).find(rule => rule.supplier_id === line.supplier_id && (!rule.seller_profile_id || rule.seller_profile_id === seller.seller_profile_id) && line.payment_completed_at && line.payment_completed_at.slice(0, 10) >= rule.valid_from && (!rule.valid_to || line.payment_completed_at.slice(0, 10) <= rule.valid_to))
    return applicable ? { ...line, rule_id: applicable.id as string, rule_scope: 'SUPPLIER' as CommissionRuleScope, rule_type: 'FIXED_PERCENT' as CommissionRuleType, range_basis: 'NONE', commission_percent: Number(applicable.commission_percent), commission_amount: Math.round(line.net_amount * Number(applicable.commission_percent) / 100), warning_code: null, warning_message: null } : line
  })
  const ruleIds = Array.from(new Set(linesWithEffectiveSupplierRules.map(line => line.rule_id).filter((id): id is string => Boolean(id))))
  const { data: appliedRules, error: appliedRulesError } = ruleIds.length
    ? await commissionDb().from('commission_rules').select('id,rule_name,rule_scope,rule_batch_id').eq('company_id', companyId).in('id', ruleIds)
    : { data: [], error: null }
  if (appliedRulesError) throw appliedRulesError
  const appliedRulesById = new Map((appliedRules || []).map(rule => [rule.id as string, rule]))
  const fallbackLabel = (scope: CommissionRuleScope) => scope === 'PRODUCT' ? 'Regla por producto' : scope === 'SUPPLIER' ? 'Regla por proveedor' : scope === 'GROUP' ? 'Regla por grupo' : 'Regla general específica'
  const lines = linesWithEffectiveSupplierRules.map(line => {
    const rule = line.rule_id ? appliedRulesById.get(line.rule_id) : null
    return {
      ...line,
      applied_rule_label: rule?.rule_name?.trim() || (line.rule_id ? fallbackLabel(line.rule_scope) : 'General'),
      applied_rule_scope: rule?.rule_scope as CommissionRuleScope || line.rule_scope,
      applied_rule_batch_id: rule?.rule_batch_id || null,
    }
  }) as CommissionPreviewLine[]
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

export async function createCommissionSettlementDraft(input: {
  seller_bsale_id: number
  period_from: string
  period_to: string
}): Promise<{ id: string; total_net_amount: number; total_commission_amount: number }> {
  const { companyId, userId } = await getAuthenticatedCompany()
  const sellerId = Number(input.seller_bsale_id)
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0) throw new Error('Vendedor inválido')

  const preview = await previewCommissionSettlement(input)
  if (!preview.lines.length) throw new Error('No hay líneas elegibles')

  const { data: seller, error: sellerError } = await commissionDb()
    .from('vw_commission_sellers')
    .select('seller_profile_id,seller_name')
    .eq('company_id', companyId)
    .eq('seller_bsale_id', sellerId)
    .maybeSingle()
  if (sellerError) throw sellerError

  const periodLabel = `${input.period_from} al ${input.period_to}`
  const linesJson = preview.lines.map(line => ({
    commission_line_type: line.commission_line_type || 'INVOICE_LINE',
    source_document_type: line.source_document_type || 'INVOICE',
    source_document_id: line.source_document_id || line.invoice_bsale_id,
    source_document_number: line.source_document_number || line.invoice_number,
    source_detail_id: line.source_detail_id || line.invoice_line_id,
    original_invoice_id: line.original_invoice_id || line.invoice_bsale_id,
    original_invoice_number: line.original_invoice_number || line.invoice_number,
    invoice_bsale_id: line.invoice_bsale_id,
    invoice_number: line.invoice_number,
    invoice_line_id: line.invoice_line_id,
    customer_name: line.customer_name,
    product_id: line.product_id || null,
    sku: line.sku,
    product_name: line.product_name,
    supplier_id: line.supplier_id,
    supplier_name: line.supplier_name,
    commission_group_id: line.commission_group_id,
    commission_group_name: line.commission_group_name,
    payment_completed_at: line.payment_completed_at,
    quantity: line.quantity,
    net_amount: line.net_amount,
    commission_percent: line.commission_percent,
    commission_amount: line.commission_amount,
    rule_id: line.rule_id,
    adjustment_reason: line.adjustment_reason || null,
    warning_code: line.warning_code || null,
    warning_message: line.warning_message || null,
  }))

  const { data, error } = await commissionDb().rpc('create_commission_settlement_draft', {
    p_company_id: companyId,
    p_user_id: userId,
    p_seller_bsale_id: sellerId,
    p_seller_profile_id: seller?.seller_profile_id || null,
    p_seller_name: seller?.seller_name || '',
    p_period_from: input.period_from,
    p_period_to: input.period_to,
    p_period_label: periodLabel,
    p_lines: linesJson,
    p_total_net_amount: preview.summary.total_net_amount,
    p_total_commission_amount: preview.summary.total_commission_amount,
  })
  if (error) throw error
  const result = data as { success: boolean; settlement_id?: string; error?: string }
  if (!result.success) throw new Error(result.error || 'Error al crear borrador')

  return { id: result.settlement_id!, total_net_amount: preview.summary.total_net_amount, total_commission_amount: preview.summary.total_commission_amount }
}

export async function getCommissionSettlementDrafts(): Promise<CommissionSettlementHeader[]> {
  const { companyId } = await getAuthenticatedCompany()
  const db = commissionDb()
  const { data, error } = await db
    .from('commission_settlements')
    .select(`
      id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at
    `, { count: 'exact' })
    .eq('company_id', companyId)
    .eq('status', 'DRAFT')
    .eq('source', 'NORMAL')
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = await Promise.all((data || []).map(async (row: Record<string, unknown>) => {
    const { count } = await db.from('commission_settlement_lines').select('id', { count: 'exact', head: true }).eq('settlement_id', row.id)
    return { ...row, lines_count: count, seller_bsale_id: Number(row.seller_bsale_id || 0), total_net_amount: Number(row.total_net_amount), total_commission_amount: Number(row.total_commission_amount) }
  }))
  return rows as unknown as CommissionSettlementHeader[]
}

export async function getCommissionSettlements(params?: { status?: string; seller_bsale_id?: number }): Promise<CommissionSettlementHeader[]> {
  const { companyId } = await getAuthenticatedCompany()
  const db = commissionDb()
  let query = db
    .from('commission_settlements')
    .select(`
      id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at
    `)
    .eq('company_id', companyId)
    .neq('source', 'HISTORICAL')
    .order('created_at', { ascending: false })
  if (params?.status) query = query.eq('status', params.status)
  if (params?.seller_bsale_id) query = query.eq('seller_bsale_id', params.seller_bsale_id)
  const { data, error } = await query
  if (error) throw error
  const rows = await Promise.all((data || []).map(async (row: Record<string, unknown>) => {
    const { count } = await db.from('commission_settlement_lines').select('id', { count: 'exact', head: true }).eq('settlement_id', row.id)
    return { ...row, lines_count: count, seller_bsale_id: Number(row.seller_bsale_id || 0), total_net_amount: Number(row.total_net_amount), total_commission_amount: Number(row.total_commission_amount) }
  }))
  return rows as unknown as CommissionSettlementHeader[]
}

export async function getCommissionSettlementById(settlementId: string): Promise<{
  header: CommissionSettlementHeader
  lines: CommissionSettlementLine[]
}> {
  const { companyId } = await getAuthenticatedCompany()
  const db = commissionDb()

  const { data: headerData, error: headerError } = await db
    .from('commission_settlements')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', settlementId)
    .single()
  if (headerError) throw headerError

  const { data: linesData, error: linesError } = await db
    .from('commission_settlement_lines')
    .select('*')
    .eq('settlement_id', settlementId)
    .order('line_type', { ascending: true })
    .order('invoice_bsale_id', { ascending: true })
    .order('sku', { ascending: true })
  if (linesError) throw linesError

  const lines: CommissionSettlementLine[] = (linesData || []).map((line: Record<string, unknown>) => ({
    ...line,
    quantity: Number(line.quantity),
    net_amount: Number(line.net_amount),
    commission_amount: line.commission_amount ? Number(line.commission_amount) : null,
    commission_percent: line.commission_percent ? Number(line.commission_percent) : null,
    invoice_bsale_id: line.invoice_bsale_id ? Number(line.invoice_bsale_id) : null,
    invoice_number: line.invoice_number ? Number(line.invoice_number) : null,
    metadata: typeof line.metadata === 'object' ? line.metadata : {},
  })) as CommissionSettlementLine[]

  const header: CommissionSettlementHeader = {
    ...headerData,
    lines_count: lines.length,
    seller_bsale_id: Number(headerData.seller_bsale_id || 0),
    total_net_amount: Number(headerData.total_net_amount),
    total_commission_amount: Number(headerData.total_commission_amount),
  } as CommissionSettlementHeader

  return { header, lines }
}

export async function cancelCommissionSettlementDraft(input: { settlement_id: string; reason: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!input.reason.trim()) throw new Error('Debes indicar un motivo de cancelación')

  const { data, error } = await commissionDb().rpc('cancel_commission_settlement_draft', {
    p_company_id: companyId,
    p_user_id: userId,
    p_settlement_id: input.settlement_id,
    p_reason: input.reason,
  })
  if (error) throw error
  const result = data as { success: boolean; error?: string }
  if (!result.success) throw new Error(result.error || 'Error al cancelar borrador')
}

export async function issueCommissionSettlement(input: { settlement_id: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()

  const { data, error } = await commissionDb().rpc('issue_commission_settlement', {
    p_company_id: companyId,
    p_user_id: userId,
    p_settlement_id: input.settlement_id,
  })
  if (error) throw error
  const result = data as { success: boolean; settlement_number?: number; settlement_code?: string; error?: string }
  if (!result.success) throw new Error(result.error || 'Error al emitir liquidación')

  return { settlement_number: result.settlement_number!, settlement_code: result.settlement_code! }
}

export async function exportCommissionSettlementPdf(settlementId: string): Promise<{ base64: string; filename: string }> {
  const { companyId } = await getAuthenticatedCompany()
  const { header, lines } = await getCommissionSettlementById(settlementId)
  if (header.company_id !== companyId) throw new Error('No tienes acceso a esta liquidación')

  const { generateCommissionSettlementPdfBlob } = await import('@/lib/pdf/generate-commission-settlement-pdf')

  let logoBase64: string | undefined
  try {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const logoPath = join(process.cwd(), 'public', 'logo-transparent.png')
    logoBase64 = `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`
  } catch { /* proceed without logo */ }

  const blob = generateCommissionSettlementPdfBlob(header, lines, logoBase64, 'DISTRIBUIDORA MYM')
  const buffer = Buffer.from(await blob.arrayBuffer())
  const suffix = header.status === 'DRAFT' ? 'borrador' : header.status === 'ISSUED' ? 'emitida' : 'anulada'
  const filename = `liquidacion_comisiones_${header.settlement_code || 'borrador'}_${suffix}.pdf`

  return { base64: buffer.toString('base64'), filename }
}

export async function exportCommissionSettlementXlsx(settlementId: string): Promise<{ base64: string; filename: string }> {
  const { companyId } = await getAuthenticatedCompany()
  const { header, lines } = await getCommissionSettlementById(settlementId)
  if (header.company_id !== companyId) throw new Error('No tienes acceso a esta liquidación')

  const XLSX = await import('xlsx')
  const statusLabel = header.status === 'DRAFT' ? 'Borrador' : header.status === 'ISSUED' ? 'Emitida' : 'Anulada'

  const data = lines.map(line => ({
    'Estado': statusLabel,
    'Código': header.settlement_code || '',
    'Vendedor': header.seller_name || '',
    'Período': header.period_label || '',
    'Factura original': String(line.original_invoice_number || line.invoice_number || ''),
    'Cliente': line.customer_name || '',
    'Pago': line.payment_completed_at || '',
    'Tipo línea': line.line_type === 'CREDIT_NOTE' ? 'Nota de crédito' : 'Factura',
    'Origen': line.line_type === 'CREDIT_NOTE' ? `NC ${line.source_document_number || ''}` : 'Factura',
    'SKU': line.sku || '',
    'Producto': line.product_name || '',
    'Proveedor': line.supplier_name || '',
    'Cantidad': Number(line.quantity),
    'Neto': Number(line.net_amount),
    'Regla': line.rule_id || 'General',
    '%': line.commission_percent != null ? Number(line.commission_percent) : null,
    'Comisión': Number(line.commission_amount || 0),
    'Motivo NC': ((line.metadata as Record<string, unknown>)?.adjustment_reason as string) || '',
    'Doc. origen ID': line.source_document_bsale_id != null ? Number(line.source_document_bsale_id) : null,
    'Detalle origen ID': line.source_document_line_id || '',
  }))

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(data)
  const colWidths = Object.keys(data[0] || {}).map(k => ({ wch: Math.max(k.length, 20) }))
  ws['!cols'] = colWidths
  XLSX.utils.book_append_sheet(wb, ws, 'Detalle')

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' })
  const suffix = header.status === 'DRAFT' ? 'borrador' : header.status === 'ISSUED' ? 'emitida' : 'anulada'
  const filename = `liquidacion_comisiones_${header.settlement_code || 'borrador'}_${suffix}_detalle.xlsx`

  return { base64: wbout, filename }
}

export async function getCommissionAnnulledSettlements(): Promise<CommissionSettlementHeader[]> {
  const { companyId } = await getAuthenticatedCompany()
  const db = commissionDb()
  const { data, error } = await db
    .from('commission_settlements')
    .select(`id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at,
      cancelled_at, cancellation_reason`)
    .eq('company_id', companyId)
    .eq('status', 'CANCELLED')
    .neq('source', 'HISTORICAL')
    .not('issued_at', 'is', null)
    .order('cancelled_at', { ascending: false })
  if (error) throw error
  const rows = await Promise.all((data || []).map(async (row: Record<string, unknown>) => {
    const { count } = await db.from('commission_settlement_lines').select('id', { count: 'exact', head: true }).eq('settlement_id', row.id)
    return { ...row, lines_count: count, seller_bsale_id: Number(row.seller_bsale_id || 0), total_net_amount: Number(row.total_net_amount), total_commission_amount: Number(row.total_commission_amount) }
  }))
  return rows as unknown as CommissionSettlementHeader[]
}

export async function annulCommissionSettlement(input: { settlement_id: string; reason: string }) {
  const { companyId, userId } = await getAuthenticatedCompany()
  if (!input.reason.trim()) throw new Error('El motivo de anulación es obligatorio')

  const { data, error } = await commissionDb().rpc('annul_commission_settlement', {
    p_company_id: companyId,
    p_settlement_id: input.settlement_id,
    p_user_id: userId,
    p_reason: input.reason,
  })
  if (error) throw error
  const result = data as { success: boolean; released_lines?: number; error?: string }
  if (!result.success) throw new Error(result.error || 'Error al anular liquidación')

  return { released_lines: result.released_lines || 0 }
}
