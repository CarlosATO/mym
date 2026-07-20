require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'integraciones' } });
async function run() {
  const { data: det } = await s.from('bsale_document_details').select('quantity, net_unit_value, total_unit_value, net_amount, tax_amount, total_amount, net_discount').limit(1);
  console.log('details:', det);

  const { data: doc } = await s.from('bsale_documents').select('net_amount, tax_amount, total_amount').limit(1);
  console.log('documents:', doc);
}
run();
