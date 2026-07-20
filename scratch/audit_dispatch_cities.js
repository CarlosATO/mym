require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data } = await s.rpc('execute_sql', { query: `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'logistica'
      AND table_name = 'dispatch_cities'
    ORDER BY ordinal_position;
  ` });
  console.log("Since execute_sql doesn't exist, we fallback to just reading data keys again:");
  const { data: d } = await s.schema('logistica').from('dispatch_cities').select('*').limit(1);
  if(d) console.log(Object.keys(d[0]));
}
check();
