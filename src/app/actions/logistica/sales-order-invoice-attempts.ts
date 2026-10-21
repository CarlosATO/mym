'use server'

import { requireWmsPermission } from './authorization'
import { createClient } from '@/lib/supabase/server'

const PREPARE_PERMISSION = 'logistica.preparation.manage'

export async function prevalidateSalesOrderInvoiceAttempt(cardId: string) {
  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('invoice_attempt_prevalidate', { p_company_id: auth.companyId, p_card_id: cardId })
  return { data, error: error?.message ?? null }
}

export async function prepareSalesOrderInvoiceAttempt(cardId: string) {
  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('prepare_sales_order_invoice_attempt', { p_company_id: auth.companyId, p_card_id: cardId })
  return { data, error: error?.message ?? null }
}

export async function getSalesOrderInvoiceAttempt(attemptId: string) {
  await requireWmsPermission('module.logistica.view')
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('get_sales_order_invoice_attempt', { p_attempt_id: attemptId })
  return { data: data?.[0] ?? null, error: error?.message ?? null }
}

export async function reconcileSalesOrderInvoiceAttempt(attemptId: string) {
  await requireWmsPermission('module.logistica.view')
  const db = await createClient()
  const { data, error } = await db.schema('logistica').rpc('reconcile_sales_order_invoice_attempt', { p_attempt_id: attemptId })
  return { data, error: error?.message ?? null }
}
