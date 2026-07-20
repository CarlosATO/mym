const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'logistica' } });

const companyId = 'd1000000-0000-0000-0000-000000000001';

async function preview(f, t) {
  const { data, error } = await supabase.rpc('preview_sales_order_preparation_candidates', { p_company_id: companyId, p_from_date: f, p_to_date: t });
  if (error) console.error(error);
  else console.log(`[${f} to ${t}]`, data[0]);
}

async function run() {
  await preview('2026-07-12', '2026-07-12');
  await preview('2026-07-12', '2026-07-13');
  await preview('2026-07-07', '2026-07-13');
  
  const t1 = await supabase.from('sales_order_preparation_cards').select('id', { count: 'exact', head: true });
  console.log('Cards count check:', t1.count);
}
run();
