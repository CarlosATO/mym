'use server'

import { createClient } from '@supabase/supabase-js'
import { bsaleFetchAll, normalizeSku, getBsaleHeaders } from '@/lib/bsale/client'
import { syncBsaleClients } from '@/lib/integraciones/bsale-clients-sync'
import crypto from 'crypto'

const BSALE_API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function integrDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function comercialDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'comercial' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface SyncRun {
  id: string
  company_id: string
  started_at?: string
}

type BsaleDocumentForSellerSync = {
  id: number
  number?: number | null
  documentTypeId?: number | null
  document_type?: { id?: number | string | null } | null
}

type BsaleDocumentSeller = {
  id?: number | string | null
  name?: string | null
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  office?: { id?: number | string | null } | null
  percent?: number | null
  percentage?: number | null
  amount?: number | null
  commissionAmount?: number | null
}

type BsaleDocumentSellersResponse = {
  items?: BsaleDocumentSeller[]
}

type BsalePaymentType = {
  id?: number | string | null
  name?: string | null
  state?: number | null
}

type BsalePaymentDocument = {
  id?: number | string | null
  amount?: number | string | null
}

type BsalePayment = {
  id?: number | string | null
  amount?: number | string | null
  recordDate?: number | null
  createdAt?: number | null
  state?: number | null
  operationNumber?: string | null
  checkDate?: string | null
  checkNumber?: number | string | null
  isCreditPayment?: number | boolean | null
  paymentsRelation?: string | null
  payment_type?: { id?: number | string | null; href?: string | null } | null
  document?: { id?: number | string | null; href?: string | null } | null
  documents?: BsalePaymentDocument[] | null
}

type BsalePaymentsSyncOptions = {
  recordDateFrom?: Date | number | string
  recordDateTo?: Date | number | string
  days?: number
  mode?: 'incremental' | 'backfill'
}

type BsalePaymentTypeRecord = {
  company_id: string
  bsale_id: number
  bsale_payment_type_id: number
  name: string | null
  is_active: boolean
  raw_json: BsalePaymentType
  synced_at: string
  updated_at: string
}

type BsalePaymentRecord = {
  company_id: string
  bsale_id: number
  bsale_payment_id: number
  bsale_document_id: number | null
  amount: number | null
  payment_date: string | null
  record_date: string | null
  payment_type_id: number | null
  payment_type_bsale_id: number | null
  payment_type_name: string | null
  is_credit_payment: boolean
  state: number | null
  created_at_bsale: string | null
  operation_number: string | null
  check_date: string | null
  check_number: number | null
  raw_json: BsalePayment
  synced_at: string
  updated_at: string
}

type BsaleDocumentPaymentRecord = {
  company_id: string
  bsale_payment_id: number
  bsale_document_id: number
  document_type_id: number | null
  document_number: number | null
  client_id: number | null
  payment_record_date: string | null
  amount_applied: number
  raw_json: { payment: BsalePayment; document: BsalePaymentDocument | BsalePayment['document'] | null }
  synced_at: string
  updated_at: string
}

type BsaleDocumentSellerRecord = {
  company_id: string
  bsale_document_id: number
  document_type_id: number | null
  document_number: number | null
  seller_bsale_id: number
  seller_name: string | null
  seller_first_name: string | null
  seller_last_name: string | null
  seller_email: string | null
  seller_office: string | null
  seller_percent: number | null
  seller_amount: number | null
  is_primary: boolean
  source: string
  raw_payload: { document_sellers: BsaleDocumentSellersResponse | null; seller: BsaleDocumentSeller }
  payload_hash: string
  last_sync_at: string
  updated_at: string
}

async function createSyncRun(companyId: string, trigger: string = 'MANUAL'): Promise<SyncRun> {
  const db = integrDb()
  const { data, error } = await db
    .from('bsale_sync_runs')
    .insert({
      company_id: companyId,
      status: 'STARTED',
      trigger,
    })
    .select('id, company_id, started_at')
    .single()

  if (error) throw new Error(`Error creando sync run: ${error.message}`)
  return data
}

async function finishSyncRun(
  runId: string,
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
  counts: Record<string, number>,
  errorMessage?: string
) {
  const db = integrDb()
  const update: any = {
    status,
    completed_at: new Date().toISOString(),
    error_message: errorMessage || null,
  }
  if (counts.products !== undefined) update.products_count = counts.products
  if (counts.variants !== undefined) update.variants_count = counts.variants
  if (counts.stocks !== undefined) update.stocks_count = counts.stocks
  if (counts.costs !== undefined) update.costs_count = counts.costs
  if (counts.documents !== undefined) update.documents_count = counts.documents
  if (counts.document_details_count !== undefined) update.document_details_count = counts.document_details_count

  await db.from('bsale_sync_runs').update(update).eq('id', runId)
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function epochToIso(value: unknown): string | null {
  const parsed = toNumber(value)
  return parsed !== null ? new Date(parsed * 1000).toISOString() : null
}

function epochToDate(value: unknown): string | null {
  const iso = epochToIso(value)
  return iso ? iso.slice(0, 10) : null
}

function dateInputToDate(value: Date | number | string): Date {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value * 1000)
  return new Date(value)
}

function dateToBsaleEpochDay(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000)
}

function eachUtcDay(from: Date, to: Date) {
  const days: number[] = []
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()))
  while (cursor <= end) {
    days.push(dateToBsaleEpochDay(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function isInitialCreditPayment(payment: BsalePayment, paymentTypeName: string | null) {
  return !asBoolean(payment.isCreditPayment) && (paymentTypeName || '').trim().toUpperCase() === 'CREDITO'
}

// ─── Extract XML References ───────────────────────────────────────
export async function extractBsaleDocumentReferencesFromXml(xml: string) {
  const references: Array<{
    NroLinRef: string | null
    TpoDocRef: string | null
    FolioRef: string | null
    FchRef: string | null
    CodRef: string | null
    RazonRef: string | null
  }> = []
  if (!xml) return references

  const refMatches = xml.match(/<Referencia>[\s\S]*?<\/Referencia>/g)
  if (!refMatches) return references

  for (const refBlock of refMatches) {
    const getValue = (tag: string) => {
      const match = refBlock.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`))
      return match ? match[1].trim() : null
    }

    references.push({
      NroLinRef: getValue('NroLinRef'),
      TpoDocRef: getValue('TpoDocRef'),
      FolioRef: getValue('FolioRef'),
      FchRef: getValue('FchRef'),
      CodRef: getValue('CodRef'),
      RazonRef: getValue('RazonRef'),
    })
  }

  return references
}


// ─── Sync functions ───────────────────────────────────────────────

async function syncProductTypes(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/product_types.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((p: any) => ({
        company_id: companyId,
        bsale_id: p.id,
        name: p.name || '',
        state: p.state ?? null,
        raw_json: p,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_product_types').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncProductTypes] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}


async function syncProducts(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/products.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((p: any) => ({
        company_id: companyId,
        bsale_id: p.id,
        name: p.name || '',
        description: p.description || null,
        classification: p.classification ?? null,
        stock_control: p.stockControl === 1,
        state: p.state ?? null,
        product_type_id: p.product_type?.id ? Number(p.product_type.id) : null,
        raw_json: p,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_products').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncProducts] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

async function syncVariants(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/variants.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((v: any) => ({
        company_id: companyId,
        bsale_id: v.id,
        bsale_product_id: v.product?.id ? Number(v.product.id) : 0,
        code: normalizeSku(v.code || ''),
        description: v.description || null,
        bar_code: v.barCode || null,
        state: v.state ?? null,
        unlimited_stock: v.unlimitedStock === 1,
        allow_negative_stock: v.allowNegativeStock === 1,
        raw_json: v,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_variants').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncVariants] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

async function syncStock(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/stocks.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((s: any) => ({
        company_id: companyId,
        bsale_id: s.id,
        variant_id: s.variant?.id ? Number(s.variant.id) : 0,
        variant_code: null,
        quantity: s.quantity ?? 0,
        quantity_reserved: s.quantityReserved ?? 0,
        quantity_available: s.quantityAvailable ?? 0,
        office_id: s.office?.id ? Number(s.office.id) : null,
        raw_json: s,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      // Enrich with variant_code from bsale_variants
      const variantIds = [...new Set(records.map(r => r.variant_id).filter(Boolean))]
      if (variantIds.length > 0) {
        const { data: variants } = await db
          .from('bsale_variants')
          .select('bsale_id, code')
          .in('bsale_id', variantIds)
          .eq('company_id', companyId)

        const codeMap = new Map((variants || []).map((v: any) => [v.bsale_id, v.code]))
        for (const r of records) {
          r.variant_code = codeMap.get(r.variant_id) || null
        }
      }

      const { error } = await db.from('bsale_stock_current').upsert(records, {
        onConflict: 'company_id, variant_id, office_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncStock] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

// ─── Sync Costs ────────────────────────────────────────────────────

async function syncSellers(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  await bsaleFetchAll<any>('/users.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((s: any) => ({
        company_id: companyId,
        bsale_id: s.id,
        name: s.firstName ? `${s.firstName} ${s.lastName || ''}`.trim() : s.name || '',
        email: s.email || null,
        active: s.state === 0,
        raw_json: s,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_sellers').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncSellers] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

function resolveDocumentTypeId(doc: BsaleDocumentForSellerSync) {
  return doc.documentTypeId ?? (doc.document_type?.id != null ? Number(doc.document_type.id) : null)
}

function normalizeDocumentSellerName(seller: BsaleDocumentSeller) {
  return [seller?.firstName, seller?.lastName].filter(Boolean).join(' ').trim() || seller?.name || null
}

async function fetchDocumentSellers(docId: number) {
  const response = await fetch(`${BSALE_API_BASE}/documents/${docId}/sellers.json`, {
    method: 'GET',
    headers: getBsaleHeaders(),
    signal: AbortSignal.timeout(20000),
  })

  if (response.status === 404 || response.status === 400) return { items: [], raw: null }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${body.substring(0, 120)}`)
  }

  const raw = await response.json() as BsaleDocumentSellersResponse
  return { items: raw?.items || [], raw }
}

export async function syncDocumentSellersForDocuments(companyId: string, documents: BsaleDocumentForSellerSync[]) {
  const db = integrDb()
  const relevantDocuments = documents.filter(doc => [2, 5, 23].includes(Number(resolveDocumentTypeId(doc))))
  let upserted = 0
  let errors = 0
  let empty = 0
  const records: BsaleDocumentSellerRecord[] = []

  for (const doc of relevantDocuments) {
    try {
      const { items, raw } = await fetchDocumentSellers(doc.id)
      if (!items.length) {
        empty++
        continue
      }

      items.forEach((seller, index) => {
        const sellerId = Number(seller?.id)
        if (!Number.isFinite(sellerId)) return
        const rawPayload = { document_sellers: raw, seller }
        records.push({
          company_id: companyId,
          bsale_document_id: doc.id,
          document_type_id: resolveDocumentTypeId(doc),
          document_number: doc.number ?? null,
          seller_bsale_id: sellerId,
          seller_name: normalizeDocumentSellerName(seller),
          seller_first_name: seller?.firstName || null,
          seller_last_name: seller?.lastName || null,
          seller_email: seller?.email || null,
          seller_office: seller?.office?.id != null ? String(seller.office.id) : null,
          seller_percent: seller?.percent ?? seller?.percentage ?? null,
          seller_amount: seller?.amount ?? seller?.commissionAmount ?? null,
          is_primary: index === 0,
          source: 'documents_sellers_endpoint',
          raw_payload: rawPayload,
          payload_hash: crypto.createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex'),
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      })
    } catch (error: unknown) {
      errors++
      console.error(`[syncDocumentSellers] doc ${doc.id} error:`, error instanceof Error ? error.message : error)
    }
  }

  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100)
    const { error } = await db.from('bsale_document_sellers').upsert(batch, {
      onConflict: 'company_id,bsale_document_id,seller_bsale_id',
      ignoreDuplicates: false,
    })
    if (error) {
      errors += batch.length
      console.error('[syncDocumentSellers] upsert error:', error.message)
    } else {
      upserted += batch.length
    }
  }

  return { scanned: relevantDocuments.length, upserted, empty, errors }
}

function cleanCodeForSync(code: any): string | null {
  if (!code || typeof code !== 'string') return null
  const cleaned = code.replace(/[^0-9kK]/g, '').toUpperCase()
  return cleaned === '' ? null : cleaned
}

function resolveBusinessNameForSync(client: any): string {
  if (client.company && client.company.trim() !== '') return client.company.trim()
  const first = client.firstName ? client.firstName.trim() : ''
  const last = client.lastName ? client.lastName.trim() : ''
  const full = `${first} ${last}`.trim()
  if (full !== '') return full
  return `Cliente Bsale ${client.id}`
}

async function syncCommercialCustomerFromHydratedClient(companyId: string, client: any) {
  const db = comercialDb()
  const bsaleClientId = client.id
  const rut = client.code || null
  const record = {
    company_id: companyId,
    bsale_client_id: bsaleClientId,
    source: 'BSALE',
    rut,
    rut_clean: cleanCodeForSync(rut),
    business_name: resolveBusinessNameForSync(client),
    fantasy_name: null,
    email: (client.email && client.email.trim() !== '') ? client.email.trim().toLowerCase() : null,
    phone: client.phone ? client.phone.trim() : null,
    mobile: null,
    address: client.address ? client.address.trim() : null,
    city: client.city ? client.city.trim() : null,
    commune: client.municipality ? client.municipality.trim() : null,
    region: client.city || null,
    business_activity: client.activity || null,
    credit_limit: client.maxCredit ? parseFloat(client.maxCredit) : null,
    is_active: client.state === 0,
    last_bsale_sync_at: new Date().toISOString(),
  }

  const { data: existing, error: fetchErr } = await db
    .from('customers')
    .select('id, notes, fantasy_name')
    .eq('company_id', companyId)
    .eq('source', 'BSALE')
    .eq('bsale_client_id', bsaleClientId)
    .maybeSingle()

  if (fetchErr) throw fetchErr

  if (existing) {
    const { error: updateErr } = await db
      .from('customers')
      .update({
        ...record,
        notes: existing.notes,
        fantasy_name: existing.fantasy_name || record.fantasy_name,
      })
      .eq('id', existing.id)

    if (updateErr) throw updateErr
    return
  }

  const { error: insertErr } = await db.from('customers').insert(record)
  if (insertErr) throw insertErr
}

async function hydrateOrphanClients(companyId: string, runId: string): Promise<{ hydrated: number; errors: number; orphanIds: number[] }> {
  const db = integrDb()
  let hydrated = 0
  let errors = 0

  const { data: docClients } = await db
    .from('bsale_documents')
    .select('client_id')
    .not('client_id', 'is', null)
    .eq('company_id', companyId)

  const { data: existingClients } = await db
    .from('bsale_clients')
    .select('bsale_client_id')
    .eq('company_id', companyId)

  const existingSet = new Set((existingClients || []).map((c: any) => c.bsale_client_id))
  const orphanIds = [...new Set((docClients || []).map((d: any) => d.client_id).filter((id: number) => !existingSet.has(id)))]

  if (orphanIds.length === 0) return { hydrated: 0, errors: 0, orphanIds: [] }

  console.log(`[hydrateOrphanClients] Found ${orphanIds.length} orphan client_ids: ${orphanIds.join(', ')}`)

  for (const clientId of orphanIds) {
    try {
      const url = `${process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'}/clients/${clientId}.json`
      const response = await fetch(url, {
        method: 'GET',
        headers: getBsaleHeaders(),
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`[hydrateOrphanClients] Client ${clientId} not found in Bsale (404), skipping`)
          errors++
          continue
        }
        console.error(`[hydrateOrphanClients] HTTP ${response.status} for client ${clientId}`)
        errors++
        continue
      }

      const client = await response.json()
      const rut = client.code
      const cleanedRut = cleanCodeForSync(rut)
      const businessName = resolveBusinessNameForSync(client)
      const email = (client.email && client.email.trim() !== '') ? client.email.trim().toLowerCase() : null
      const phone = client.phone ? client.phone.trim() : null
      const address = client.address ? client.address.trim() : null
      const city = client.city ? client.city.trim() : null
      const commune = client.municipality ? client.municipality.trim() : null
      const creditLimit = client.maxCredit ? parseFloat(client.maxCredit) : null
      const hash = crypto.createHash('md5').update(JSON.stringify(client)).digest('hex')

      const record = {
        company_id: companyId,
        bsale_client_id: clientId,
        code: rut,
        code_clean: cleanedRut,
        business_name: businessName,
        first_name: client.firstName || null,
        last_name: client.lastName || null,
        email,
        phone,
        mobile: null,
        address,
        city,
        commune,
        region: null,
        district: null,
        activity: client.activity || null,
        company: client.company || null,
        client_type: null,
        price_list_id: client.price_list?.id || null,
        payment_type_id: client.payment_type?.id || null,
        credit_limit: creditLimit,
        credit_days: null,
        is_active_bsale: client.state === 0,
        raw_payload: client,
        payload_hash: hash,
        last_seen_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
      }

      const { error: upsertErr } = await db
        .from('bsale_clients')
        .upsert(record, { onConflict: 'company_id, bsale_client_id', ignoreDuplicates: false })

      if (upsertErr) {
        console.error(`[hydrateOrphanClients] Error upserting client ${clientId}: ${upsertErr.message}`)
        errors++
        continue
      }

      try {
        await syncCommercialCustomerFromHydratedClient(companyId, client)
      } catch (commercialErr: any) {
        console.error(`[hydrateOrphanClients] Error syncing commercial customer ${clientId}: ${commercialErr.message}`)
        errors++
        continue
      }

      hydrated++
      console.log(`[hydrateOrphanClients] Hydrated client ${clientId}: ${businessName}`)
    } catch (err: any) {
      console.error(`[hydrateOrphanClients] Error processing client ${clientId}: ${err.message}`)
      errors++
    }
  }

  console.log(`[hydrateOrphanClients] Done: ${hydrated} hydrated, ${errors} errors`)
  return { hydrated, errors, orphanIds }
}


async function getVariantCost(bsaleVariantId: number): Promise<{
  averageCost: number
  totalCost: number
  parsedHistory: any[]
  raw: any
} | null> {
  try {
    const url = `${BSALE_API_BASE}/variants/${bsaleVariantId}/costs.json`
    const response = await fetch(url, {
      method: 'GET',
      headers: getBsaleHeaders(),
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()
    return {
      averageCost: Number(data.averageCost) || 0,
      totalCost: Number(data.totalCost) || 0,
      parsedHistory: (data.history || []).map((h: any) => ({
        admissionDate: h.admissionDate ? new Date(h.admissionDate * 1000).toISOString() : null,
        cost: Number(h.cost) || 0,
        quantity: Number(h.quantity) || 0,
      })),
      raw: data,
    }
  } catch {
    return null
  }
}

async function syncCosts(companyId: string, runId: string): Promise<{
  processed: number
  withCost: number
  zeroCost: number
  errors: number
}> {
  const db = integrDb()
  let processed = 0
  let withCost = 0
  let zeroCost = 0
  let errors = 0
  let errorDetails: string[] = []

  // Get all variant bsale_ids
  // Fetch all variants paginated (REST API default limit is 1000)
  let allVariants: any[] = []
  let from = 0
  const pageSize = 1000

  while (true) {
    const { data: page, error } = await db
      .from('bsale_variants')
      .select('bsale_id, code')
      .eq('company_id', companyId)
      .not('bsale_id', 'is', null)
      .range(from, from + pageSize - 1)

    if (error) {
      console.error('[syncCosts] Error fetching variants:', error.message)
      break
    }
    if (!page || page.length === 0) break
    allVariants = allVariants.concat(page)
    if (page.length < pageSize) break
    from += pageSize
  }

  const variants = allVariants

  if (!variants || variants.length === 0) {
    console.log('[syncCosts] No variants found to process')
    return { processed: 0, withCost: 0, zeroCost: 0, errors: 0 }
  }

  console.log(`[syncCosts] Processing ${variants.length} variants...`)
  const CONCURRENCY = 5

  // Process in batches with controlled concurrency
  for (let i = 0; i < variants.length; i += CONCURRENCY) {
    const batch = variants.slice(i, i + CONCURRENCY)
    const promises = batch.map(async (v: any) => {
      const variantId = Number(v.bsale_id)
      if (!variantId) return

      const cost = await getVariantCost(variantId)
      processed++

      if (!cost) {
        zeroCost++
        return
      }

      const { error } = await db.from('bsale_variant_costs').upsert(
        {
          company_id: companyId,
          variant_id: variantId,
          variant_code: v.code || null,
          average_cost: cost.averageCost,
          total_cost: cost.totalCost,
          cost_history: cost.parsedHistory.length > 0 ? cost.parsedHistory : null,
          raw_json: cost.raw,
          bsale_sync_run_id: runId,
          synced_at: new Date().toISOString(),
        },
        {
          onConflict: 'company_id, variant_id',
          ignoreDuplicates: false,
        }
      )

      if (error) {
        errors++
        errorDetails.push(`variant ${variantId}: ${error.message}`)
        return
      }

      if (cost.averageCost > 0) withCost++
      else zeroCost++
    })

    await Promise.allSettled(promises)

    if ((i + CONCURRENCY) % 100 < CONCURRENCY || i + CONCURRENCY >= variants.length) {
      console.log(`[syncCosts] Progress: ${Math.min(i + CONCURRENCY, variants.length)}/${variants.length} (ok: ${withCost}, zero: ${zeroCost}, err: ${errors})`)
    }
  }

  if (errorDetails.length > 0 && errorDetails.length <= 5) {
    console.error('[syncCosts] Errors:', errorDetails.join('; '))
  }

  return { processed, withCost, zeroCost, errors }
}

export async function syncBsaleCosts(companyId: string): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id

    console.log('[bsale-sync] Iniciando sync de costos...')
    const result = await syncCosts(companyId, runId)
    console.log(`[bsale-sync] Costos: ${result.processed} procesados, ${result.withCost} con costo, ${result.zeroCost} sin costo, ${result.errors} errores`)

    const counts: Record<string, number> = {
      variant_costs_processed: result.processed,
      variant_costs_with_cost: result.withCost,
      variant_costs_zero: result.zeroCost,
      variant_costs_errors: result.errors,
    }

    await finishSyncRun(runId, 'COMPLETED', {
      costs: result.processed,
      ...counts,
    })

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error en syncCosts:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}

// ─── Sync Sales (Documents + Details) ─────────────────────────────

async function fetchAllDocuments(
  companyId: string,
  runId: string,
  dateFrom: Date,
  dateTo: Date
): Promise<{ documents: any[]; pages: number }> {
  const allDocs: any[] = []
  const LIMIT = 50
  let offset = 0
  let pages = 0
  const rangeEncoded = encodeURIComponent(`[${Math.floor(dateFrom.getTime() / 1000)},${Math.floor(dateTo.getTime() / 1000)}]`)

  while (true) {
    const url = `${BSALE_API_BASE}/documents.json?limit=${LIMIT}&offset=${offset}&emissiondaterange=${rangeEncoded}`
    const response = await fetch(url, {
      method: 'GET',
      headers: getBsaleHeaders(),
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Bsale API error ${response.status} at offset ${offset}: ${body.substring(0, 100)}`)
    }

    const data = await response.json()
    const items = data.items || []
    allDocs.push(...items)
    pages++

    if (items.length < LIMIT) break
    offset += LIMIT
  }

  return { documents: allDocs, pages }
}

async function syncDocuments(
  companyId: string, 
  runId: string, 
  options: { days?: number, dateFrom?: string, dateTo?: string }
): Promise<{
  docsCount: number
  detailsCount: number
  detailErrors: number
  sellerSync: { scanned: number; upserted: number; empty: number; errors: number }
  pages: number
}> {
  const db = integrDb()
  
  let dateTo = new Date()
  let dateFrom = new Date(dateTo.getTime() - (options.days || 180) * 86400000)

  if (options.dateTo) {
    dateTo = new Date(options.dateTo + 'T23:59:59')
  }
  if (options.dateFrom) {
    dateFrom = new Date(options.dateFrom + 'T00:00:00')
  }

  console.log(`[syncSales] Fetching documents from ${dateFrom.toISOString().slice(0, 10)} to ${dateTo.toISOString().slice(0, 10)}`)

  const { documents, pages } = await fetchAllDocuments(companyId, runId, dateFrom, dateTo)
  console.log(`[syncSales] Documents fetched: ${documents.length} in ${pages} pages`)

  // Upsert documents in batches
  let docsCount = 0
  let detailsCount = 0
  let detailErrors = 0

  for (let i = 0; i < documents.length; i += 50) {
    const batch = documents.slice(i, i + 50)
    const records = batch.map((d: any) => ({
      company_id: companyId,
      bsale_id: d.id,
      number: d.number ?? null,
      emission_date: d.emissionDate ? new Date(d.emissionDate * 1000).toISOString().slice(0, 10) : null,
      generation_date: d.generationDate ? new Date(d.generationDate * 1000).toISOString() : null,
      total_amount: d.totalAmount ?? null,
      net_amount: d.netAmount ?? null,
      tax_amount: d.taxAmount ?? null,
      exempt_amount: d.exemptAmount ?? null,
      document_type_id: d.documentTypeId ?? d.document_type?.id ?? null,
      client_id: d.client?.id ?? d.clientId ?? null,
      office_id: d.office?.id ?? d.officeId ?? null,
      state: d.state ?? null,
      tracking_number: d.trackingNumber || null,
      url_pdf: d.urlPdf || null,
      raw_json: d,
      bsale_sync_run_id: runId,
      synced_at: new Date().toISOString(),
    }))

    const { error } = await db.from('bsale_documents').upsert(records, {
      onConflict: 'company_id, bsale_id',
      ignoreDuplicates: false,
    })
    if (error) console.error(`[syncSales] Document batch error:`, error.message)
    else docsCount += records.length
  }

  const sellerSync = await syncDocumentSellersForDocuments(companyId, documents)
  console.log(`[syncSales] Document sellers: scanned=${sellerSync.scanned} upserted=${sellerSync.upserted} empty=${sellerSync.empty} errors=${sellerSync.errors}`)

  // Fetch details with retry + backoff + classification
  console.log(`[syncSales] Fetching details for ${documents.length} documents...`)
  const CONCURRENCY = 3
  const MAX_RETRIES = 3

  interface DetailResult {
    docId: number
    status: 'OK' | 'WITHOUT_DETAILS' | 'ERROR'
    detailCount: number
  }

  const allDocDetails: DetailResult[] = []

  for (let i = 0; i < documents.length; i += CONCURRENCY) {
    const batch = documents.slice(i, i + CONCURRENCY)
    const promises = batch.map(async (doc: any): Promise<DetailResult> => {
      let lastError: string | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 1) {
            const delay = attempt * 2000
            await new Promise(r => setTimeout(r, delay))
          }

          const url = `${BSALE_API_BASE}/documents/${doc.id}/details.json?limit=50`
          const response = await fetch(url, {
            method: 'GET',
            headers: getBsaleHeaders(),
            signal: AbortSignal.timeout(20000),
          })

          if (response.status === 404 || response.status === 400) {
            return { docId: doc.id, status: 'WITHOUT_DETAILS', detailCount: 0 }
          }

          if (response.status === 429) {
            lastError = `HTTP 429 (rate limited)`
            await new Promise(r => setTimeout(r, attempt * 3000))
            continue
          }

          if (!response.ok) {
            lastError = `HTTP ${response.status}`
            continue
          }

          const data = await response.json()
          const details = data.items || []

          if (details.length === 0) {
            return { docId: doc.id, status: 'WITHOUT_DETAILS', detailCount: 0 }
          }

          const detailRecords = details.map((det: any, idx: number) => {
            const vid = det.variant?.id ? Number(det.variant.id) : null
            const vcode = det.variant?.code ? normalizeSku(det.variant.code) : null

            return {
              company_id: companyId,
              bsale_id: det.id,
              bsale_document_id: doc.id,
              line_number: det.lineNumber ?? idx,
              quantity: det.quantity ?? 0,
              net_unit_value: det.netUnitValue ?? det.netUnitValueRaw ?? 0,
              total_unit_value: det.totalUnitValue ?? 0,
              net_amount: det.netAmount ?? 0,
              tax_amount: det.taxAmount ?? 0,
              total_amount: det.totalAmount ?? 0,
              net_discount: det.netDiscount ?? 0,
              variant_id: vid,
              variant_code: vcode,
              variant_description: det.variant?.description || null,
              raw_json: det,
              bsale_sync_run_id: runId,
              synced_at: new Date().toISOString(),
            }
          })

          const { error } = await db.from('bsale_document_details').upsert(detailRecords, {
            onConflict: 'company_id, bsale_id',
            ignoreDuplicates: false,
          })

          if (error) {
            lastError = `DB: ${error.message}`
            continue
          }

          detailsCount += detailRecords.length

          // Fetch XML for references if it is a Credit Note (Type 2 or 61 in SII, bsale internal type 2) and has urlXml
          if (doc.documentTypeId == 2 || doc.document_type?.id == 2) {
             console.log(`[syncSales] NC Detected. Folio: ${doc.number}, urlXml: ${doc.urlXml ? 'YES' : 'NO'}`);
          }

          if ((doc.documentTypeId == 2 || doc.document_type?.id == 2) && doc.urlXml) {
            try {
              console.log(`[syncSales] Fetching XML for NC ${doc.number}...`)
              const xmlRes = await fetch(doc.urlXml, { signal: AbortSignal.timeout(15000) })
              if (xmlRes.ok) {
                const xmlText = await xmlRes.text()
                const refs = await extractBsaleDocumentReferencesFromXml(xmlText)
                if (refs.length > 0) {
                  const refRecords = refs.map((r, i) => {
                    const lineStr = r.NroLinRef || String(i + 1)
                    const folioStr = r.FolioRef || ''
                    const codeStr = r.CodRef || ''
                    const sourceKey = `${doc.id}_${lineStr}_${folioStr}_${codeStr}`
                    return {
                      company_id: companyId,
                      source_key: sourceKey,
                      bsale_document_id: doc.id,
                      line_number: Number(r.NroLinRef) || (i + 1),
                      referenced_document_type: r.TpoDocRef,
                      referenced_document_number: r.FolioRef,
                      reference_code: r.CodRef,
                      reference_reason: r.RazonRef,
                      reference_date: r.FchRef || null,
                      raw_json: r,
                      bsale_sync_run_id: runId,
                      synced_at: new Date().toISOString()
                    }
                  })
                  const { error: dbErr } = await db.from('bsale_document_references').upsert(refRecords, {
                    onConflict: 'company_id, source_key',
                    ignoreDuplicates: false
                  })
                  if (dbErr) {
                    console.error(`[syncSales] DB Error upserting refs for ${doc.id}:`, dbErr.message);
                  } else {
                    console.log(`[syncSales] Successfully upserted ${refRecords.length} references for ${doc.id}`);
                  }
                }
              } else {
                 console.error(`[syncSales] HTTP Error fetching XML for doc ${doc.id}: ${xmlRes.status}`);
              }
            } catch (xmlErr: any) {
              console.error(`[syncSales] Error fetching XML for doc ${doc.id}: ${xmlErr.message}`)
            }
            // Don't fail the entire detail sync if XML fails
          }

          if (doc.document_type?.id === 5) {
            console.log(`[syncSales] Fetching references for Factura ${doc.number}...`)
            try {
              const headers = getBsaleHeaders()
              const refsRes = await fetch(`${BSALE_API_BASE}/documents/${doc.id}/references.json`, { headers })
              if (refsRes.ok) {
                const refsData = await refsRes.json()
                if (refsData && refsData.items && refsData.items.length > 0) {
                  const refRecords = refsData.items.map((r: any) => ({
                    company_id: companyId,
                    bsale_id: r.id,
                    bsale_document_id: doc.id,
                    source_document_type_id: doc.document_type?.id || null,
                    source_document_number: doc.number || null,
                    referenced_document_id: r.referenceDocumentId || null,
                    referenced_document_number: r.number || null,
                    referenced_document_type_id: r.referenceDocumentTypeId || null,
                    reference_code: r.referenceCode || null,
                    reference_reason: r.reason || null,
                    reference_date: r.date ? new Date(r.date * 1000).toISOString() : null,
                    raw_json: r,
                    bsale_sync_run_id: runId,
                    synced_at: new Date().toISOString()
                  }))

                  const { error: dbErr } = await integrDb().from('bsale_document_references').upsert(refRecords, {
                    onConflict: 'company_id, bsale_id'
                  })
                  if (dbErr) {
                    console.error(`[syncSales] DB Error upserting refs for Factura ${doc.id}:`, dbErr.message);
                  } else {
                    console.log(`[syncSales] Successfully upserted ${refRecords.length} references for Factura ${doc.id}`);
                  }
                }
              } else {
                 console.error(`[syncSales] HTTP Error fetching references for Factura ${doc.id}: ${refsRes.status}`);
              }
            } catch (refsErr: any) {
              console.error(`[syncSales] Error fetching references for Factura ${doc.id}:`, refsErr.message)
            }
          }

          return { docId: doc.id, status: 'OK', detailCount: detailRecords.length }
        } catch (err: any) {
          lastError = err?.message || 'unknown error'
          if (err?.name === 'AbortError') lastError = 'timeout'
        }
      }

      return { docId: doc.id, status: 'ERROR', detailCount: 0 }
    })

    const results = await Promise.allSettled(promises)
    for (const r of results) {
      if (r.status === 'fulfilled') allDocDetails.push(r.value)
      else detailErrors++
    }

    if ((i + CONCURRENCY) % 200 < CONCURRENCY || i + CONCURRENCY >= documents.length) {
      const ok = allDocDetails.filter(d => d.status === 'OK').length
      const nodet = allDocDetails.filter(d => d.status === 'WITHOUT_DETAILS').length
      const err = allDocDetails.filter(d => d.status === 'ERROR').length
      const pct = documents.length > 0 ? ((ok / documents.length) * 100).toFixed(1) : '0'
      console.log(`[syncSales] ${Math.min(i + CONCURRENCY, documents.length)}/${documents.length} | OK:${ok} (${pct}%) | NoDet:${nodet} | Err:${err} | details:${detailsCount}`)
    }
  }

  const finalOk = allDocDetails.filter(d => d.status === 'OK').length
  const finalNoDet = allDocDetails.filter(d => d.status === 'WITHOUT_DETAILS').length
  const finalErr = allDocDetails.filter(d => d.status === 'ERROR').length
  const coverage = documents.length > 0 ? ((finalOk / documents.length) * 100).toFixed(1) : '0'

  console.log(`[syncSales] FINAL: docs=${documents.length} OK=${finalOk} (${coverage}%) NoDet=${finalNoDet} Err=${finalErr} details=${detailsCount}`)

  return { docsCount, detailsCount, detailErrors: finalErr, sellerSync, pages }
}

export async function syncBsalePaymentTypes(companyId: string): Promise<{ count: number; errors: number }> {
  const db = integrDb()
  const now = new Date().toISOString()
  let count = 0
  let errors = 0

  const paymentTypes = await bsaleFetchAll<BsalePaymentType>('/payment_types.json')

  for (let i = 0; i < paymentTypes.length; i += 100) {
    const batch = paymentTypes.slice(i, i + 100)
    const records: BsalePaymentTypeRecord[] = batch
      .map(paymentType => {
        const bsaleId = toNumber(paymentType.id)
        if (bsaleId === null) return null
        return {
          company_id: companyId,
          bsale_id: bsaleId,
          bsale_payment_type_id: bsaleId,
          name: paymentType.name || null,
          is_active: paymentType.state !== 1,
          raw_json: paymentType,
          synced_at: now,
          updated_at: now,
        }
      })
      .filter((record): record is BsalePaymentTypeRecord => record !== null)

    if (records.length === 0) continue

    const { error } = await db.from('bsale_payment_types').upsert(records, {
      onConflict: 'company_id, bsale_payment_type_id',
      ignoreDuplicates: false,
    })

    if (error) {
      errors += records.length
      console.error('[syncBsalePaymentTypes] upsert error:', error.message)
    } else {
      count += records.length
    }
  }

  return { count, errors }
}

async function getPaymentTypeNames(companyId: string) {
  const db = integrDb()
  const { data, error } = await db
    .from('bsale_payment_types')
    .select('bsale_payment_type_id, name')
    .eq('company_id', companyId)

  if (error) throw new Error(`Error leyendo payment types: ${error.message}`)
  return new Map((data || []).map(row => [Number(row.bsale_payment_type_id), row.name as string | null]))
}

async function getDocumentMetadata(companyId: string, documentIds: number[]) {
  const db = integrDb()
  const byId = new Map<number, { document_type_id: number | null; number: number | null; client_id: number | null }>()
  const uniqueIds = Array.from(new Set(documentIds)).filter(Number.isFinite)

  for (let i = 0; i < uniqueIds.length; i += 200) {
    const ids = uniqueIds.slice(i, i + 200)
    const { data, error } = await db
      .from('bsale_documents')
      .select('bsale_id, document_type_id, number, client_id')
      .eq('company_id', companyId)
      .in('bsale_id', ids)

    if (error) throw new Error(`Error leyendo documentos para pagos: ${error.message}`)
    for (const row of data || []) {
      byId.set(Number(row.bsale_id), {
        document_type_id: row.document_type_id ?? null,
        number: row.number ?? null,
        client_id: row.client_id ?? null,
      })
    }
  }

  return byId
}

export async function syncBsalePayments(
  companyId: string,
  options: BsalePaymentsSyncOptions = { mode: 'incremental', days: 14 }
): Promise<{ payments: number; documentPayments: number; days: number; errors: number }> {
  const db = integrDb()
  const now = new Date().toISOString()
  const dateTo = options.recordDateTo ? dateInputToDate(options.recordDateTo) : new Date()
  const dateFrom = options.recordDateFrom
    ? dateInputToDate(options.recordDateFrom)
    : new Date(dateTo.getTime() - (options.days || 14) * 86400000)
  const recordDates = eachUtcDay(dateFrom, dateTo)
  const paymentTypeNames = await getPaymentTypeNames(companyId)
  const seen = new Map<number, BsalePayment>()
  let errors = 0

  for (const recorddate of recordDates) {
    try {
      const payments = await bsaleFetchAll<BsalePayment>('/payments.json', { recorddate })
      for (const payment of payments) {
        const paymentId = toNumber(payment.id)
        if (paymentId !== null) seen.set(paymentId, payment)
      }
    } catch (err: unknown) {
      errors++
      console.error(`[syncBsalePayments] Error fetching recorddate=${recorddate}:`, err instanceof Error ? err.message : err)
    }
  }

  const payments = Array.from(seen.values())
  let paymentsCount = 0
  let documentPaymentsCount = 0

  for (let i = 0; i < payments.length; i += 100) {
    const batch = payments.slice(i, i + 100)
    const records: BsalePaymentRecord[] = batch
      .map(payment => {
        const paymentId = toNumber(payment.id)
        if (paymentId === null) return null
        const paymentTypeId = toNumber(payment.payment_type?.id)
        return {
          company_id: companyId,
          bsale_id: paymentId,
          bsale_payment_id: paymentId,
          bsale_document_id: toNumber(payment.document?.id),
          amount: toNumber(payment.amount),
          payment_date: epochToIso(payment.recordDate),
          record_date: epochToDate(payment.recordDate),
          payment_type_id: paymentTypeId,
          payment_type_bsale_id: paymentTypeId,
          payment_type_name: paymentTypeId !== null ? paymentTypeNames.get(paymentTypeId) || null : null,
          is_credit_payment: asBoolean(payment.isCreditPayment),
          state: toNumber(payment.state),
          created_at_bsale: epochToIso(payment.createdAt),
          operation_number: payment.operationNumber || null,
          check_date: payment.checkDate || null,
          check_number: toNumber(payment.checkNumber),
          raw_json: payment,
          synced_at: now,
          updated_at: now,
        }
      })
      .filter((record): record is BsalePaymentRecord => record !== null)

    if (records.length === 0) continue

    const { error } = await db.from('bsale_payments').upsert(records, {
      onConflict: 'company_id, bsale_payment_id',
      ignoreDuplicates: false,
    })

    if (error) {
      errors += records.length
      console.error('[syncBsalePayments] payment upsert error:', error.message)
    } else {
      paymentsCount += records.length
    }
  }

  const documentIds: number[] = []
  for (const payment of payments) {
    if (Array.isArray(payment.documents) && payment.documents.length > 0) {
      for (const document of payment.documents) {
        const documentId = toNumber(document.id)
        if (documentId !== null) documentIds.push(documentId)
      }
    } else {
      const documentId = toNumber(payment.document?.id)
      if (documentId !== null) documentIds.push(documentId)
    }
  }

  const documentMetadata = await getDocumentMetadata(companyId, documentIds)
  const allocationRecords: BsaleDocumentPaymentRecord[] = []
  const realPaymentDocumentIds = new Set<number>()

  for (const payment of payments) {
    if (!asBoolean(payment.isCreditPayment) || !Array.isArray(payment.documents)) continue
    for (const document of payment.documents) {
      const documentId = toNumber(document.id)
      if (documentId !== null) realPaymentDocumentIds.add(documentId)
    }
  }

  if (realPaymentDocumentIds.size > 0) {
    const realDocumentIds = Array.from(realPaymentDocumentIds)
    for (let i = 0; i < realDocumentIds.length; i += 200) {
      const ids = realDocumentIds.slice(i, i + 200)
      const { data, error } = await db
        .from('bsale_payments')
        .select('bsale_payment_id')
        .eq('company_id', companyId)
        .eq('is_credit_payment', false)
        .in('bsale_document_id', ids)

      if (error) {
        errors++
        console.error('[syncBsalePayments] Error reading initial payment allocations:', error.message)
        continue
      }

      const initialPaymentIds = (data || []).map(row => Number(row.bsale_payment_id)).filter(Number.isFinite)
      if (initialPaymentIds.length === 0) continue

      const { error: deleteError } = await db
        .from('bsale_document_payments')
        .delete()
        .eq('company_id', companyId)
        .in('bsale_document_id', ids)
        .in('bsale_payment_id', initialPaymentIds)

      if (deleteError) {
        errors++
        console.error('[syncBsalePayments] Error deleting initial payment allocations:', deleteError.message)
      }
    }
  }

  for (const payment of payments) {
    const paymentId = toNumber(payment.id)
    if (paymentId === null) continue


    const paymentTypeId = toNumber(payment.payment_type?.id)
    const paymentTypeName = paymentTypeId !== null ? paymentTypeNames.get(paymentTypeId) || null : null
    if (isInitialCreditPayment(payment, paymentTypeName)) continue

    const paymentRecordDate = epochToIso(payment.recordDate)

    if (Array.isArray(payment.documents) && payment.documents.length > 0) {
      const paymentAmount = toNumber(payment.amount) || 0
      const documentsTotal = payment.documents.reduce((sum, document) => sum + (toNumber(document.amount) || 0), 0)
      const allocationRatio = documentsTotal > 0 && paymentAmount > 0 ? paymentAmount / documentsTotal : 1

      for (const document of payment.documents) {
        const documentId = toNumber(document.id)
        if (documentId === null) continue
        const meta = documentMetadata.get(documentId)
        const documentAmount = toNumber(document.amount) || 0
        allocationRecords.push({
          company_id: companyId,
          bsale_payment_id: paymentId,
          bsale_document_id: documentId,
          document_type_id: meta?.document_type_id ?? null,
          document_number: meta?.number ?? null,
          client_id: meta?.client_id ?? null,
          payment_record_date: paymentRecordDate,
          amount_applied: documentAmount * allocationRatio,
          raw_json: { payment, document },
          synced_at: now,
          updated_at: now,
        })
      }
    } else {
      const documentId = toNumber(payment.document?.id)
      if (documentId === null) continue
      if (!asBoolean(payment.isCreditPayment) && realPaymentDocumentIds.has(documentId)) continue
      const meta = documentMetadata.get(documentId)
      allocationRecords.push({
        company_id: companyId,
        bsale_payment_id: paymentId,
        bsale_document_id: documentId,
        document_type_id: meta?.document_type_id ?? null,
        document_number: meta?.number ?? null,
        client_id: meta?.client_id ?? null,
        payment_record_date: paymentRecordDate,
        amount_applied: toNumber(payment.amount) || 0,
        raw_json: { payment, document: payment.document || null },
        synced_at: now,
        updated_at: now,
      })
    }
  }

  for (let i = 0; i < allocationRecords.length; i += 100) {
    const batch = allocationRecords.slice(i, i + 100)
    const { error } = await db.from('bsale_document_payments').upsert(batch, {
      onConflict: 'company_id, bsale_payment_id, bsale_document_id',
      ignoreDuplicates: false,
    })

    if (error) {
      errors += batch.length
      console.error('[syncBsalePayments] document payment upsert error:', error.message)
    } else {
      documentPaymentsCount += batch.length
    }
  }

  return { payments: paymentsCount, documentPayments: documentPaymentsCount, days: recordDates.length, errors }
}

export async function syncBsaleSales(
  companyId: string,
  options?: { days?: number, dateFrom?: string, dateTo?: string }
): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  const days = options?.days || 180
  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id

    console.log(`[bsale-sync] Iniciando sync de ventas...`)
    const result = await syncDocuments(companyId, runId, options || { days })

    const counts: Record<string, number> = {
      documents: result.docsCount,
      details: result.detailsCount,
      detail_errors: result.detailErrors,
      document_sellers: result.sellerSync.upserted,
      document_seller_errors: result.sellerSync.errors,
      pages: result.pages,
    }

    const syncStatus = result.detailErrors > 0 ? 'PARTIAL' : 'COMPLETED'
    await finishSyncRun(runId, syncStatus, {
      documents: result.docsCount,
      document_details_count: result.detailsCount,
      detail_errors: result.detailErrors,
    })

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error en syncSales:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}

// ─── Main sync function ───────────────────────────────────────────

export async function syncBsaleCatalog(companyId: string): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id
    const counts: Record<string, number> = {}

    // 1. Sincronizar product types
    console.log('[bsale-sync] Iniciando sync de product types...')
    counts.product_types = await syncProductTypes(companyId, runId)
    console.log(`[bsale-sync] Product types sincronizados: ${counts.product_types}`)

    // 2. Sincronizar productos del catálogo
    console.log('[bsale-sync] Iniciando sync de productos...')
    counts.products = await syncProducts(companyId, runId)
    console.log(`[bsale-sync] Productos sincronizados: ${counts.products}`)

    // 2. Sincronizar variantes (contienen SKU)
    console.log('[bsale-sync] Iniciando sync de variantes...')
    counts.variants = await syncVariants(companyId, runId)
    console.log(`[bsale-sync] Variantes sincronizadas: ${counts.variants}`)


    // 3. Sincronizar stock actual
    console.log('[bsale-sync] Iniciando sync de stock...')
    counts.stocks = await syncStock(companyId, runId)
    console.log(`[bsale-sync] Stock sincronizado: ${counts.stocks}`)

    // 4. Sincronizar vendedores
    console.log('[bsale-sync] Iniciando sync de vendedores...')
    counts.sellers = await syncSellers(companyId, runId)
    console.log(`[bsale-sync] Vendedores sincronizados: ${counts.sellers}`)


    await finishSyncRun(runId, 'COMPLETED', counts)

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}


// ─── Locking & Auto-Sync Orchestration (Fase 4B) ────────────────

export async function acquireSyncLock(companyId: string, lockName: string, runId: string, ttlMinutes: number = 60): Promise<boolean> {
  const db = integrDb();
  
  // Try to clean up expired lock first (due to Supabase REST limitations on ON CONFLICT WHERE)
  // 1. Delete if expired
  await db.from('bsale_sync_locks')
    .delete()
    .eq('company_id', companyId)
    .eq('lock_name', lockName)
    .lt('expires_at', new Date().toISOString());

  // 2. Try to insert
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  const { data, error } = await db.from('bsale_sync_locks')
    .insert({
      company_id: companyId,
      lock_name: lockName,
      run_id: runId,
      acquired_at: new Date().toISOString(),
      expires_at: expiresAt
    })
    .select('run_id')
    .single();

  if (error) {
    // If it violates unique constraint, it means the lock is actively held
    return false;
  }
  return true;
}

export async function releaseSyncLock(companyId: string, lockName: string, runId: string): Promise<void> {
  const db = integrDb();
  await db.from('bsale_sync_locks')
    .delete()
    .eq('company_id', companyId)
    .eq('lock_name', lockName)
    .eq('run_id', runId);
}

async function materializePreparationAfterSalesSync(companyId: string) {
  const { data, error } = await integrDb()
    .schema('logistica')
    .rpc('materialize_next_route_preparation_cards', {
      p_company_id: companyId,
      p_source: 'AUTO_SYNC',
    })

  if (error) throw new Error(`Error materializando preparación: ${error.message}`)
  return data as {
    materialized?: number
    existing?: number
    out_of_cutoff?: number
    route_date?: string
    cities?: string[]
  }
}

export async function runReplenishmentBsaleSync(companyId: string, trigger: string = 'SCHEDULED'): Promise<{
  success: boolean;
  status: string;
  runId?: string;
  counts?: any;
  error?: string;
  duration?: number;
}> {
  const startTime = Date.now();
  let run = null;
  const lockName = 'bsale_replenishment_sync';
  
  try {
    run = await createSyncRun(companyId, trigger);
    const runId = run.id;

    // Acquire lock
    const acquired = await acquireSyncLock(companyId, lockName, runId, 60);
    if (!acquired) {
      console.log(`[runReplenishmentBsaleSync] Lock ocupado para ${companyId}`);
      await finishSyncRun(runId, 'FAILED', {}, 'SKIPPED_LOCKED: Sync already running');
      return { success: false, status: 'SKIPPED_LOCKED', error: 'Sync already running', duration: Date.now() - startTime };
    }

    let finalStatus: 'COMPLETED' | 'PARTIAL' | 'FAILED' = 'COMPLETED';
    let errorMessage = '';

    // 1. Sync Clients (before documents to reduce orphans)
    console.log('[runReplenishmentBsaleSync] Iniciando syncBsaleClients...');
    let clientStats = { bsaleTotal: 0, bsaleFetched: 0, insertedCount: 0, updatedCount: 0, skippedCount: 0, errorCount: 0 };
    try {
      const mappedTrigger = trigger === 'SCHEDULED' ? 'SCHEDULED' : (trigger === 'MANUAL' ? 'MANUAL' : 'SCHEDULED')
      const clientsRes = await syncBsaleClients({
        companyId,
        triggerType: mappedTrigger,
        isDryRun: false,
        recordDryRun: true,
      });
      if (clientsRes.stats) {
        clientStats = clientsRes.stats;
      }
      if (clientsRes.status === 'FAILED') {
        console.error('[runReplenishmentBsaleSync] syncBsaleClients failed:', clientsRes.message);
        finalStatus = 'PARTIAL';
        errorMessage += (errorMessage ? ' | ' : '') + 'Clients: ' + clientsRes.message;
      } else if (clientsRes.status === 'SKIPPED') {
        console.log('[runReplenishmentBsaleSync] syncBsaleClients skipped (lock):', clientsRes.message);
      }
      console.log(`[runReplenishmentBsaleSync] Clients: fetched=${clientStats.bsaleFetched} ins=${clientStats.insertedCount} upd=${clientStats.updatedCount}`);
    } catch (clientsErr: any) {
      console.error('[runReplenishmentBsaleSync] Error en clients:', clientsErr);
      finalStatus = 'PARTIAL';
      errorMessage += (errorMessage ? ' | ' : '') + 'Error en clients: ' + clientsErr.message;
    }

    // 2. Sync Sales (14 days)
    console.log('[runReplenishmentBsaleSync] Iniciando syncBsaleSales (14 days)...');
    const salesRes = await syncBsaleSales(companyId, { days: 14 });
    
    if (!salesRes.success) {
      finalStatus = 'FAILED';
      errorMessage = salesRes.error || 'Error en ventas';
    } else if (salesRes.counts?.detail_errors && salesRes.counts.detail_errors > 0) {
      finalStatus = 'PARTIAL';
    }

    // 3. Materialize eligible sales orders only after their documents are available locally.
    let preparationResult: Awaited<ReturnType<typeof materializePreparationAfterSalesSync>> | null = null;
    if (finalStatus !== 'FAILED') {
      try {
        preparationResult = await materializePreparationAfterSalesSync(companyId);
        console.log(`[runReplenishmentBsaleSync] Preparation: materialized=${preparationResult.materialized || 0} existing=${preparationResult.existing || 0}`);
      } catch (preparationErr: unknown) {
        finalStatus = 'PARTIAL';
        errorMessage += (errorMessage ? ' | ' : '') + 'Preparation: ' + (preparationErr instanceof Error ? preparationErr.message : String(preparationErr));
      }
    }

    // 4. Sync payments after documents because payment allocations reference document IDs.
    let paymentTypesResult = { count: 0, errors: 0 };
    let paymentsResult = { payments: 0, documentPayments: 0, days: 0, errors: 0 };
    if (finalStatus !== 'FAILED') {
      console.log('[runReplenishmentBsaleSync] Iniciando sync de payment types y payments (14 days)...');
      try {
        paymentTypesResult = await syncBsalePaymentTypes(companyId);
        paymentsResult = await syncBsalePayments(companyId, { mode: 'incremental', days: 14 });
        if (paymentTypesResult.errors > 0 || paymentsResult.errors > 0) {
          finalStatus = 'PARTIAL';
          errorMessage += (errorMessage ? ' | ' : '') + `Payments: type_errors=${paymentTypesResult.errors} payment_errors=${paymentsResult.errors}`;
        }
        console.log(`[runReplenishmentBsaleSync] Payments: types=${paymentTypesResult.count} payments=${paymentsResult.payments} allocations=${paymentsResult.documentPayments}`);
      } catch (paymentsErr: unknown) {
        console.error('[runReplenishmentBsaleSync] Error en payments:', paymentsErr);
        finalStatus = 'PARTIAL';
        errorMessage += (errorMessage ? ' | ' : '') + 'Error en payments: ' + (paymentsErr instanceof Error ? paymentsErr.message : String(paymentsErr));
      }
    }

    // 5. Hydrate orphan clients detected after document sync
    let orphanResult = { hydrated: 0, errors: 0, orphanIds: [] as number[] };
    if (finalStatus !== 'FAILED') {
      console.log('[runReplenishmentBsaleSync] Hydrating orphan clients...');
      try {
        orphanResult = await hydrateOrphanClients(companyId, runId);
        if (orphanResult.hydrated > 0) {
          console.log(`[runReplenishmentBsaleSync] Hydrated ${orphanResult.hydrated} orphan clients`);
        }
      } catch (orphanErr: any) {
        console.error('[runReplenishmentBsaleSync] Error hydrating orphans:', orphanErr);
      }
    }

    // 6. Sync Stock
    let stockCount = 0;
    if (finalStatus !== 'FAILED') {
      console.log('[runReplenishmentBsaleSync] Iniciando syncStock...');
      try {
         stockCount = await syncStock(companyId, runId);
      } catch (stockErr: any) {
         console.error('[runReplenishmentBsaleSync] Error en stock:', stockErr);
         finalStatus = 'PARTIAL';
         errorMessage += (errorMessage ? ' | ' : '') + 'Error en stock: ' + stockErr.message;
      }
    }

    const counts = {
      clients: clientStats,
      sales: salesRes.counts,
      payments: paymentsResult,
      payment_types: paymentTypesResult,
      preparation: preparationResult,
      orphans: orphanResult,
      stocks: stockCount
    };

    await finishSyncRun(runId, finalStatus, {
       clients_fetched: clientStats.bsaleFetched,
       clients_inserted: clientStats.insertedCount,
       clients_updated: clientStats.updatedCount,
       documents: salesRes.counts?.documents || 0,
       document_details_count: salesRes.counts?.details || 0,
       detail_errors: salesRes.counts?.detail_errors || 0,
       orphans_hydrated: orphanResult.hydrated,
       stocks: stockCount
    }, errorMessage || undefined);

    await releaseSyncLock(companyId, lockName, runId);

    return {
      success: finalStatus !== 'FAILED',
      status: finalStatus,
      runId,
      counts,
      duration: Date.now() - startTime
    };

  } catch (err: any) {
    if (run?.id) {
       await finishSyncRun(run.id, 'FAILED', {}, err.message || 'Error inesperado');
       await releaseSyncLock(companyId, lockName, run.id);
    }
    return { success: false, status: 'FAILED', error: err.message, duration: Date.now() - startTime };
  }
}
