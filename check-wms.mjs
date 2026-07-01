import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://oekmztbfasmildyuajji.supabase.co'
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9la216dGJmYXNtaWxkeXVhamppIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTkwNzc3MywiZXhwIjoyMDk3NDgzNzczfQ.eW9Mi3BT-8HVX8z9kWHMJGvSm9bwET5zPIqQYh1MEUY'

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function run() {
  console.log("=== DIAGNOSTICO VALIDACION REQUERIDA ===")
  
  // Asumimos company_id del primer registro por defecto para pruebas
  const { data: bpkWarehouse } = await db.schema('adquisiciones').from('warehouses').select('*').eq('code', 'BPK').single()
  const { data: principalWarehouse } = await db.schema('adquisiciones').from('warehouses').select('*').eq('code', 'PRINCIPAL').single()
  
  if (!bpkWarehouse) {
    console.log("No se encontró BPK")
    return
  }

  const companyId = bpkWarehouse.company_id

  console.log("\n--- getWarehouseLocationStats() equivalente ---")
  const { data: warehouses } = await db.schema('adquisiciones').from('warehouses').select('id, code, name').eq('company_id', companyId)
  const { data: locations } = await db.schema('logistica').from('locations').select('id, warehouse_id, is_active').eq('company_id', companyId)
  const { data: stock } = await db.schema('logistica').from('v_stock_by_location').select('location_id, quantity').eq('company_id', companyId)
  
  const locationsWithStock = new Set((stock || []).filter(s => s.quantity > 0).map(s => s.location_id))

  const stats = (warehouses || []).map(w => {
    const wLocations = (locations || []).filter(l => l.warehouse_id === w.id)
    const active = wLocations.filter(l => l.is_active).length
    const withStock = wLocations.filter(l => locationsWithStock.has(l.id)).length
    return {
      warehouse_id: w.id,
      warehouse_code: w.code,
      warehouse_name: w.name,
      total_locations: wLocations.length,
      active_locations: active,
      inactive_locations: wLocations.length - active,
      locations_with_stock: withStock
    }
  })
  console.log(JSON.stringify(stats, null, 2))

  console.log("\n--- getWarehouseVisualData(BPK) equivalente ---")
  const { data: bpkLocations } = await db.schema('logistica').from('locations').select('*').eq('company_id', companyId).eq('warehouse_id', bpkWarehouse.id)
  console.log("BPK locations.length:", bpkLocations?.length)

  console.log("\n--- getWarehouseVisualData(PRINCIPAL) equivalente ---")
  const { data: principalLocations } = await db.schema('logistica').from('locations').select('*').eq('company_id', companyId).eq('warehouse_id', principalWarehouse.id)
  console.log("PRINCIPAL locations.length:", principalLocations?.length)

  console.log("\n--- query SQL manual ---")
  console.log(`SELECT count(*) FROM logistica.locations WHERE company_id = '${companyId}' AND warehouse_id = '${bpkWarehouse.id}'`)
  console.log("Resultado real:", bpkLocations?.length)
}

run().catch(console.error)
