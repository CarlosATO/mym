require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'adquisiciones' }
});
const portalClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'portal' }
});

async function run() {
  const tables = [
    'route_fund_closures',
    'route_fund_closure_items',
    'route_fund_closure_expenses',
    'route_fund_closure_expense_allocations',
    'route_fund_closure_deposits',
    'route_fund_closure_attachments'
  ];

  console.log("--- CHEQUEO DE TABLAS NUEVAS ---");
  for (const table of tables) {
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    if (error) {
      console.log(`- ${table}: ERROR: ${error.message}`);
    } else {
      console.log(`- ${table}: ${count} registros (creada exitosamente)`);
    }
  }

  console.log("\n--- CHEQUEO DE PERMISOS ---");
  const { data: perms, error: permError } = await portalClient.from('permissions').select('code').like('code', 'adquisiciones.route_fund_closures.%');
  if (permError) {
    console.log("Error consultando permisos:", permError.message);
  } else {
    perms.forEach(p => console.log(`- Permiso encontrado: ${p.code}`));
  }
}

run();
