const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data } = await iDb.from('bsale_document_references').select('*').order('created_at', { ascending: false });
  console.log(`Total references in DB: ${data.length}`);
  if (data.length > 3) {
    console.log(data.slice(0, 5));
  }
}

main().catch(console.error);
