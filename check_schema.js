const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data, error } = await iDb.rpc('execute_sql', { query: "SELECT column_name FROM information_schema.columns WHERE table_schema = 'integraciones' AND table_name = 'bsale_document_references';" });
  if (error) console.error("Error executing SQL:", error);
  else console.log(data);
}

main().catch(console.error);
