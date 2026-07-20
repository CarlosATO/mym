require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkDates() {
  const { data, error } = await supabase.from('bsale_sales_orders').select('bsale_id, folio, emission_date, generation_date, created_at, raw_json').limit(5).order('created_at', { ascending: false });
  if (error) {
    console.error("Error from bsale_sales_orders:", error);
  } else {
    console.log("Checking integraciones.bsale_sales_orders:");
    data.forEach(d => {
      console.log(`ID: ${d.bsale_id}, Folio: ${d.folio}`);
      console.log(`  emission_date: ${d.emission_date}`);
      console.log(`  generation_date: ${d.generation_date}`);
      console.log(`  created_at: ${d.created_at}`);
      // Parse timestamp if generation_date is epoch
      if (d.generation_date) {
        const d_gen = new Date(d.generation_date * 1000);
        console.log(`  generation_date parsed (local JS): ${d_gen.toLocaleString()}`);
      }
      if (d.raw_json) {
         console.log(`  raw_json dates: generationDate=${d.raw_json.generationDate}, emissionDate=${d.raw_json.emissionDate}`);
      }
    });
  }
}

checkDates();
