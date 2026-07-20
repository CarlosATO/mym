require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await s.schema('logistica').rpc('execute_sql', { 
    query: `SELECT c.rut, c.phone, c.email FROM integraciones.vw_bsale_sales_orders_for_preparation v LEFT JOIN integraciones.bsale_clients c ON c.id = v.client_id WHERE v.nv_folio = '3496' LIMIT 1` 
  });
  if (error) console.error(error);
  console.log(JSON.stringify(data, null, 2));
}
run();
