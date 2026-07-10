const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  console.log("--- Validación de SKU 1020 en Bsale Mirror v1 ---");
  
  // 1. Total FE + Boleta - NC (desde la vista válida)
  const { data: totalValid, error } = await iDb.from('vw_bsale_sales_valid')
    .select('net_quantity')
    .eq('variant_code', '1020');
  
  if (error) {
    console.error("Error query 1:", error);
    return;
  }
  
  const totalNeto = totalValid.reduce((sum, row) => sum + Number(row.net_quantity), 0);
  console.log(`Total Neto (include_in_replenishment=true): ${totalNeto}`);

  // 2. Ventas netas por día
  const { data: dailySales, error: err2 } = await iDb.from('vw_bsale_sales_daily_sku')
    .select('emission_date, net_quantity, gross_quantity_positive, gross_quantity_negative')
    .eq('variant_code', '1020')
    .order('emission_date', { ascending: false });
  
  if (err2) {
    console.error("Error query 2:", err2);
    return;
  }
  
  console.log("\n--- Ventas Netas por Día (SKU 1020) ---");
  dailySales.forEach(d => console.log(`${d.emission_date}: Neto=${d.net_quantity} (Pos=${d.gross_quantity_positive}, Neg=${d.gross_quantity_negative})`));

  // 3. Desglose por tipo documento
  const { data: docTypes, error: err3 } = await iDb.from('vw_bsale_sales_by_doc_type_daily')
    .select('document_type_name, net_quantity, raw_quantity')
    .order('document_type_name');
  
  if (err3) {
    console.error("Error query 3:", err3);
    return;
  }
  
  // Aggregate since it's daily
  const aggregatedDocTypes = {};
  docTypes.forEach(d => {
    if(!aggregatedDocTypes[d.document_type_name]) aggregatedDocTypes[d.document_type_name] = { net: 0, raw: 0 };
    aggregatedDocTypes[d.document_type_name].net += Number(d.net_quantity);
    aggregatedDocTypes[d.document_type_name].raw += Number(d.raw_quantity);
  });
  
  console.log("\n--- Desglose por Tipo de Documento ---");
  for(const [name, stats] of Object.entries(aggregatedDocTypes)) {
    console.log(`${name}: Raw=${stats.raw}, Neto=${stats.net}`);
  }

  // 4. Ventas netas por bloque
  // Let's manually sum up the 4 weeks from daily summary
  const today = new Date('2026-07-09T00:00:00'); // the reference date from before
  const bucketSize = 7 * 86400000;
  const buckets = [
    { label: '12/06 al 18/06', start: new Date(today.getTime() - 28*86400000), end: new Date(today.getTime() - 21*86400000), total: 0 },
    { label: '19/06 al 25/06', start: new Date(today.getTime() - 21*86400000), end: new Date(today.getTime() - 14*86400000), total: 0 },
    { label: '26/06 al 02/07', start: new Date(today.getTime() - 14*86400000), end: new Date(today.getTime() - 7*86400000), total: 0 },
    { label: '03/07 al 09/07', start: new Date(today.getTime() - 7*86400000), end: today, total: 0 },
  ];

  dailySales.forEach(d => {
    const emission = new Date(d.emission_date + 'T00:00:00');
    for(const b of buckets) {
      if(emission >= b.start && emission < b.end) {
        b.total += Number(d.net_quantity);
      }
    }
  });

  console.log("\n--- Ventas Netas por Bloque ---");
  buckets.forEach(b => console.log(`${b.label}: ${b.total}`));

}

main().catch(console.error);
