require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function audit() {
  // Use the view to get all the joined data (folio, seller, city, dates)
  const { data, error } = await s.rpc('execute_sql', { query: `
    SELECT 
      nv_bsale_id,
      nv_folio,
      nv_emission_date,
      nv_generation_date,
      nv_generation_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago' AS generation_date_chile,
      city_raw,
      seller_name
    FROM integraciones.vw_bsale_sales_orders_for_preparation
    ORDER BY nv_generation_date DESC
    LIMIT 5;
  `});
  if (error) {
    // execute_sql doesn't exist, we must use a view select instead
    const { data: vwData, error: vwErr } = await s
      .schema('integraciones')
      .from('vw_bsale_sales_orders_for_preparation')
      .select('nv_bsale_id, nv_folio, nv_emission_date, nv_generation_date, city_raw, seller_name')
      .order('nv_generation_date', { ascending: false })
      .limit(5);

    if (vwErr) return console.error(vwErr);
    
    console.log("5 NVs Audited:");
    vwData.forEach(d => {
      const genUtc = new Date(d.nv_generation_date);
      // To simulate America/Santiago conversion
      const chileStr = genUtc.toLocaleString("es-CL", { timeZone: "America/Santiago" });
      console.log(`- Folio: ${d.nv_folio} | ID: ${d.nv_bsale_id}`);
      console.log(`  Emission Date: ${d.nv_emission_date}`);
      console.log(`  Generation Date (UTC): ${d.nv_generation_date}`);
      console.log(`  Generation Date (Chile): ${chileStr}`);
      console.log(`  Comuna: ${d.city_raw}`);
      console.log(`  Vendedor: ${d.seller_name}`);
      console.log("---");
    });
  } else {
    console.log(data);
  }
}
audit();
