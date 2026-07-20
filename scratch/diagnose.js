require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });

// Simulate logistica.clean_city_name
function cleanCity(c) {
  if (!c) return 'DESCONOCIDO';
  return c.trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

async function run() {
  const { data, error } = await s
    .from('vw_bsale_sales_orders_for_preparation')
    .select('route_location_raw, nv_folio')
    .gte('nv_emission_date', '2026-07-14');
  
  if (error) return console.log('Error:', error);
  
  const map = {};
  for(let row of data) {
    const norm = cleanCity(row.route_location_raw);
    map[norm] = (map[norm] || 0) + 1;
  }
  const sorted = Object.entries(map).sort((a,b) => b[1] - a[1]).slice(0, 10);
  console.log('Top comunas desde 2026-07-14:', sorted);
}
run();
