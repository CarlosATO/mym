const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: 'logistica' } }
);

async function validate() {
  console.log('--- Validating cards count ---');
  let { count } = await supabase.from('sales_order_preparation_cards').select('id', { count: 'exact', head: true });
  console.log('Cards count:', count);

  console.log('\n--- Validating dispatch_cities ---');
  let { data: cities } = await supabase.from('dispatch_cities').select('id, name, company_id');
  console.log('Total dispatch_cities:', cities ? cities.length : 0);
  console.log('Main cities sample:', cities ? cities.slice(0, 5).map(c => c.name).join(', ') : 'none');

  let defaultCompany = cities && cities.length > 0 ? cities[0].company_id : null;

  console.log('\n--- Validating aliases ---');
  let { data: aliases } = await supabase.from('city_aliases').select('raw_city, normalized_city, city_id').not('city_id', 'is', null);
  console.log('Aliases with city_id:', aliases);

  if (defaultCompany) {
    console.log('\n--- Testing normalize_city ---');
    const testCities = ['CHILLAN', 'LOS ANEGELES', 'SAN FERNADO', 'STGO', 'TALCA', null];
    for (let c of testCities) {
      let { data, error } = await supabase.rpc('normalize_city', { p_company_id: defaultCompany, p_raw_city: c });
      if (error) console.log('Error:', error);
      console.log('normalize_city(', c, ') ->', data);
    }
  } else {
      console.log("No defaultCompany found!");
  }
}
validate();
