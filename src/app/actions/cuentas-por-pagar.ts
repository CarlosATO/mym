'use server'

import { revalidatePath } from 'next/cache'
import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import type { ReceiptInvoiceCandidate } from '@/modules/cuentas-por-pagar/types'

const CAYLO = 'd1000000-0000-0000-0000-000000000001'

async function authorizedClient() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || await getActiveCompanyId(user) !== CAYLO) throw new Error('Seleccione Caylo y acceda con un usuario autorizado.')
  return supabase.schema('public')
}

export async function getReceiptInvoiceCandidates(): Promise<ReceiptInvoiceCandidate[]> {
  const db = await authorizedClient()
  const rows: ReceiptInvoiceCandidate[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.rpc('cxp_receipt_candidates').range(offset, offset + pageSize - 1)
    if (error) throw new Error('No se pudo cargar la bandeja de facturas o no tiene acceso.')
    const page = (data ?? []) as ReceiptInvoiceCandidate[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

export async function incorporateReceiptInvoices(ids: string[]): Promise<{ count: number }> {
  const db = await authorizedClient()
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('Seleccione entre 1 y 100 facturas válidas.')
  }
  const { data, error } = await db.rpc('cxp_incorporate_receipts', { p_candidate_ids: ids })
  if (error) throw new Error('No se pudieron incorporar las facturas. Actualice la bandeja y revise los datos.')
  revalidatePath('/dashboard/cuentas-por-pagar')
  return { count: Number(data) }
}
