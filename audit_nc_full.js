const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data: docData } = await iDb.from('bsale_documents').select('raw_json').in('number', ['4147', '4149', '4153', '4166']).eq('document_type_id', 2);
  docData.forEach(d => {
    console.log(`\nDoc ${d.raw_json.number}:`);
    console.log(JSON.stringify(d.raw_json, null, 2));
  });
}

main().catch(console.error);
