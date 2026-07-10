const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const iDb = createClient(supabaseUrl, serviceKey, {
  db: { schema: 'integraciones' },
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: types, error } = await iDb.from('bsale_document_types').select('*');
  if (error) {
    console.error("Error fetching doc types:", error.message);
  } else {
    console.log("bsale_document_types:");
    console.table(types);
  }
}
main();
