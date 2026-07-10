const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data: doc } = await iDb.from('bsale_documents').select('raw_json').eq('number', 4202).eq('document_type_id', 2).single();
  console.log("Raw JSON for 4202:", JSON.stringify(doc.raw_json, null, 2));
}

main().catch(console.error);
