import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { buildWeeklyDemand, forecastSku, forecastSkuBaseline } from '../src/modules/adquisiciones/ordenes-compra/replenishment-forecast.ts'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
const TARGETS = [
  { sku: '20073', variantId: 6457 },
  { sku: '3002', variantId: 6282 },
  { sku: '2008DG', variantId: 7079 },
]
const dateFrom = process.argv[2] || '2026-01-01'
const dateTo = process.argv[3] || '2026-09-21'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
})

const sales = await fetchSales()
const events = await fetchEvents()
for (const target of TARGETS) {
  const weekly = buildWeeklyDemand({
    dateFrom,
    dateTo,
    sales: sales.filter(row => row.variant_code === target.sku).map(row => ({ date: row.emission_date, quantity: Number(row.logistic_net_quantity) || 0 })),
    stockEvents: events.filter(row => row.variant_id === target.variantId).map(row => ({ date: row.event_date, stockAfter: row.variant_stock_after == null ? null : Number(row.variant_stock_after) })),
  })
  const before = forecastSkuBaseline(weekly)
  const after = forecastSku(weekly)
  console.log(JSON.stringify({
    sku: target.sku,
    variant_id: target.variantId,
    before,
    after,
    partialWeeksRecovered: after.weeks.filter(week => week.validForTraining && week.daysWithoutStock > 0).length,
  }, null, 2))
}

async function fetchSales() {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('vw_bsale_sales_logistic_valid')
      .select('emission_date,variant_code,logistic_net_quantity')
      .eq('company_id', COMPANY_ID)
      .in('variant_code', TARGETS.map(target => target.sku))
      .gte('emission_date', dateFrom)
      .lte('emission_date', dateTo)
      .order('emission_date', { ascending: true })
      .range(offset, offset + 999)
    if (error) throw new Error(`No se pudieron leer ventas: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

async function fetchEvents() {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('bsale_stock_kardex_events')
      .select('variant_id,event_date,source_type,source_header_id,quantity_delta,variant_stock_after,raw_json')
      .eq('company_id', COMPANY_ID)
      .eq('office_id', 1)
      .in('variant_id', TARGETS.map(target => target.variantId))
      .gte('event_date', dateFrom)
      .lte('event_date', dateTo)
      .order('variant_id', { ascending: true })
      .order('event_date', { ascending: true })
      .range(offset, offset + 999)
    if (error) throw new Error(`No se pudo leer Kardex: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) return deduplicate(rows)
  }
}

function deduplicate(events) {
  const returns = new Set(events
    .filter(event => event.source_type === 'RETURN')
    .map(event => `${event.event_date}|${event.quantity_delta}|${event.variant_stock_after ?? 'null'}|${event.source_header_id}|${event.raw_json?.header?.credit_note?.number ?? ''}`))
  return events.filter(event => event.source_type !== 'RECEPTION' || !returns.has(`${event.event_date}|${event.quantity_delta}|${event.variant_stock_after ?? 'null'}|${event.raw_json?.header?.note ?? ''}|${event.raw_json?.header?.documentNumber ?? ''}`))
}
