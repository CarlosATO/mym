const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  console.log("--- Validación de Referencias y Cantidad Logística (Fase 2I) ---");
  
  const { data: ncs, error } = await iDb.from('vw_bsale_sales_logistic_valid')
    .select('*')
    .eq('variant_code', '1020')
    .eq('document_type_id', 2)
    .gte('emission_date', '2026-06-12')
    .lte('emission_date', '2026-06-18');
    
  if (error) {
    console.error("Error fetching ncs:", error);
    return;
  }
  
  console.log("\n| folio | raw_quantity | financial_net_quantity | logistic_net_quantity | reference_code | needs_review |");
  console.log("|---|---|---|---|---|---|");
  ncs.forEach(nc => {
    console.log(`| ${nc.document_number} | ${nc.raw_quantity} | ${nc.financial_net_quantity} | ${nc.logistic_net_quantity} | ${nc.reference_code || 'N/A'} | ${nc.needs_review} |`);
  });

  // Fetch block total
  const { data: block } = await iDb.from('vw_bsale_sales_logistic_valid')
    .select('*')
    .eq('variant_code', '1020')
    .gte('emission_date', '2026-06-12')
    .lte('emission_date', '2026-06-18');

  let facturas = 0;
  let ncLogistica = 0;
  let totalLogistic = 0;

  block.forEach(d => {
    if (d.document_type_id === 1 || d.document_type_id === 5) facturas += Number(d.raw_quantity);
    if (d.document_type_id === 2) ncLogistica += Number(d.logistic_net_quantity);
    totalLogistic += Number(d.logistic_net_quantity);
  });

  console.log("\n--- Bloque 12/06 al 18/06 SKU 1020 ---");
  console.log(`Facturas/Boletas: ${facturas}`);
  console.log(`NC logística: ${ncLogistica}`);
  console.log(`logistic_net_quantity total: ${totalLogistic}`);
}

main().catch(console.error);
