const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data, error } = await iDb.rpc('execute_sql', { query: "SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'integraciones' AND conrelid::regclass::text IN ('bsale_documents', 'bsale_document_details');" });
  if (error) {
    console.error("Direct RPC failed:", error.message);
    console.log("Will fetch table schema via information_schema...");
    const { data: cols } = await iDb.from('information_schema.table_constraints').select('*').eq('table_schema', 'integraciones');
    console.log(cols);
  } else {
    console.log(data);
  }
}
main();
