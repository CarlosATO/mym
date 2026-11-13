import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import {
  createSyncRun,
  finishSyncRun,
  recordSyncError,
  tryAcquireSyncLock,
  releaseSyncLock,
  SyncTriggerType,
  SyncStatus
} from './sync-core'
import { getBsaleConfigForCompany } from '@/lib/bsale/company-config'
import { canDeactivateAbsentClients, getAbsentBsaleClientIds } from './bsale-clients-sync-logic'
import { normalizeBsaleClientCommercialFields } from './bsale-client-commercial-normalization'
import { fetchBsaleClientsPage } from './bsale-clients-fetch'

const CLIENTS_SYNC_DEADLINE_MS = 8 * 60_000
const CLIENTS_CONTROL_REQUEST_TIMEOUT_MS = 30_000

type BsaleClient = Record<string, unknown> & {
  id: number; code?: string; company?: string; firstName?: string; lastName?: string;
  email?: string; phone?: string; address?: string; city?: string; municipality?: string;
  activity?: string; state?: number
}

function cleanCode(code: any): string | null {
  if (!code || typeof code !== 'string') return null
  const cleaned = code.replace(/[^0-9kK]/g, '').toUpperCase()
  return cleaned === '' ? null : cleaned
}

function resolveBusinessName(client: any): string {
  if (client.company && client.company.trim() !== '') return client.company.trim()
  const first = client.firstName ? client.firstName.trim() : ''
  const last = client.lastName ? client.lastName.trim() : ''
  const full = `${first} ${last}`.trim()
  if (full !== '') return full
  return `Cliente Bsale ${client.id}`
}

function computeHash(payload: any): string {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')
}

export interface SyncBsaleClientsOptions {
  companyId: string
  triggerType: SyncTriggerType
  requestedBy?: string
  isDryRun?: boolean
  recordDryRun?: boolean
  limitOverride?: number | null
}

export async function syncBsaleClients(options: SyncBsaleClientsOptions) {
  const { companyId, triggerType, requestedBy, isDryRun = false, recordDryRun = false, limitOverride = null } = options
  const provider = 'BSALE'
  const entity = 'clients'
  const deadlineAt = Date.now() + CLIENTS_SYNC_DEADLINE_MS
  let dbWriteOutcomeUnknown = false
  
  const { baseUrl: bsaleUrl, accessToken: bsaleToken } = getBsaleConfigForCompany(companyId)

  const boundedFetch: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout }).catch(error => {
      if (method !== 'GET' && method !== 'HEAD') dbWriteOutcomeUnknown = true
      throw error
    })
  }
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: boundedFetch } }
  )

  // Create the run first so the lock is owned by this specific run.
  const shouldCreateRun = !isDryRun || recordDryRun
  let runId: string | null = null
  let ownsLock = false

  const stats = {
    bsaleTotal: 0,
    bsaleFetched: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    deactivatedCount: 0
  }

  try {
    if (shouldCreateRun) {
      runId = await createSyncRun({ companyId, provider, entity, triggerType, requestedBy, timeoutMs: CLIENTS_CONTROL_REQUEST_TIMEOUT_MS })
      ownsLock = await tryAcquireSyncLock({ companyId, provider, entity, ttlMinutes: 60, lockedBy: triggerType, syncRunId: runId, timeoutMs: CLIENTS_CONTROL_REQUEST_TIMEOUT_MS })
      if (!ownsLock) {
        await finishSyncRun({ runId, status: 'SKIPPED', message: 'Sync ya se encuentra en ejecución (Lock activo).', strict: true })
        return { status: 'SKIPPED', message: 'Sync already running' }
      }
    }
    const [{ data: paymentTypeCatalog, error: paymentTypeCatalogError }, { data: saleConditionCatalog, error: saleConditionCatalogError }] = await Promise.all([
      admin.schema('integraciones').from('bsale_payment_types').select('bsale_id, name').eq('company_id', companyId).eq('is_active', true),
      admin.schema('integraciones').from('bsale_sale_conditions').select('bsale_id, name').eq('company_id', companyId).eq('state', 0),
    ])
    if (paymentTypeCatalogError) throw paymentTypeCatalogError
    if (saleConditionCatalogError) throw saleConditionCatalogError
    const paymentTypeNames = new Map((paymentTypeCatalog ?? []).map(row => [Number(row.bsale_id), row.name]))
    const saleConditionNames = new Map((saleConditionCatalog ?? []).map(row => [Number(row.bsale_id), row.name]))

    // 2. Fetch clients
    let offset = 0
    const limit = 50
    let totalCount = -1
    const allClients: BsaleClient[] = []

    let fetchCompleted = false
    while (!fetchCompleted) {
      const url = `${bsaleUrl}/clients.json?limit=${limit}&offset=${offset}`
      const data = await fetchBsaleClientsPage<{ count: number; items: BsaleClient[] }>({ url, token: bsaleToken, deadlineAt })
      if (totalCount === -1) {
        totalCount = Number(data.count)
        if (!Number.isFinite(totalCount) || totalCount < 0) {
          throw new Error('Bsale API response missing a valid clients count')
        }
        stats.bsaleTotal = totalCount
      }

      if (!data.items || data.items.length === 0) {
        if (totalCount === allClients.length) {
          fetchCompleted = true
          continue
        }
        throw new Error('Bsale clients pagination ended before the complete list was fetched')
      }

      allClients.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride !== null) {
        break
      }

      if (allClients.length >= totalCount) {
        fetchCompleted = true
        continue
      }

      offset += limit
    }

    // 3. Process clients
    const integracionesRecords = []
    const comercialRecords = []

    for (const client of allClients) {
      const bsaleId = client.id
      const rut = client.code
      const cleanedRut = cleanCode(rut)
      const businessName = resolveBusinessName(client)
      const email = (client.email && client.email.trim() !== '') ? client.email.trim().toLowerCase() : null
      const phone = client.phone ? client.phone.trim() : null
      const address = client.address ? client.address.trim() : null
      const city = client.city ? client.city.trim() : null
      const commune = client.municipality ? client.municipality.trim() : null
      
      const commercial = normalizeBsaleClientCommercialFields(client, { paymentTypeNames, saleConditionNames })
      const hash = computeHash(client)

      integracionesRecords.push({
        company_id: companyId,
        bsale_client_id: bsaleId,
        code: rut,
        code_clean: cleanedRut,
        business_name: businessName,
        first_name: client.firstName,
        last_name: client.lastName,
        email: email,
        phone: phone,
        mobile: null,
        address: address,
        city: city,
        commune: commune,
        region: commercial.region,
        district: null,
        activity: client.activity,
        company: client.company,
        client_type: null,
        price_list_id: commercial.price_list_id,
        price_list_name: commercial.price_list_name,
        payment_type_id: commercial.payment_type_id,
        payment_type_name: commercial.payment_type_name,
        sale_condition_id: commercial.sale_condition_id,
        sale_condition_name: commercial.sale_condition_name,
        has_credit: commercial.has_credit,
        credit_limit: commercial.credit_limit,
        credit_days: null,
        is_active_bsale: client.state === 0,
        raw_payload: client,
        payload_hash: hash,
        last_seen_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString()
      })

      comercialRecords.push({
        company_id: companyId,
        bsale_client_id: bsaleId,
        source: 'BSALE',
        rut: rut,
        rut_clean: cleanedRut,
        business_name: businessName,
        fantasy_name: null,
        email: email,
        phone: phone,
        mobile: null,
        address: address,
        city: city,
        commune: commune,
        region: commercial.region,
        business_activity: client.activity || null,
        credit_limit: commercial.credit_limit,
        is_active: client.state === 0,
        last_bsale_sync_at: new Date().toISOString()
      })
    }

    if (isDryRun) {
      if (Date.now() >= deadlineAt) throw new Error('BSALE_CLIENTS_SYNC_TIMEOUT')
      if (runId) {
        await finishSyncRun({ runId, status: 'SUCCESS', message: 'Dry-run completado', readCount: stats.bsaleFetched, strict: true })
      }
      return { status: 'SUCCESS', stats, isDryRun: true }
    }

    // 4. Upsert integraciones.bsale_clients
    const chunkSize = 100
    for (let i = 0; i < integracionesRecords.length; i += chunkSize) {
      const chunk = integracionesRecords.slice(i, i + chunkSize)
      const { error } = await admin.schema('integraciones').from('bsale_clients').upsert(chunk, {
        onConflict: 'company_id, bsale_client_id',
        ignoreDuplicates: false
      })
      if (error) {
        stats.errorCount++
        if (runId) await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message, timeoutMs: CLIENTS_CONTROL_REQUEST_TIMEOUT_MS })
        throw error
      }
    }

    // 5. Upsert comercial.customers (safe partial update)
    let upsertedCount = 0
    for (let i = 0; i < comercialRecords.length; i += chunkSize) {
      const chunk = comercialRecords.slice(i, i + chunkSize)
      
      const { data: existing, error: fetchErr } = await admin.schema('comercial').from('customers')
        .select('id, bsale_client_id, notes, fantasy_name')
        .eq('company_id', companyId)
        .in('bsale_client_id', chunk.map(c => c.bsale_client_id))

      if (fetchErr) throw fetchErr

      const existingMap = new Map(existing.map(e => [e.bsale_client_id, e]))
      
      const toInsert = []
      const toUpdate = []

      for (const record of chunk) {
        const ext = existingMap.get(record.bsale_client_id)
        if (ext) {
          toUpdate.push({
            id: ext.id,
            ...record,
            notes: ext.notes,
            fantasy_name: ext.fantasy_name || record.fantasy_name
          })
        } else {
          toInsert.push(record)
        }
      }

      if (toInsert.length > 0) {
        const { error: insErr } = await admin.schema('comercial').from('customers').insert(toInsert)
        if (insErr) throw insErr
        stats.insertedCount += toInsert.length
      }
      
      if (toUpdate.length > 0) {
        const { error: updErr } = await admin.schema('comercial').from('customers').upsert(toUpdate, {
          onConflict: 'id',
          ignoreDuplicates: false
        })
        if (updErr) throw updErr
        stats.updatedCount += toUpdate.length
      }
      upsertedCount += chunk.length
    }

    // Absence is meaningful only after a complete, non-limited Bsale fetch.
    if (canDeactivateAbsentClients({
      isDryRun,
      hasLimitOverride: limitOverride !== null,
      fetchCompleted
    })) {
      const currentBsaleIds = new Set(allClients.map(client => client.id))
      const { data: localClients, error: localClientsError } = await admin.schema('integraciones')
        .from('bsale_clients')
        .select('bsale_client_id')
        .eq('company_id', companyId)

      if (localClientsError) throw localClientsError

      const absentIds = getAbsentBsaleClientIds(
        localClients.map(client => client.bsale_client_id),
        [...currentBsaleIds]
      )

      if (absentIds.length > 0) {
        const { error: deactivateBsaleError } = await admin.schema('integraciones')
          .from('bsale_clients')
          .update({ is_active_bsale: false })
          .eq('company_id', companyId)
          .in('bsale_client_id', absentIds)

        if (deactivateBsaleError) throw deactivateBsaleError

        const { error: deactivateCustomersError } = await admin.schema('comercial')
          .from('customers')
          .update({ is_active: false })
          .eq('company_id', companyId)
          .in('bsale_client_id', absentIds)

        if (deactivateCustomersError) throw deactivateCustomersError
        stats.deactivatedCount = absentIds.length
      }
    }

    if (Date.now() >= deadlineAt) throw new Error('BSALE_CLIENTS_SYNC_TIMEOUT')
    if (runId) {
      await finishSyncRun({ 
        runId, 
        status: 'SUCCESS', 
        readCount: stats.bsaleFetched,
        insertedCount: stats.insertedCount,
        updatedCount: stats.updatedCount,
        errorCount: stats.errorCount,
        strict: true
      })
    }

    return { status: 'SUCCESS', stats }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : (error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Error desconocido')
    if (runId) {
      try { await recordSyncError({ runId, companyId, provider, entity, errorMessage: message, timeoutMs: CLIENTS_CONTROL_REQUEST_TIMEOUT_MS }) } catch (recordError) { console.error('[syncBsaleClients] error recording sync error', recordError) }
      try { await finishSyncRun({ runId, status: 'FAILED', message, errorCount: stats.errorCount + 1, strict: true }) } catch (finishError) { console.error('[syncBsaleClients] error recording FAILED', finishError) }
    }
    return { status: 'FAILED', message, stats }
  } finally {
    if (ownsLock && runId && dbWriteOutcomeUnknown) {
      // A disconnected write may still commit remotely; keep the lock until
      // expiry rather than overlap it with the next scheduled sync.
      console.error('[syncBsaleClients] resultado de escritura desconocido; lock conservado hasta su vencimiento')
    } else if (ownsLock && runId) {
      try {
        await releaseSyncLock(companyId, provider, entity, runId)
      } catch (releaseError) {
        try { await finishSyncRun({ runId, status: 'FAILED', message: 'No se pudo liberar el lock de clientes.', errorCount: stats.errorCount + 1, strict: true }) } catch (finishError) { console.error('[syncBsaleClients] error recording lock failure', finishError) }
        throw releaseError
      }
    }
  }
}
