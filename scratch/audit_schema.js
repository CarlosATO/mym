require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function audit() {
  const { data: d1, error: e1 } = await s.rpc('execute_sql', { query: `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'logistica'
      AND table_name = 'dispatch_calendar_cities'
    ORDER BY ordinal_position;
  `});

  if (e1) {
    console.log("No execute_sql rpc available. Let's do it using raw pg connection or alternative way...");
    // Just fetch it via REST using a clever trick: we can query an existing view or use supabase meta endpoints, but actually we can query it via edge function or direct node pg connection if we have it.
    // Wait, let's just write a script with pg library if available.
  } else {
    console.log("dispatch_calendar_cities columns:");
    console.log(d1);
  }
}
audit();
