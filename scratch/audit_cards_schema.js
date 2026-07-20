require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function auditCards() {
  const { data: d, error: e } = await s
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('*')
    .limit(1);

  if (e) {
    console.error(e);
  } else {
    console.log('Columns of logistica.sales_order_preparation_cards:');
    if (d && d.length > 0) {
      console.log(Object.keys(d[0]));
    } else {
      console.log("No data found, but checking if we can use the rest endpoint metadata or just look at migration file.");
    }
  }
}
auditCards();
