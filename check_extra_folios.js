const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data: details } = await iDb.from('vw_bsale_sales_logistic_valid')
    .select('document_number, logistic_net_quantity, document_type_name, emission_date, reference_code')
    .eq('variant_code', '1020')
    .gte('emission_date', '2026-07-03')
    .lte('emission_date', '2026-07-09');

  console.log("All docs for 1020 in week 03/07 to 09/07:");
  details.forEach(d => {
    console.log(`Folio: ${d.document_number}, Type: ${d.document_type_name}, Qty: ${d.logistic_net_quantity}, Date: ${d.emission_date}, Ref: ${d.reference_code}`);
  });
}

main().catch(console.error);
