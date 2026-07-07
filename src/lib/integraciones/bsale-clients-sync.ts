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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
  
  const bsaleUrl = process.env.BSALE_API_BASE_URL!
  const bsaleToken = process.env.BSALE_ACCESS_TOKEN!

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // 1. Try acquire lock (except for non-recorded dry-runs)
  const shouldCreateRun = !isDryRun || recordDryRun
  
  if (shouldCreateRun) {
    const locked = await tryAcquireSyncLock({
      companyId,
      provider,
      entity,
      ttlMinutes: 60,
      lockedBy: triggerType
    })

    if (!locked) {
      if (shouldCreateRun) {
        const runId = await createSyncRun({ companyId, provider, entity, triggerType, requestedBy })
        await finishSyncRun({ runId, status: 'SKIPPED', message: 'Sync ya se encuentra en ejecución (Lock activo).' })
      }
      return { status: 'SKIPPED', message: 'Sync already running' }
    }
  }

  let runId: string | null = null
  if (shouldCreateRun) {
    runId = await createSyncRun({ companyId, provider, entity, triggerType, requestedBy })
    // Update lock with runId
    await admin.schema('integraciones').from('sync_locks').update({ sync_run_id: runId }).eq('company_id', companyId).eq('provider', provider).eq('entity', entity)
  }

  const stats = {
    bsaleTotal: 0,
    bsaleFetched: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0
  }

  try {
    // 2. Fetch clients
    let offset = 0
    const limit = 50
    let hasMore = true
    let totalCount = -1
    const allClients = []

    while (hasMore) {
      const url = `${bsaleUrl}/clients.json?limit=${limit}&offset=${offset}`
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'access_token': bsaleToken,
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        if (response.status === 429) {
          await sleep(2000)
          continue
        }
        throw new Error(`Bsale API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      if (totalCount === -1) {
        totalCount = data.count
        stats.bsaleTotal = totalCount
      }

      if (!data.items || data.items.length === 0) {
        hasMore = false
        break
      }

      allClients.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride && allClients.length >= limitOverride) {
        hasMore = false
        break
      }

      offset += limit
      if (offset > totalCount + limit) {
        hasMore = false
      }
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
      
      const creditLimit = client.maxCredit ? parseFloat(client.maxCredit) : null
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
        region: null,
        district: null,
        activity: client.activity,
        company: client.company,
        client_type: null,
        price_list_id: client.price_list?.id || null,
        payment_type_id: client.payment_type?.id || null,
        credit_limit: creditLimit,
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
        region: client.city || null,
        business_activity: client.activity || null,
        credit_limit: creditLimit,
        is_active: client.state === 0,
        last_bsale_sync_at: new Date().toISOString()
      })
    }

    if (isDryRun) {
      if (runId) {
        await finishSyncRun({ runId, status: 'SUCCESS', message: 'Dry-run completado', readCount: stats.bsaleFetched })
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
        if (runId) await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
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

    if (runId) {
      await finishSyncRun({ 
        runId, 
        status: 'SUCCESS', 
        readCount: stats.bsaleFetched,
        insertedCount: stats.insertedCount,
        updatedCount: stats.updatedCount,
        errorCount: stats.errorCount
      })
    }

    return { status: 'SUCCESS', stats }

  } catch (error: any) {
    if (runId) {
      await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
      await finishSyncRun({ runId, status: 'FAILED', message: error.message, errorCount: stats.errorCount + 1 })
    }
    return { status: 'FAILED', message: error.message, stats }
  } finally {
    if (shouldCreateRun) {
      await releaseSyncLock(companyId, provider, entity)
    }
  }
}
