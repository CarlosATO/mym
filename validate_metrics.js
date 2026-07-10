const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env.local'));
for (const k in envConfig) process.env[k] = envConfig[k];

const iDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'integraciones' },
});

async function main() {
  console.log("--- Validación de Métricas Corregidas (Fase 2E) ---");
  
  const { data: details, error } = await iDb.from('vw_bsale_document_details_normalized')
    .select('*')
    .eq('variant_code', '1020')
    .gte('emission_date', '2026-06-12')
    .lte('emission_date', '2026-07-09');
    
  if (error) {
    console.error("Error fetching details:", error);
    return;
  }
  
  const buckets = [
    { label: '12/06 al 18/06', expected: 155, start: new Date('2026-06-12T00:00:00'), end: new Date('2026-06-19T00:00:00') },
    { label: '19/06 al 25/06', expected: 3, start: new Date('2026-06-19T00:00:00'), end: new Date('2026-06-26T00:00:00') },
    { label: '26/06 al 02/07', expected: 120, start: new Date('2026-06-26T00:00:00'), end: new Date('2026-07-03T00:00:00') },
    { label: '03/07 al 09/07', expected: 63, start: new Date('2026-07-03T00:00:00'), end: new Date('2026-07-10T00:00:00') },
  ];
  
  // Initialize bucket metrics
  buckets.forEach(b => {
    b.bruto = 0; // FE + Boleta (raw)
    b.nc_raw = 0; // NC (raw)
    b.neto = 0; // Neto corregido
    b.notaVenta = 0;
    b.guia = 0;
  });

  const docTypes = {};

  details.forEach(d => {
    const emission = new Date(d.emission_date + 'T00:00:00');
    const b = buckets.find(b => emission >= b.start && emission < b.end);
    if (!b) return; 
    
    const rawQty = Number(d.raw_quantity);
    const netQty = Number(d.net_quantity);
    const typeId = d.document_type_id;
    
    // Accumulate for document type breakdown
    if (!docTypes[typeId]) {
      docTypes[typeId] = {
        nombre: d.document_type_name,
        sign_for_sales: d.sign_for_sales,
        raw_quantity_sum: 0,
        net_quantity_sum: 0,
        include_in_replenishment: d.include_in_replenishment
      };
    }
    docTypes[typeId].raw_quantity_sum += rawQty;
    docTypes[typeId].net_quantity_sum += netQty;
    
    if (typeId === 1 || typeId === 5) b.bruto += rawQty;
    if (typeId === 2) b.nc_raw += rawQty;
    if (typeId === 23) b.notaVenta += netQty; // should be 0 because sign=0
    if (typeId === 7) b.guia += netQty; // should be 0 because sign=0
    
    if (d.include_in_replenishment) {
      b.neto += netQty;
    }
  });
  
  console.log("\n| Bloque | Bsale esperado Carlos | Factura+Boleta raw | NC raw | Neto corregido | Nota Venta excluida | Guía excluida | Diff neto corregido vs Bsale |");
  console.log("|---|---|---|---|---|---|---|---|");
  
  buckets.forEach(b => {
    const diffNeto = b.neto - b.expected;
    console.log(`| ${b.label} | ${b.expected} | ${b.bruto} | ${b.nc_raw} | ${b.neto} | ${b.notaVenta} | ${b.guia} | ${diffNeto} |`);
  });
  
  console.log("\n--- VALIDACIÓN POR TIPO DE DOCUMENTO ---");
  console.log("| document_type_id | nombre | sign_for_sales | raw_quantity_sum | net_quantity_sum | include_in_replenishment |");
  console.log("|---|---|---|---|---|---|");
  Object.keys(docTypes).sort().forEach(id => {
    const t = docTypes[id];
    console.log(`| ${id} | ${t.nombre} | ${t.sign_for_sales} | ${t.raw_quantity_sum} | ${t.net_quantity_sum} | ${t.include_in_replenishment} |`);
  });

}

main().catch(console.error);
