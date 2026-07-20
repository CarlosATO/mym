import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  try {
    const { data, error } = await (supabase as any)
      .schema('logistica')
      .rpc('preview_next_route_candidates', {
        p_company_id: 'd1000000-0000-0000-0000-000000000001'
      })
    
    console.log('Result:', JSON.stringify({ data, error }, null, 2))
  } catch (err: any) {
    console.log('Exception caught:', err.message)
  }
}

run()
