'use server'

import { createClient } from '@/lib/supabase/server'

export type SalesOrderPreparationCardInfo = {
  card_id: string
  company_id: string
  status: string
  priority: number
  assigned_user_id: string | null
  route_date: string | null
  normalized_city: string | null
  nv_bsale_id: number
  nv_folio: string
  nv_emission_date: string
  nv_generation_date: string
  client_name: string
  city_raw: string | null
  municipality_raw: string | null
  address_raw: string | null
  seller_bsale_id: number | null
  seller_name: string | null
  total_quantity: number
  total_amount: number | null
  invoice_folio: string | null
  is_invoiced: boolean
  created_at: string
  updated_at: string
}

export type SalesOrderPreparationItem = {
  id: string
  company_id: string
  bsale_document_id: number
  variant_id: number | null
  sku: string | null
  product_name: string
  quantity: number
  net_amount: number | null
  tax_amount: number | null
  total_amount: number | null
}

export type PreviewCandidatesResult = {
  total_candidates: number
  already_materialized: number
  pending_to_create: number
}

export async function getSalesOrderPreparationBoard(companyId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .schema('logistica')
    .from('vw_sales_order_preparation_board')
    .select('*')
    .eq('company_id', companyId)
    .order('priority', { ascending: false })
    .order('nv_emission_date', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationBoard error:', error)
    return { data: [], error: error.message }
  }

  return { data: data as SalesOrderPreparationCardInfo[], error: null }
}

export async function getSalesOrderPreparationItems(companyId: string, bsaleNvId: number) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .schema('integraciones')
    .from('vw_bsale_sales_order_items_for_preparation')
    .select('*')
    .eq('company_id', companyId)
    .eq('bsale_document_id', bsaleNvId)
    .order('product_name', { ascending: true })

  if (error) {
    console.error('getSalesOrderPreparationItems error:', error)
    return { data: [], error: error.message }
  }

  return { data: data as SalesOrderPreparationItem[], error: null }
}

export async function previewSalesOrderPreparationCandidates(companyId: string, fromDate: string, toDate: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .rpc('preview_sales_order_preparation_candidates', {
      p_company_id: companyId,
      p_from_date: fromDate,
      p_to_date: toDate
    })

  if (error) {
    console.error('previewSalesOrderPreparationCandidates error:', error)
    return { data: null, error: error.message }
  }

  const result: PreviewCandidatesResult = {
    total_candidates: data?.[0]?.total_candidates ?? 0,
    already_materialized: data?.[0]?.already_materialized ?? 0,
    pending_to_create: data?.[0]?.pending_to_create ?? 0
  }

  return { data: result, error: null }
}
