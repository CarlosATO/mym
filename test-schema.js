import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

async function run() {
  const { data, error } = await supabase.from('route_fund_closures').select('*').limit(1)
  console.log('Sample row:', data, error)
  
  // also check if route_fund_closure_counters exists
  const { data: cData, error: cErr } = await supabase.from('route_fund_closure_counters').select('*').limit(1)
  console.log('Counters table:', cData, cErr)
}

run()
