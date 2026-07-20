require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkCityId() {
  const { data, error } = await s
    .schema('integraciones')
    .from('vw_bsale_sales_orders_for_preparation')
    .select('*')
    .limit(1);

  if (error) console.error(error);
  else {
    console.log("Columns in vw_bsale_sales_orders_for_preparation:");
    if (data && data.length > 0) console.log(Object.keys(data[0]));
    else console.log("Empty view");
  }
}
checkCityId();
