const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const folios = ['23032', '23039', '23071', '23072', '23096'];
  const { data } = await iDb.from('bsale_documents')
    .select('bsale_id, number, emission_date, document_type_id')
    .in('number', folios);
  console.log("Documents in DB:", data);
  
  const { data: bsaleData } = await iDb.from('vw_bsale_document_details_normalized')
    .select('*')
    .in('document_number', folios);
  console.log("Details normalized in DB:", bsaleData);
}

main().catch(console.error);
