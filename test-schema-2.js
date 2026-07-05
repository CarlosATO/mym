import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

async function run() {
  console.log("== route_settlement_items ==")
  const { data: si } = await supabase.from('route_settlement_items').select('*').limit(1)
  console.log(si ? Object.keys(si[0] || {}) : "Empty")
  
  console.log("\n== route_fund_closures ==")
  const { data: fc } = await supabase.from('route_fund_closures').select('*').limit(1)
  console.log(fc ? Object.keys(fc[0] || {}) : "Empty")

  console.log("\n== route_fund_closure_items ==")
  const { data: fci } = await supabase.from('route_fund_closure_items').select('*').limit(1)
  console.log(fci ? Object.keys(fci[0] || {}) : "Empty")
}

run()
