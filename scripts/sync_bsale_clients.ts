import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import crypto from 'crypto'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const isDryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply')
const limitArgIndex = process.argv.indexOf('--limit')
const limitOverride = limitArgIndex > -1 ? parseInt(process.argv[limitArgIndex + 1]) : null
const companyIdArgIndex = process.argv.indexOf('--company-id')
const targetCompanyId = companyIdArgIndex > -1 ? process.argv[companyIdArgIndex + 1] : 'd1000000-0000-0000-0000-000000000001'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const bsaleUrl = process.env.BSALE_API_BASE_URL!
const bsaleToken = process.env.BSALE_ACCESS_TOKEN!

const supabase = createClient(supabaseUrl, supabaseKey)

// Función auxiliar para delay
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Normalizar RUT
function cleanCode(code: any): string | null {
  if (!code || typeof code !== 'string') return null
  const cleaned = code.replace(/[^0-9kK]/g, '').toUpperCase()
  return cleaned === '' ? null : cleaned
}

// Resolver Business Name
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

// Stats para dry-run
const stats = {
  bsaleTotal: 0,
  bsaleFetched: 0,
  withRut: 0,
  withoutRut: 0,
  withEmail: 0,
  withPhone: 0,
  withAddress: 0,
  withLocation: 0,
  withCreditData: 0,
  projectedIntegracionesUpsert: 0,
  projectedComercialUpsert: 0,
  samples: [] as any[]
}

async function fetchBsaleClients() {
  let offset = 0
  const limit = 50
  let hasMore = true
  let totalCount = -1

  const allClients = []

  while (hasMore) {
    // Solo clientes activos: state=0 (Si se quieren inactivos, habría que quitarlo, pero por la fase 1, 
    // revisamos qué devuelve Bsale sin state)
    // El requerimiento dice: "Revisar si Bsale entrega activos e inactivos... no asumir 471 activos = todos".
    // Bsale documentation: by default GET /clients.json might return all or just active. 
    // Let's remove 'state=0' to see everything.
    const url = `${bsaleUrl}/clients.json?limit=${limit}&offset=${offset}`
    
    console.log(`[GET] ${url}`)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'access_token': bsaleToken,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      if (response.status === 429) {
        console.log('Rate limit detectado, esperando 2 segundos...')
        await sleep(2000)
        continue
      }
      throw new Error(`Bsale API error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()
    if (totalCount === -1) {
      totalCount = data.count
      stats.bsaleTotal = totalCount
      console.log(`Bsale reporta un total de ${totalCount} clientes.`)
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
    
    // Safety break
    if (offset > totalCount + limit) {
      hasMore = false
    }
  }

  return allClients
}

async function processClients(clients: any[]) {
  const integracionesRecords = []
  const comercialRecords = []

  for (const client of clients) {
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
    const creditDays = (client.sale_condition && client.sale_condition.id) ? 30 : null // Bsale doesn't return days directly without querying sale_condition endpoint, we will map ID later if needed

    if (cleanedRut) stats.withRut++
    else stats.withoutRut++
    if (email) stats.withEmail++
    if (phone) stats.withPhone++
    if (address) stats.withAddress++
    if (city || commune) stats.withLocation++
    if (creditLimit !== null || client.hasCredit) stats.withCreditData++

    const rawPayload = client
    const hash = computeHash(rawPayload)

    // Mask for sample
    if (stats.samples.length < 5) {
      stats.samples.push({
        id: bsaleId,
        businessName,
        rut: rut ? '12.***.***-*' : null,
        email: email ? 'c***@dominio.cl' : null,
        phone: phone ? '+56 ******123' : null,
        address: address ? 'Direccion oculta...' : null,
        state: client.state,
        activity: client.activity
      })
    }

    integracionesRecords.push({
      company_id: targetCompanyId,
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
      raw_payload: rawPayload,
      payload_hash: hash,
      last_seen_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString()
    })
    stats.projectedIntegracionesUpsert++

    comercialRecords.push({
      company_id: targetCompanyId,
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
    stats.projectedComercialUpsert++
  }

  if (isDryRun) {
    console.log('\n=======================================')
    console.log('          REPORTE DRY-RUN              ')
    console.log('=======================================')
    console.log(`Clientes leídos desde Bsale: ${stats.bsaleFetched} (Total reportado: ${stats.bsaleTotal})`)
    console.log(`Con RUT/código: ${stats.withRut}`)
    console.log(`Sin RUT/código: ${stats.withoutRut}`)
    console.log(`Con email: ${stats.withEmail}`)
    console.log(`Con teléfono: ${stats.withPhone}`)
    console.log(`Con dirección: ${stats.withAddress}`)
    console.log(`Con comuna/ciudad: ${stats.withLocation}`)
    console.log(`Con crédito/condiciones: ${stats.withCreditData}`)
    console.log(`Proyección INSERT/UPDATE en integraciones.bsale_clients: ${stats.projectedIntegracionesUpsert}`)
    console.log(`Proyección INSERT/UPDATE en comercial.customers: ${stats.projectedComercialUpsert}`)
    
    console.log('\n--- MUESTRAS ENMASCARADAS (Max 5) ---')
    console.log(JSON.stringify(stats.samples, null, 2))
    
    console.log('\n[INFO] Ejecutado en modo --dry-run. No se escribieron datos en la base de datos.')
    return
  }

  // APPLY MODE
  console.log('\n--- INICIANDO APPLY EN BASE DE DATOS ---')
  
  // Upsert integraciones.bsale_clients
  console.log('Guardando en integraciones.bsale_clients...')
  // Split into chunks of 100 for safety
  const chunkSize = 100
  for (let i = 0; i < integracionesRecords.length; i += chunkSize) {
    const chunk = integracionesRecords.slice(i, i + chunkSize)
    const { error } = await supabase.schema('integraciones').from('bsale_clients').upsert(chunk, {
      onConflict: 'company_id, bsale_client_id',
      ignoreDuplicates: false
    })
    if (error) {
      console.error('Error upserting integraciones.bsale_clients:', error)
      throw error
    }
  }

  // Upsert comercial.customers
  console.log('Guardando en comercial.customers...')
  for (let i = 0; i < comercialRecords.length; i += chunkSize) {
    const chunk = comercialRecords.slice(i, i + chunkSize)
    // Commercial Customers Upsert Logic
    // We only update fields that Bsale is master of. We don't overwrite notes, etc.
    // Supabase upsert will overwrite entire row.
    // To do partial updates properly, we can either do a loop with select/update, or upsert.
    // Since we don't want to overwrite manual notes, we'll fetch existing first.
    
    const { data: existing, error: fetchErr } = await supabase.schema('comercial').from('customers')
      .select('id, bsale_client_id, notes, fantasy_name')
      .eq('company_id', targetCompanyId)
      .in('bsale_client_id', chunk.map(c => c.bsale_client_id))

    if (fetchErr) {
      console.error('Error fetching existing customers:', fetchErr)
      throw fetchErr
    }

    const existingMap = new Map(existing.map(e => [e.bsale_client_id, e]))
    
    const toInsert = []
    const toUpdate = []

    for (const record of chunk) {
      const ext = existingMap.get(record.bsale_client_id)
      if (ext) {
        // Keep existing notes & fantasy_name
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
      const { error: insErr } = await supabase.schema('comercial').from('customers').insert(toInsert)
      if (insErr) throw insErr
    }
    
    if (toUpdate.length > 0) {
      const { error: updErr } = await supabase.schema('comercial').from('customers').upsert(toUpdate, {
        onConflict: 'id',
        ignoreDuplicates: false
      })
      if (updErr) throw updErr
    }
  }
  
  console.log('Sincronización finalizada exitosamente.')
}

async function run() {
  try {
    const clients = await fetchBsaleClients()
    await processClients(clients)
  } catch (error) {
    console.error('Error en sync:', error)
  }
}

run()
