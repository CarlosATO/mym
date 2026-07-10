const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  const { data, error } = await iDb.from('bsale_document_details').select('*').limit(1);
  if (error) console.error(error);
  else console.log(Object.keys(data[0]));
}
main();
