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
