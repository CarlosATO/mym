'use server'

import { requireWmsPermission } from './authorization'
import { createClient } from '@/lib/supabase/server'
import { bsaleFetchForCompany, bsaleFetchResourceForCompany } from '@/lib/bsale/client'
import { evaluateInvoiceCommercialValidation } from '@/lib/integraciones/invoice-commercial-validation'
import type { InvoiceCommercialSelection } from '@/modules/logistica/preparacion-pedidos/invoice-commercial'

const PREPARE_PERMISSION = 'logistica.preparation.manage'

function summarizeReadError(error: { code?: string; message?: string } | null) {
  const message = error?.message ?? ''
  return {
    code: error?.code ?? null,
    isRls: error?.code === '42501' || /row-level security|permission denied/i.test(message),
  }
}

/** Local-only read path. It intentionally has no write-client or attempt RPC imports. */
export async function diagnoseSalesOrderInvoiceCommercial(cardId: string, selection: InvoiceCommercialSelection | null) {
  if (process.env.NODE_ENV === 'production') return { data: null, error: 'LOCAL_ONLY_DIAGNOSTIC' as const }

  const auth = await requireWmsPermission(PREPARE_PERMISSION)
  const db = await createClient()
  const { data: prevalidation, error: prevalidationError } = await db.schema('logistica').rpc('invoice_attempt_prevalidate', { p_company_id: auth.companyId, p_card_id: cardId })
  const { data: card, error: cardError } = await db.schema('logistica').from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', cardId).eq('company_id', auth.companyId).maybeSingle()
  if (prevalidationError || cardError || !card) return { data: null, error: prevalidationError?.message ?? cardError?.message ?? 'No se encontró la card.' }

  const currentNvId = Number(prevalidation?.current_bsale_nv_id ?? card.current_bsale_nv_id)
  const [nv, sellers, paymentTypes, saleConditions] = await Promise.all([
    bsaleFetchResourceForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/documents/${currentNvId}.json`, params: { expand: 'details,payments' } }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/documents/${currentNvId}/sellers.json` }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: '/payment_types.json', params: { state: 0 } }),
    bsaleFetchForCompany<Record<string, any>>({ companyId: auth.companyId, path: '/sale_conditions.json', params: { state: 0 } }),
  ])
  const clientId = Number(nv.client?.id)
  const [client, { data: syncedClient, error: syncedClientError }] = await Promise.all([
    bsaleFetchResourceForCompany<Record<string, any>>({ companyId: auth.companyId, path: `/clients/${clientId}.json` }),
    db.schema('integraciones').from('bsale_clients').select('payment_type_id').eq('company_id', auth.companyId).eq('bsale_client_id', clientId).maybeSingle(),
  ])
  const result = evaluateInvoiceCommercialValidation({
    currentNvId,
    nv,
    sellers,
    paymentTypes,
    saleConditions,
    client,
    clientError: false,
    syncedClientError: Boolean(syncedClientError),
    paymentTypeId: syncedClient?.payment_type_id == null ? null : Number(syncedClient.payment_type_id),
    selection,
  })

  return {
    data: {
      card: { id: card.id, status: card.status, currentNvId },
      prevalidationReady: prevalidation?.ready === true,
      selection,
      document: { id: nv.id ?? null, typeId: nv.document_type?.id ?? null, state: nv.state ?? null, clientId, officeId: nv.office?.id ?? null, priceListId: nv.priceList?.id ?? null },
      sellerCount: Array.isArray(sellers.items) ? sellers.items.length : null,
      catalogCounts: { paymentTypes: Array.isArray(paymentTypes.items) ? paymentTypes.items.length : null, saleConditions: Array.isArray(saleConditions.items) ? saleConditions.items.length : null },
      readErrors: {
        client: summarizeReadError(null),
        syncedClient: summarizeReadError(syncedClientError),
      },
      validation: result,
    },
    error: null,
  }
}
